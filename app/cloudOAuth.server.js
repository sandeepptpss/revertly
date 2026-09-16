/**
 * Signed OAuth state and token exchange for cloud storage providers.
 *
 * The OAuth callback arrives from the provider, not from Shopify, so it carries
 * no Shopify session. The shop identity therefore has to travel in `state`, and
 * `state` has to be unforgeable — otherwise anyone could call the callback with
 * `state=victim-shop` and attach their own storage account to another merchant's
 * settings. We sign it with the app secret and bind it to a short expiry.
 */
import crypto from "node:crypto";
import { getProvider } from "./cloudSync.server.js";

const STATE_TTL_MS = 10 * 60 * 1000;

function signingKey() {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET is required to sign cloud OAuth state.");
  }
  return secret;
}

function sign(payloadB64) {
  return crypto.createHmac("sha256", signingKey()).update(payloadB64).digest("base64url");
}

/** Builds a tamper-proof state token binding this consent to one shop. */
export function createOAuthState(shop, providerId) {
  const payload = {
    shop,
    provider: providerId,
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + STATE_TTL_MS,
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

/**
 * Verifies a state token.
 * @returns {{shop: string, provider: string}} the verified payload
 * @throws if the signature, expiry, or provider binding does not check out
 */
export function verifyOAuthState(state, expectedProviderId) {
  if (!state || typeof state !== "string" || !state.includes(".")) {
    throw new Error("Missing or malformed OAuth state.");
  }
  const [b64, sig] = state.split(".");
  const expected = sign(b64);

  const a = Buffer.from(sig || "", "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("OAuth state signature is invalid.");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    throw new Error("OAuth state payload is unreadable.");
  }

  if (!payload.exp || Date.now() > payload.exp) {
    throw new Error("OAuth state has expired. Please start the connection again.");
  }
  if (payload.provider !== expectedProviderId) {
    throw new Error("OAuth state does not match the requested provider.");
  }
  if (!payload.shop) {
    throw new Error("OAuth state is missing the shop.");
  }

  return { shop: payload.shop, provider: payload.provider };
}

/** The redirect URI registered with the provider. Must match byte-for-byte. */
export function cloudCallbackUrl(providerId, overrideBase) {
  const isLocal = !overrideBase || overrideBase.includes("localhost") || overrideBase.includes("127.0.0.1");
  const base = (
    (!isLocal ? overrideBase : null) ||
    process.env.APP_URL ||
    process.env.HOST ||
    process.env.SHOPIFY_APP_URL ||
    overrideBase ||
    ""
  ).replace(/\/$/, "");
  return `${base}/auth/cloud/${providerId.toLowerCase()}/callback`;
}

const LAUNCH_TTL_MS = 5 * 60 * 1000;

/**
 * Creates a tamper-proof short-lived launch token to safely bridge an authenticated
 * merchant session from inside the iframe to an external top-level OAuth redirect.
 */
export function createLaunchToken(shop, providerId) {
  const payload = {
    shop,
    provider: providerId,
    nonce: crypto.randomBytes(16).toString("hex"),
    exp: Date.now() + LAUNCH_TTL_MS,
    purpose: "cloud_launch",
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${b64}.${sign(b64)}`;
}

/**
 * Verifies a launch token.
 */
export function verifyLaunchToken(token, expectedProviderId) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
    throw new Error("Missing or malformed launch token.");
  }
  const [b64, sig] = token.split(".");
  const expected = sign(b64);

  const a = Buffer.from(sig || "", "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Launch token signature is invalid.");
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    throw new Error("Launch token payload is unreadable.");
  }

  if (payload.purpose !== "cloud_launch") {
    throw new Error("Invalid launch token purpose.");
  }
  if (!payload.exp || Date.now() > payload.exp) {
    throw new Error("Connection session expired. Please click Connect again from Settings.");
  }
  if (expectedProviderId && payload.provider !== expectedProviderId) {
    throw new Error("Launch token does not match the requested provider.");
  }
  if (!payload.shop) {
    throw new Error("Launch token is missing the shop domain.");
  }

  return { shop: payload.shop, provider: payload.provider };
}

/**
 * Builds the complete OAuth consent URL for Google Drive or Dropbox.
 */
export function buildAuthorizeUrl(shop, providerId, baseUrl) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const state = createOAuthState(shop, provider.id);
  const redirectUri = cloudCallbackUrl(provider.id, baseUrl);

  const url = new URL(provider.authorizeUrl);
  url.searchParams.set("client_id", process.env[provider.clientIdEnv] || "");
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

  return url.toString();
}

/**
 * Exchanges an authorization code for access + refresh tokens.
 */
export async function exchangeCodeForTokens(providerId, code) {
  const provider = getProvider(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const body = new URLSearchParams({
    code,
    client_id: process.env[provider.clientIdEnv] || "",
    client_secret: process.env[provider.clientSecretEnv] || "",
    redirect_uri: cloudCallbackUrl(provider.id),
    grant_type: "authorization_code",
  });

  const resp = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${provider.label} token exchange failed (${resp.status}): ${text}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${provider.label} returned an unreadable token response.`);
  }

  if (!data.access_token) {
    throw new Error(`${provider.label} did not return an access token.`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
  };
}

/**
 * Reads the connected account's identity so the UI can show the real account,
 * rather than a placeholder derived from the shop domain.
 */
export async function fetchAccountEmail(providerId, accessToken) {
  try {
    if (providerId === "GOOGLE_DRIVE") {
      const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=user", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.user?.emailAddress || null;
    }

    if (providerId === "DROPBOX") {
      const r = await fetch("https://api.dropboxapi.com/2/users/get_current_account", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return null;
      const j = await r.json();
      return j.email || null;
    }
  } catch (err) {
    console.warn(`[Cloud OAuth] Could not read account identity: ${err?.message}`);
  }
  return null;
}
