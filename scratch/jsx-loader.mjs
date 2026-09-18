// Node cannot import .jsx directly. Route modules under app/routes are .jsx,
// so any suite that exercises a real loader/action needs them transpiled on
// the fly. Used via: node --import ./scratch/jsx-register.mjs <suite>.mjs
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";

export async function load(url, context, nextLoad) {
  if (url.startsWith("file://") && url.endsWith(".jsx")) {
    const path = fileURLToPath(url);
    const source = await readFile(path, "utf8");
    const { code } = await transform(source, {
      loader: "jsx",
      format: "esm",
      target: "node22",
      sourcefile: path,
    });
    return { format: "module", source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
