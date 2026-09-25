import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./_qa_route_loader.mjs", pathToFileURL(import.meta.filename));
register("./_qa_admin_render_loader.mjs", pathToFileURL(import.meta.filename));
