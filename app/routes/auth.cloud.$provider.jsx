/**
 * Starts the Google Drive / Dropbox OAuth consent flow for the current shop.
 *
 * The `state` parameter is an HMAC over the shop plus a nonce and expiry, keyed
 * with the app secret. The callback verifies it before writing any tokens, so a
 * third party cannot forge a callback or replay one shop's consent onto another
 * shop's settings.
 */
import { redirect } from "react-router";
import { authenticate } from "../shopify.server.js";
import {
  getProvider,
  isProviderConfigured,
  checkCloudSyncAccess,
  CLOUD_SYNC_UPGRADE_MESSAGE,
} from "../cloudSync.server.js";
import { buildAuthorizeUrl, verifyLaunchToken } from "../cloudOAuth.server.js";

export const loader = async ({ request, params }) => {
  const provider = getProvider(params.provider);
  if (!provider) {
    return redirect(`/app/settings?cloud_error=${encodeURIComponent("Unknown cloud provider.")}`);
  }

  if (!isProviderConfigured(provider.id)) {
    const msg = `${provider.label} is not configured on this server. Set ${provider.clientIdEnv} and ${provider.clientSecretEnv}.`;
    return redirect(`/app/settings?cloud_error=${encodeURIComponent(msg)}`);
  }

  const url = new URL(request.url);
  const launchToken = url.searchParams.get("token");

  let shop;
  if (launchToken) {
    try {
      ({ shop } = verifyLaunchToken(launchToken, provider.id));
    } catch (err) {
      console.warn(`[Cloud OAuth] Invalid launch token: ${err?.message}`);
      return redirect(`/app/settings?cloud_error=${encodeURIComponent(err?.message || "Invalid connection token.")}`);
    }
  } else {
    // Fallback for direct authenticated session requests
    try {
      const { session } = await authenticate.admin(request);
      shop = session?.shop;
    } catch (authErr) {
      const shopParam = url.searchParams.get("shop");
      if (shopParam) {
        throw authErr;
      }
      return redirect(`/app/settings?cloud_error=${encodeURIComponent("Please connect your cloud storage from the Settings page.")}`);
    }
  }

  if (!shop) {
    return redirect(`/app/settings?cloud_error=${encodeURIComponent("Could not identify the store for this cloud connection.")}`);
  }

  // Checked after the shop is resolved and before the redirect out to the
  // provider: a merchant must never be walked through a Google/Dropbox consent
  // screen for a connection their plan cannot keep.
  const cloudAccess = await checkCloudSyncAccess(shop);
  if (!cloudAccess.allowed) {
    return redirect(`/app/settings?cloud_error=${encodeURIComponent(CLOUD_SYNC_UPGRADE_MESSAGE)}`);
  }

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto") || "https";
  const publicBase = forwardedHost
    ? `${forwardedProto}://${forwardedHost}`
    : process.env.APP_URL || process.env.HOST || process.env.SHOPIFY_APP_URL;

  const authUrl = buildAuthorizeUrl(shop, provider.id, publicBase);
  return redirect(authUrl);
};
