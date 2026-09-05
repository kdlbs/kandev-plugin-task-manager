import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEsbuild } from "./modules.mjs";

const { build } = await import(resolveEsbuild());
const harnessDir = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(harnessDir, "globals.js")],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: resolve(harnessDir, "globals.bundle.js"),
  sourcemap: false,
});

