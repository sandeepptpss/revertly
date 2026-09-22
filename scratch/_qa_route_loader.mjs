// ESM loader: transpiles .jsx on the fly AND swaps app/shopify.server.js for a
// test double, so route loaders/actions can run outside a Shopify request.
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";
import path from "node:path";

const STUB = pathToFileURL(path.resolve(import.meta.dirname, "_qa_shopify_stub.mjs")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("shopify.server.js") && !specifier.includes("_qa_")) {
    return { url: STUB, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file://") && url.endsWith(".jsx")) {
    const p = fileURLToPath(url);
    const source = await readFile(p, "utf8");
    const { code } = await transform(source, { loader: "jsx", format: "esm", target: "node22", sourcefile: p });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
