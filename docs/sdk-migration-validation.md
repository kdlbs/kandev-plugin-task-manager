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
requiring the full five-platform set for full archives. Regression fixtures
failed before this adjustment and pass afterward; existing negative checks remain.

## Results

Standalone checkout, package, and minimum-host validation results are recorded
below after completion.
