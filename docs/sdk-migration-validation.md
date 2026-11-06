# Public SDK migration validation

Migration base: `origin/main` at `1aa135dda19cb4150fa6774eb4c8032c0077f1a3`.
Validated on Linux amd64, 2026-11-05, Go 1.26.6, Node 24.19.0, npm 11.17.0.

The [SDK release](https://github.com/kdlbs/kandev/releases/tag/pluginsdk/v0.1.0)
and installed Go module's `sdk-release.json` identify SDK 0.1.0, host release
0.99.0, minimum host 0.99.0, and supported manifest API versions 1 and 2.
The plugin retains API v1, plugin version 0.2.0, existing permissions, authenticated
usage webhook, native UI bundle, and keyboard shortcut. There are no direct
protobuf imports or frontend SDK consumers in this repository. The `.harness`
npm package is browser test tooling, not a shipped SDK consumer; its lockfile
requires no SDK migration. There is no TypeScript/typecheck script.

The current public authoring guide, `create-kandev-plugin` workflow, and
`docs/plans/plugin-sdk-publishing/template-migration.md` in Kandev were read.
No repository-local AGENTS.md exists on the migration base.

## Packaging input

`plugin-pack` remains backend-owned. `.kandev-tools-ref` pins
`f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb`, materialized separately with sparse
paths `apps/backend` and `pluginsdk`. Packaging is not checkout-free. The plugin
Go module has no backend dependency, tool directive, or SDK replacement.

Current `plugin-pack -platform-only` reserializes YAML and restricts packaged
runtime executables to the host. The verifier now accepts that output while
requiring the full five-platform set for full archives. The release identity checker also accepts the unquoted packaged version.
Regression fixtures failed before these adjustments and pass afterward; existing
negative checks remain.

## Results

### Standalone checkout

The task worktree started clean at the current default branch, not an SDK
feature branch. A separate clone was created with `git clone --no-local .
/tmp/task-manager-migration/standalone`. There is no `../kandev` SDK checkout,
no workspace file, and no SDK replacement. The packaging source is supplied
only by the explicit `KANDEV_TOOLS` input below.

Commands run from that clone (the initial download used an empty module cache):

```sh
env GOWORK=off GOMODCACHE=/tmp/task-manager-migration/public-modcache \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
  GOPRIVATE= GONOPROXY= GONOSUMDB= go mod download
GOWORK=off GOMODCACHE=/tmp/task-manager-migration/public-modcache \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go mod tidy
git diff --exit-code -- go.mod go.sum
make check-format
GOWORK=off GOMODCACHE=/tmp/task-manager-migration/public-modcache \
  GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org \
  make vet test sdk-check build
npm ci --ignore-scripts --prefix .harness
git diff --exit-code -- go.mod go.sum .harness/package-lock.json
go list -m all
```

All passed. `make test` runs `go test ./server/...`, four native UI contract
tests, package verifier and release version negative tests, and two harness
server/loopback tests. The checker printed
`SDK 0.1.0: compatible (minimum Kandev 0.99.0)`. The module graph contains the
public SDK at v0.1.0 and no backend module. The SDK sum is
`h1:Pov5zE2gGf53FslhpcoGgx6E3nu6kjizT69x3MlEEEs=`. `npm ci` installed eight
locked harness packages and reported zero vulnerabilities. Module and npm
lockfiles stayed unchanged. The release-parser follow-up was fast-forwarded
into this clone, then `make test-package-verifier test-release-version` passed.

### Package construction and inspection

Packaging source setup:

```sh
git clone --filter=blob:none --no-checkout https://github.com/kdlbs/kandev.git \
  /tmp/task-manager-migration/packaging-tools
git -C /tmp/task-manager-migration/packaging-tools sparse-checkout set apps/backend pluginsdk
git -C /tmp/task-manager-migration/packaging-tools checkout f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb
```

Commands run in the standalone clone:

```sh
CGO_ENABLED=0 GOWORK=off make verify-package-host \
  KANDEV_TOOLS=/tmp/task-manager-migration/packaging-tools/apps/backend
cp kandev-plugin-task-manager-0.2.0.tar.gz /tmp/task-manager-migration/host-package.tar.gz
CGO_ENABLED=0 GOWORK=off make verify-package \
  KANDEV_TOOLS=/tmp/task-manager-migration/packaging-tools/apps/backend
tar -tzf kandev-plugin-task-manager-0.2.0.tar.gz
sh scripts/verify-release-version.sh v0.2.0 kandev-plugin-task-manager-0.2.0.tar.gz
```

Host and full archive verification passed. The full archive contains exactly
`manifest.yaml`, five executables (Linux amd64/arm64, macOS amd64/arm64, Windows
amd64), `ui/bundle.js`, and generated `checksums.txt`. Release identity verification
also passed with v0.2.0; no tag was created. Each verifier checks the exact inventory,
executable bits, absence of symlinks/special/development files, and complete
SHA-256 coverage. `plugin-pack` generates `checksums.txt`.

### Released minimum-host smoke

Downloaded the released runtime, not a locally rebuilt host:

```sh
gh release download v0.99.0 --repo kdlbs/kandev \
  --pattern kandev-linux-x64-full.tar.gz \
  --pattern kandev-linux-x64-full.tar.gz.sha256 \
  --dir /tmp/task-manager-migration
cd /tmp/task-manager-migration
sha256sum -c kandev-linux-x64-full.tar.gz.sha256
tar -xzf kandev-linux-x64-full.tar.gz
./kandev/bin/kandev --version --json
```

The release digest passed:
`24df61be8750fdf3ef151243f6385a4d14b0e3c84a409b6b11a1ef5fee3237be`.
The binary reported v0.99.0 at
`f0e2e774cfe2df8a0d15e4c21dea7b48580e38fb`. `/health` also reported v0.99.0.

The host ran with all inherited `KANDEV_*` variables removed, then
`KANDEV_HOME_DIR=/tmp/task-manager-migration/host-home`,
`KANDEV_SERVER_HOST=127.0.0.1`, and `KANDEV_FEATURES_AUTH=false` set explicitly.
The command was `/tmp/task-manager-migration/kandev/bin/kandev run --port 18781
--headless --verbose`. This used a disposable database and plugin directory.

Commands from the plugin worktree, using its verified host package:

```sh
LD_LIBRARY_PATH=/nix/store/vj1w29j7kfsvn83z33yb2rpq4ymz24n5-kandev-builtin-playwright-libs/lib \
  KANDEV_URL=http://127.0.0.1:18781 \
  PACKAGE_FILE=/tmp/task-manager-migration/host-package.tar.gz \
  HOST_ACTION=1 make smoke-package
```

Passed: upload/install and active runtime, desktop Action (66.671875 × 28 px),
Pixel 5 coarse-pointer target (66.671875 × 44 px), modal, Enter activation,
registered keyboard shortcut, usage polling, disable/re-enable cleanup, and
uninstall. This harness intercepts usage responses with synthetic data; it
proves the native UI lifecycle, not real process sampling.

A separate real webhook probe installed the same archive with
`curl -F package=@/tmp/task-manager-migration/host-package.tar.gz
http://127.0.0.1:18781/api/plugins/install`. A disposable task fixture was created
using `POST /api/v1/tasks`, with its workspace and workflow ids and
`start_agent:false, prepare_session:false`. A `sleep 120` process ran with that
task's `KANDEV_TASK_ID` and a fixture `KANDEV_SESSION_ID`. The command
`python3 /tmp/task-manager-migration/runtime-smoke.py` requested
`POST /api/plugins/kandev-plugin-task-manager/webhooks/usage` with
`Origin: http://127.0.0.1:18781` and asserted:

- `supported` is true;
- the report contains the fixture task and exact spawned process pid;
- memory bytes are positive;
- its title equals the task fixture's title, fetched through actual Host Tasks.Get;
- an undeclared webhook returns 404.

All assertions passed. The process was terminated afterward. The same disposable
host was restarted with `KANDEV_FEATURES_AUTH=true`; the following returned 401
and `{"error":"authentication required"}`:

```sh
curl --silent --show-error --max-time 10 \
  -o /tmp/task-manager-migration/anonymous-webhook.json \
  -w 'anonymous webhook HTTP %{http_code}\n' -X POST \
  http://127.0.0.1:18781/api/plugins/kandev-plugin-task-manager/webhooks/usage
```

The disposable host was then stopped. No primary-instance data was used.

### Browser layout and workflow checks

```sh
LD_LIBRARY_PATH=/nix/store/vj1w29j7kfsvn83z33yb2rpq4ymz24n5-kandev-builtin-playwright-libs/lib \
  make test-harness
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.11 \
  .github/workflows/build.yml .github/workflows/ci.yml .github/workflows/release.yml
git diff --check
```

The standalone layout harness passed: styling, filtering, expanded-process fit,
narrow viewport, stable open rows with live updates, ranking and threshold
behavior, and legacy chip polling. No browser console errors occurred.
Workflow lint and whitespace checks passed.

Initial local attempts exposed environment or fixture issues: Chromium needed
the Nix library path above; an inherited `CGO_ENABLED=1` broke ARM cross-assembly,
so full packages used `CGO_ENABLED=0`; interrupting a diagnostic browser run left
the same plugin version installed, which was removed before the successful run.
The old host archive verifier and quoted-only release parser failed their new
fixtures before their fixes. No failed attempt is counted as passing evidence.

Only Linux amd64 was runtime-tested. macOS, Windows, and Linux arm64 are
cross-compiled and package-checked, not runtime-certified. The optional legacy UI
path has contract and stub-browser coverage; the released minimum-host browser
smoke exercises its current Action path. No plugin release, tag, or catalog
change was made.

### Review follow-up

The verifier skips blank/comment lines before detecting section boundaries and
requires executable keys to be indented beneath `runtime.executables`. Regression
fixtures confirmed that a top-level comment remains valid and that sibling
platform keys beside a null executable map are rejected. Both fixtures failed
with the previous verifier and passed after the fix.

Both packaging recipes now quote their absolute staging and output paths.
The following checks passed in a checkout whose path contains spaces:

```sh
cd '/tmp/task-manager-migration/path with spaces/plugin'
CGO_ENABLED=0 GOWORK=off make verify-package-host verify-package \
  KANDEV_TOOLS=/tmp/task-manager-migration/packaging-tools/apps/backend
```

The full-package check was resumed after an interrupted run and completed with
all five executable checksums passing. `make test-package-verifier
test-release-version` and `git diff --check` also passed. The documented host
archive copy now uses the same filename as both subsequent smoke probes.
