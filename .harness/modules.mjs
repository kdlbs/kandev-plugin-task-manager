import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const harnessDir = dirname(fileURLToPath(import.meta.url));
const repositoryDir = resolve(harnessDir, "..");

const searchPaths = [
  resolve(harnessDir, "node_modules"),
  resolve(repositoryDir, "node_modules"),
  resolve(repositoryDir, "../kandev/apps"),
  resolve(repositoryDir, "../kdlbs-kandev/apps"),
];

function packagePath(name, override) {
  const candidates = override ? [override] : searchPaths;
  for (const path of candidates) {
    try {
      return require.resolve(name, { paths: [path] });
    } catch (_error) {
      // Try the next repository-local installation.
    }
  }
  throw new Error(
    `${name} is not installed. Run the harness dependency install described in .harness/README.md`,
  );
}

export async function loadPlaywright() {
  const path = packagePath("@playwright/test", process.env.PLAYWRIGHT_MODULE);
  const esmPath = path.endsWith("/index.js") ? path.slice(0, -"index.js".length) + "index.mjs" : path;
  return import(pathToFileURL(esmPath).href);
}

export function resolveEsbuild() {
  return packagePath("esbuild", process.env.ESBUILD_MODULE);
}
