// ESM loader: lets route components under app/routes/ be rendered in Node.
//  - "react-router" imported by a route resolves to the hook stub
//    (_qa_react_router_stub.mjs);
//  - extensionless relative imports ("../db.server") get ".js", as Vite allows;
//  - .jsx is transpiled with the automatic runtime, as Vite does, because the
//    route files do not import React for classic createElement calls.
// Register it after _qa_route_loader.mjs (which swaps shopify.server.js); the
// later registration runs first, so this load hook wins for .jsx.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { transform } from "esbuild";

const STUB = pathToFileURL(path.resolve(import.meta.dirname, "_qa_react_router_stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react-router" && context.parentURL?.includes("/app/routes/")) {
    return { url: STUB, format: "module", shortCircuit: true };
  }
  // Some app modules import "../db.server" with no extension, which Vite
  // resolves and Node does not.
  if (specifier.startsWith(".") && !/\.(m?js|jsx|json)$/.test(specifier) && context.parentURL?.includes("/app/")) {
    return nextResolve(`${specifier}.js`, context);
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file://") && url.endsWith(".jsx")) {
    const p = fileURLToPath(url);
    const source = await readFile(p, "utf8");
    const { code } = await transform(source, {
      loader: "jsx",
      jsx: "automatic",
      format: "esm",
      target: "node22",
      sourcefile: p,
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
