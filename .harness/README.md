# Browser harness

The harness serves `.harness/index.html` from the plugin repository and loads
the exact `ui/bundle.js` shipped in the package. It resolves Playwright and
esbuild from its locked npm dependencies in `.harness/node_modules`.

From the plugin repository:

```sh
npm ci --prefix .harness
make test-harness
```

For the real-app smoke flow, point `KANDEV_URL` at a disposable running Kandev
instance and run:

```sh
KANDEV_URL=http://127.0.0.1:8080 PACKAGE_FILE=./kandev-plugin-task-manager-0.2.0.tar.gz make smoke-package
```
