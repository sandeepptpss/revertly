import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./jsx-loader.mjs", pathToFileURL(import.meta.filename));
