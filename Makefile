# Distribution packages for SP-404 Stems (electron-builder; output in release/).
#   make mac     macOS .dmg and .zip, Apple silicon and Intel (built natively; needs macOS)
#   make win     Windows portable .exe (runs without installing) and .zip, x64 and arm64 (built in Docker)
#   make linux   Debian/Ubuntu .deb packages, amd64 and arm64 (built in Docker)
#   make dist    tests, then all of the above
# Packages are unsigned. Windows and Linux use electron-builder's official image, which has Wine, Mono and the
# Debian tools; its node_modules lives in a Docker volume so it doesn't replace the Mac's own.
# Windows uses the portable target, not an NSIS installer: building the installer runs a 32-bit program under Wine,
# which crashes under Docker's emulation on Apple silicon.

BUILDER_IMAGE := electronuserland/builder:22-wine-05.26
DOCKER_RUN := docker run --rm --platform linux/amd64 \
	-v "$(CURDIR)":/project -w /project \
	-v 404-stems-node-modules:/project/node_modules \
	-v 404-stems-electron-cache:/root/.cache/electron \
	-v 404-stems-builder-cache:/root/.cache/electron-builder \
	-e ELECTRON_CACHE=/root/.cache/electron -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
	$(BUILDER_IMAGE)

.PHONY: dist mac win linux deps build test clean clean-docker

dist: test mac win linux

deps: node_modules/.package-lock.json

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

build: deps
	npx tsc

test: deps
	npm test
	npm run typecheck

mac: build
	npx electron-builder --mac

win:
	$(DOCKER_RUN) bash -c "npm ci && npx tsc && npx electron-builder --win"

linux:
	$(DOCKER_RUN) bash -c "npm ci && npx tsc && npx electron-builder --linux"

clean:
	rm -rf dist release

clean-docker:
	docker volume rm -f 404-stems-node-modules 404-stems-electron-cache 404-stems-builder-cache
