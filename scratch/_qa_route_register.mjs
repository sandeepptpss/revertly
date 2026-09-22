import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./_qa_route_loader.mjs", pathToFileURL(import.meta.filename));
