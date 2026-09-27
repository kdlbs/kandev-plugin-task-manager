import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

export async function startStaticServer(rootDir) {
  const root = resolve(rootDir);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
      let filePath = resolve(root, `.${pathname}`);
      if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, "index.html");
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(filePath)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end("Not found");
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Harness server did not bind a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}
