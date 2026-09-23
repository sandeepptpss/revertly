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
import { encrypt } from "../crypto.server.js";

const returnToShopifyAdmin = (shop, params) => {
  const query = new URLSearchParams(params).toString();
  if (shop && typeof shop === "string") {
    const cleanShop = shop.replace(".myshopify.com", "").trim();
    // Validate store domain format before constructing Shopify Admin redirect URL
    if (/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(cleanShop)) {
      const apiKey = process.env.SHOPIFY_API_KEY || "1aa2f8043b53bd114b8814fc368663fd";
      return redirect(`https://admin.shopify.com/store/${cleanShop}/apps/${apiKey}/app/settings?${query}`);
    }
  }
  return redirect(`/app/settings?${query}`);
};

function extractShopFromState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  try {
    const [b64] = state.split(".");
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    return payload.shop || null;
  } catch {
    return null;
  }
}

export const loader = async ({ request, params }) => {
  const provider = getProvider(params.provider);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const providerError = url.searchParams.get("error");
  const fallbackShop = extractShopFromState(state);

  if (!provider) {
    return returnToShopifyAdmin(fallbackShop, { cloud_error: "Unknown cloud provider." });
  }
  if (!isProviderConfigured(provider.id)) {
    return returnToShopifyAdmin(fallbackShop, { cloud_error: `${provider.label} is not configured on this server.` });
  }

  if (providerError) {
    return returnToShopifyAdmin(fallbackShop, {
      cloud_error: `${provider.label} authorization was declined (${providerError}).`,
    });
  }
  if (!code) {
    return returnToShopifyAdmin(fallbackShop, { cloud_error: "Authorization code missing from callback." });
  }

  let shop;
  try {
    ({ shop } = verifyOAuthState(state, provider.id));
  } catch (err) {
    console.warn(`[Cloud OAuth] Rejected callback: ${err?.message}`);
    return returnToShopifyAdmin(fallbackShop, { cloud_error: err?.message || "Invalid OAuth state." });
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
        cloudSyncAccessToken: encrypt(tokens.accessToken),
        cloudSyncRefreshToken: encrypt(tokens.refreshToken),
        cloudSyncTokenExpiry: tokens.expiresAt,
      },
      update: {
        cloudSyncProvider: provider.id,
        cloudSyncEmail: email,
        cloudSyncConnected: true,
        cloudSyncAccessToken: encrypt(tokens.accessToken),
        // Providers omit refresh_token on re-consent; keep the stored one.
        ...(tokens.refreshToken ? { cloudSyncRefreshToken: encrypt(tokens.refreshToken) } : {}),
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

    return returnToShopifyAdmin(shop, {
      cloud_connected: provider.id,
      ...(tokens.refreshToken ? {} : { cloud_warning: "no_refresh_token" }),
    });
  } catch (err) {
    console.error("[Cloud OAuth] Token exchange failed:", err?.message);
    return returnToShopifyAdmin(shop || fallbackShop, {
      cloud_error: err?.message || "Could not complete authorization.",
    });
  }
};
