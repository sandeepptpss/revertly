import fs from "node:fs";
import {
  isThemeZipExpired,
  pruneExpiredThemeZips,
  themeZipPath,
} from "../themeZipStore.server.js";

/**
 * Serves the theme ZIP that Shopify downloads when a restore creates a draft
 * staging theme from `src`. See `themeZipStore.server.js` for why this endpoint
 * is a capability URL rather than a session-authenticated route, and why the
 * archive it serves expires.
 */
export const loader = async ({ params }) => {
  const token = params.token?.replace(/\.zip$/, "");
  if (!token || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Response("Invalid Token", { status: 400 });
  }

  pruneExpiredThemeZips();

  const zipPath = themeZipPath(token);
  let stat;
  try {
    stat = fs.statSync(zipPath);
  } catch {
    throw new Response("Theme download expired or not found", { status: 404 });
  }

  if (isThemeZipExpired(stat.mtimeMs)) {
    try {
      fs.unlinkSync(zipPath);
    } catch {
      // Already gone; the 404 below is still the right answer.
    }
    throw new Response("Theme download expired or not found", { status: 404 });
  }

  const buf = fs.readFileSync(zipPath);
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename="theme-${token}.zip"`,
      // Theme source is merchant data: never let a shared cache keep a copy.
      "Cache-Control": "private, no-store",
    },
  });
};
