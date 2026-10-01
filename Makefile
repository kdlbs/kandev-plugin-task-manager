.PHONY: build test test-harness live fmt vet package package-host clean

BIN := bin/kandev-plugin-task-manager
VERSION := 0.1.3
STAGE := .build/stage
PKG_OUT := kandev-plugin-task-manager-$(VERSION).tar.gz

build:
	mkdir -p bin
	go build -o $(BIN) ./server

test:
	go test ./server/...

test-harness:
	pnpm --dir .harness install --frozen-lockfile
	node .harness/build-globals.mjs
	server=$$(python3 -m http.server 8977 --directory . >/tmp/kandev-task-manager-harness.log 2>&1 & echo $$!); trap 'kill $$server 2>/dev/null || true' EXIT; node .harness/shoot.mjs

## Sample the machine this runs on and print the per-task rollup. A
## diagnostic for verifying attribution end to end, not part of `test`.
live:
	KANDEV_TM_LIVE=1 go test ./server/ -run TestLiveProbe -v

fmt:
	gofmt -l .

vet:
	go vet ./server/...

## Cross-compile every platform in manifest.yaml, stage manifest + ui, pack.
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
	go run -mod=mod github.com/kandev/kandev/cmd/plugin-pack -dir $(STAGE) -out $(PKG_OUT)
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

## Host-platform-only package — faster local iteration.
package-host:
	rm -rf $(STAGE)
	mkdir -p $(STAGE)/server
	cp manifest.yaml $(STAGE)/manifest.yaml
	cp -r ui $(STAGE)/ui
	go build -o $(STAGE)/server/plugin-$$(go env GOOS)-$$(go env GOARCH)$$(go env GOEXE) ./server
	go run -mod=mod github.com/kandev/kandev/cmd/plugin-pack -dir $(STAGE) -out $(PKG_OUT) -platform-only
	rm -rf $(STAGE)
	@echo "Wrote $(PKG_OUT)"

clean:
	rm -rf bin $(STAGE) kandev-plugin-task-manager-*.tar.gz
