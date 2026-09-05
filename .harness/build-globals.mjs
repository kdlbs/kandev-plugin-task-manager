import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
const harnessDir = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(harnessDir, "globals.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: resolve(harnessDir, "globals.bundle.js"),
});
