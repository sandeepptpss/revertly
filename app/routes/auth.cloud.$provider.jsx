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
import { getProvider, isProviderConfigured } from "../cloudSync.server.js";
import { createOAuthState, cloudCallbackUrl } from "../cloudOAuth.server.js";

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const provider = getProvider(params.provider);
  if (!provider) {
    return redirect(`/app/settings?cloud_error=${encodeURIComponent("Unknown cloud provider.")}`);
  }

  if (!isProviderConfigured(provider.id)) {
    const msg = `${provider.label} is not configured on this server. Set ${provider.clientIdEnv} and ${provider.clientSecretEnv}.`;
    return redirect(`/app/settings?cloud_error=${encodeURIComponent(msg)}`);
  }

  const state = createOAuthState(shop, provider.id);
  const redirectUri = cloudCallbackUrl(provider.id);

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", process.env[provider.clientIdEnv]);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);

  if (provider.id === "GOOGLE_DRIVE") {
    url.searchParams.set("scope", provider.scope);
    // Without both of these Google returns no refresh token on repeat consents,
    // which would silently break sync as soon as the access token expires.
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
  } else {
    url.searchParams.set("token_access_type", "offline");
    url.searchParams.set("scope", provider.scope);
  }

  return redirect(url.toString());
};
