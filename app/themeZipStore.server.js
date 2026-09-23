import fs from "node:fs";
import path from "node:path";

/**
 * On-disk staging area for the theme ZIPs Shopify downloads when a restore
 * creates a draft theme from `src`.
 *
 * The download URL cannot be behind the app session — the client is Shopify's
 * own fetcher, not the merchant's browser — so its only protection is the
 * unguessable token in the path. That makes it a capability URL, and a
 * capability that hands out a merchant's entire theme source must stop working
 * once it has done its job. Shopify pulls the archive within seconds of the
 * theme being created, so a short window costs nothing.
 */
export const THEME_ZIP_TTL_MS = 30 * 60 * 1000;

export function themeZipDir() {
  return path.resolve(process.cwd(), "scratch", "theme_zips");
}

export function themeZipPath(token) {
  return path.join(themeZipDir(), `${token}.zip`);
}

/** True once an archive is past its download window. */
export function isThemeZipExpired(mtimeMs, now = Date.now()) {
  return now - mtimeMs > THEME_ZIP_TTL_MS;
}

/** Removes archives past their TTL. Best-effort: never fails a request. */
export function pruneExpiredThemeZips(now = Date.now()) {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(themeZipDir())) {
      if (!name.endsWith(".zip")) continue;
      const full = path.join(themeZipDir(), name);
      try {
        if (isThemeZipExpired(fs.statSync(full).mtimeMs, now)) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch {
        // A file that vanished underneath us needs no further action.
      }
    }
  } catch {
    // No directory yet — nothing to prune.
  }
  return removed;
}
