/**
 * Theme App Embed detection.
 *
 * Reports whether the merchant has switched Revertly's app embed ON in their
 * live theme. Three things matter here and each was previously wrong:
 *
 *  1. It uses the GraphQL Admin API at the app's configured version, not a
 *     hardcoded REST version string. The REST Theme/Asset endpoints are legacy
 *     and the old code pinned "2026-01" while the rest of the app ran on a
 *     different version entirely.
 *  2. It distinguishes "embed is off" from "we could not find out". A network
 *     blip used to be reported to the merchant as "Action Required", telling a
 *     correctly configured store to go and re-do setup it had already done.
 *  3. It caches per shop, because this runs on every Settings page load and
 *     each call costs Shopify API rate limit.
 */

import { EMBED_ACTIVE, EMBED_INACTIVE, EMBED_UNKNOWN } from "./monitoring.constants.js";

const CACHE_TTL_MS = 60 * 1000;

/** @type {Map<string, { expiresAt: number, value: object }>} */
const cache = new Map();

// The block file is extensions/revertly-theme-extension/blocks/revertly_embed.liquid,
// so a placed block's type looks like:
//   shopify://apps/<handle>/blocks/revertly_embed/<extension-uuid>
const EMBED_BLOCK_TYPE = "revertly_embed";

export function clearThemeEmbedCache(shop) {
  if (shop) cache.delete(shop);
  else cache.clear();
}

/**
 * @returns {Promise<{ status: string, themeName: string|null, error: string|null }>}
 */
export async function getThemeEmbedStatus(admin, shop) {
  const cached = cache.get(shop);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const result = await probeThemeEmbed(admin);

  // Only cache determinate answers. Caching UNKNOWN would extend a transient
  // outage into a minute of misleading UI.
  if (result.status !== EMBED_UNKNOWN) {
    cache.set(shop, { expiresAt: Date.now() + CACHE_TTL_MS, value: result });
  }
  return result;
}

async function probeThemeEmbed(admin) {
  if (!admin) {
    return { status: EMBED_UNKNOWN, themeName: null, error: "No admin API client available" };
  }

  try {
    const res = await admin.graphql(
      `#graphql
      query revertlyEmbedStatus {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            name
            files(first: 1, filenames: ["config/settings_data.json"]) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }`,
    );

    const json = await res.json();

    if (json.errors?.length) {
      return {
        status: EMBED_UNKNOWN,
        themeName: null,
        error: json.errors.map((e) => e.message).join("; "),
      };
    }

    const theme = json.data?.themes?.nodes?.[0];
    if (!theme) {
      return { status: EMBED_UNKNOWN, themeName: null, error: "No published theme found" };
    }

    const content = theme.files?.nodes?.[0]?.body?.content;
    if (!content) {
      // The theme exists but we couldn't read its settings — that is not the
      // same as the merchant having left the embed switched off.
      return {
        status: EMBED_UNKNOWN,
        themeName: theme.name || null,
        error: "Could not read config/settings_data.json",
      };
    }

    let blocks;
    try {
      blocks = JSON.parse(content)?.current?.blocks || {};
    } catch (parseErr) {
      return {
        status: EMBED_UNKNOWN,
        themeName: theme.name || null,
        error: `Malformed settings_data.json: ${parseErr.message}`,
      };
    }

    const active = Object.values(blocks).some(
      (block) => typeof block?.type === "string" && block.type.includes(EMBED_BLOCK_TYPE) && !block.disabled,
    );

    return {
      status: active ? EMBED_ACTIVE : EMBED_INACTIVE,
      themeName: theme.name || null,
      error: null,
    };
  } catch (err) {
    console.warn("[Revertly] Theme embed status check failed:", err?.message || err);
    return { status: EMBED_UNKNOWN, themeName: null, error: err?.message || String(err) };
  }
}
