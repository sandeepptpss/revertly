import fs from "node:fs";
import path from "node:path";

export const loader = async ({ params }) => {
  const token = params.token?.replace(/\.zip$/, "");
  if (!token || !/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Response("Invalid Token", { status: 400 });
  }

  const zipPath = path.resolve(process.cwd(), "scratch", "theme_zips", `${token}.zip`);
  if (!fs.existsSync(zipPath)) {
    throw new Response("Theme download expired or not found", { status: 404 });
  }

  const buf = fs.readFileSync(zipPath);
  return new Response(buf, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(buf.length),
      "Content-Disposition": `attachment; filename="theme-${token}.zip"`,
      "Cache-Control": "public, max-age=600",
    },
  });
};
