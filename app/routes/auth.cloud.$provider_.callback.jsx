/**
 * OAuth callback for cloud storage providers.
 *
 * This request comes from Google/Dropbox and carries no Shopify session, so the
 * shop is taken from the signed `state` and nowhere else. Never trust a shop
 * value supplied directly in the query string here.
 */
import { redirect } from "react-router";
import prisma from "../db.server.js";
import { getProvider, isProviderConfigured } from "../cloudSync.server.js";
import { verifyOAuthState, exchangeCodeForTokens, fetchAccountEmail } from "../cloudOAuth.server.js";

const settingsRedirect = (params) => redirect(`/app/settings?${new URLSearchParams(params)}`);

export const loader = async ({ request, params }) => {
  const provider = getProvider(params.provider);
  if (!provider) {
    return settingsRedirect({ cloud_error: "Unknown cloud provider." });
  }
  if (!isProviderConfigured(provider.id)) {
    return settingsRedirect({ cloud_error: `${provider.label} is not configured on this server.` });
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");

  if (providerError) {
    return settingsRedirect({
      cloud_error: `${provider.label} authorization was declined (${providerError}).`,
    });
  }
  if (!code) {
    return settingsRedirect({ cloud_error: "Authorization code missing from callback." });
  }

  let shop;
  try {
    ({ shop } = verifyOAuthState(state, provider.id));
  } catch (err) {
    console.warn(`[Cloud OAuth] Rejected callback: ${err?.message}`);
    return settingsRedirect({ cloud_error: err?.message || "Invalid OAuth state." });
  }

  try {
    const tokens = await exchangeCodeForTokens(provider.id, code);
    const email = await fetchAccountEmail(provider.id, tokens.accessToken);

    // A missing refresh token means sync dies silently in an hour. Surface it
    // now instead of letting the merchant discover it during an incident.
    if (!tokens.refreshToken) {
      console.warn(`[Cloud OAuth] ${provider.label} returned no refresh token for ${shop}.`);
    }

    await prisma.appSettings.upsert({
      where: { shop },
      create: {
        shop,
        cloudSyncProvider: provider.id,
        cloudSyncEmail: email,
        cloudSyncConnected: true,
        cloudSyncAccessToken: tokens.accessToken,
        cloudSyncRefreshToken: tokens.refreshToken,
        cloudSyncTokenExpiry: tokens.expiresAt,
      },
      update: {
        cloudSyncProvider: provider.id,
        cloudSyncEmail: email,
        cloudSyncConnected: true,
        cloudSyncAccessToken: tokens.accessToken,
        // Providers omit refresh_token on re-consent; keep the stored one.
        ...(tokens.refreshToken ? { cloudSyncRefreshToken: tokens.refreshToken } : {}),
        cloudSyncTokenExpiry: tokens.expiresAt,
      },
    });

    await prisma.auditLog
      .create({
        data: {
          shop,
          action: "CLOUD_SYNC_CONNECTED",
          resourceType: "AppSettings",
          resourceId: shop,
          details: { provider: provider.id, account: email, hasRefreshToken: Boolean(tokens.refreshToken) },
        },
      })
      .catch(() => {});

    return settingsRedirect({
      cloud_connected: provider.id,
      ...(tokens.refreshToken ? {} : { cloud_warning: "no_refresh_token" }),
    });
  } catch (err) {
    console.error("[Cloud OAuth] Token exchange failed:", err?.message);
    return settingsRedirect({ cloud_error: err?.message || "Could not complete authorization." });
  }
};
