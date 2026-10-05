import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLoopbackUrl } from "./loopback.mjs";
import { startStaticServer } from "./server.mjs";

test("accepts IPv4 and bracketed IPv6 loopback URLs only", () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:41729"), true);
  assert.equal(isLoopbackUrl("http://[::1]:41729"), true);
  assert.equal(isLoopbackUrl("http://localhost:41729"), true);
  assert.equal(isLoopbackUrl("http://example.com:41729"), false);
});

test("static server returns 404 for a directory without index.html", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-manager-static-"));
  await mkdir(join(root, "empty"));
  await writeFile(join(root, "ready.txt"), "ready");
  const server = await startStaticServer(root);

  try {
    const file = await fetch(`${server.url}/ready.txt`);
    assert.equal(file.status, 200);
    assert.equal(await file.text(), "ready");

    const emptyDirectory = await fetch(`${server.url}/empty`);
    assert.equal(emptyDirectory.status, 404);
    assert.equal(await emptyDirectory.text(), "Not found");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
