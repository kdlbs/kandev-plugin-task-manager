.PHONY: build test test-backend test-ui test-package-verifier test-release-version test-harness-server test-harness smoke-package live fmt check-format vet package package-host verify-package verify-package-host package-file clean

BIN := bin/kandev-plugin-task-manager
VERSION := 0.2.0
STAGE := .build/stage
PKG_OUT := kandev-plugin-task-manager-$(VERSION).tar.gz
KANDEV_SDK := ../kandev/apps/backend

build:
	mkdir -p bin
	go build -o $(BIN) ./server

test: test-backend test-ui test-package-verifier test-release-version test-harness-server

test-backend:
	go test ./server/...

test-ui:
	node --test tests/ui-action.test.js

test-package-verifier:
	sh scripts/test-verify-package.sh

test-release-version:
	sh scripts/test-verify-release-version.sh

test-harness-server:
	node --test .harness/server.test.mjs
test-harness:
	npm run test:layout --prefix .harness

## Smoke-test an already built package in a disposable local host. Requires KANDEV_URL and PACKAGE_FILE.
smoke-package:
	test -n "$(KANDEV_URL)" -a -n "$(PACKAGE_FILE)"
	KANDEV_URL="$(KANDEV_URL)" PACKAGE_FILE="$(abspath $(PACKAGE_FILE))" npm run test:host --prefix .harness

## Sample this machine and print the per-task rollup. This diagnostic does not run during `make test`.
live:
	KANDEV_TM_LIVE=1 go test ./server/ -run TestLiveProbe -v

fmt:
	gofmt -l .

check-format:
	@test -z "$$(gofmt -l ./server)" || { echo "gofmt needed:"; gofmt -l ./server; exit 1; }

vet:
	go vet ./server/...

## Cross-compile every platform in manifest.yaml, then pack manifest, UI, and binaries.
package:
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	GOOS=linux   GOARCH=amd64 go build -o $(STAGE)/server/plugin-linux-amd64       ./server
	GOOS=linux   GOARCH=arm64 go build -o $(STAGE)/server/plugin-linux-arm64       ./server
	GOOS=darwin  GOARCH=amd64 go build -o $(STAGE)/server/plugin-darwin-amd64      ./server
	GOOS=darwin  GOARCH=arm64 go build -o $(STAGE)/server/plugin-darwin-arm64      ./server
	GOOS=windows GOARCH=amd64 go build -o $(STAGE)/server/plugin-windows-amd64.exe ./server
	cd $(KANDEV_SDK) && go run ./cmd/plugin-pack -dir $(CURDIR)/$(STAGE) -out $(CURDIR)/$(PKG_OUT)
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Build a package for the current platform only.
package-host:
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	go build -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server
	cd $(KANDEV_SDK) && go run ./cmd/plugin-pack -dir $(CURDIR)/$(STAGE) -out $(CURDIR)/$(PKG_OUT) -platform-only
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Build and validate the all-platform archive, including its exact file list and checksums.
verify-package: package
	@set -eu; \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		sh scripts/verify-package.sh "$$tmp" full

## Build and validate a host-platform archive.
verify-package-host: package-host
	@set -eu; \
		tmp="$$(mktemp -d)"; \
		trap 'rm -rf "$$tmp"' EXIT; \
		tar -xzf "$(PKG_OUT)" -C "$$tmp"; \
		sh scripts/verify-package.sh "$$tmp" host "$$(go env GOOS)-$$(go env GOARCH)"

package-file:
	@printf '%s\n' "$(PKG_OUT)"

clean:
	rm -rf bin $(STAGE) kandev-plugin-task-manager-*.tar.gz
