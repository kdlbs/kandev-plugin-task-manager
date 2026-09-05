# Browser harness

The harness serves `.harness/index.html` from the plugin repository and loads
the exact `ui/bundle.js` shipped in the package. It resolves Playwright and
esbuild from `.harness/node_modules`, the repository, or a sibling Kandev
checkout. Set `PLAYWRIGHT_MODULE` or `ESBUILD_MODULE` when a different local
installation is required; no developer-specific path is part of the harness.

From the plugin repository:

```sh
make test-harness
```

For the real-app smoke flow, point `KANDEV_URL` at a disposable running Kandev
instance and run:

```sh
node .harness/real-app.mjs
```

