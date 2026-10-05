#!/bin/sh
set -eu

fail() {
	printf 'release version verification failed: %s\n' "$1" >&2
	exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
	fail 'usage: verify-release-version.sh TAG [PACKAGE_FILE]'
fi

tag=$1

# Semantic Versioning 2.0.0: numeric core and prerelease identifiers cannot
# have leading zeroes; prerelease identifiers must be non-empty; build
# metadata is allowed, but must match exactly across release inputs.
semver_pattern='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
is_semver() {
	printf '%s\n' "$1" | grep -Eq "$semver_pattern"
}

case "$tag" in
v*) tag_version=${tag#v} ;;
*) fail "tag is not a release version: $tag" ;;
esac
if ! is_semver "$tag_version"; then
	fail "tag is not a release version: $tag"
fi

manifest_version=$(sed -nE 's/^version: "([^"]+)"$/\1/p' manifest.yaml)
make_version=$(sed -nE 's/^VERSION := ([^[:space:]]+)$/\1/p' Makefile)
[ -n "$manifest_version" ] || fail 'manifest.yaml has no SemVer version'
[ -n "$make_version" ] || fail 'Makefile has no SemVer VERSION'
is_semver "$manifest_version" || fail "manifest version is not SemVer: $manifest_version"
is_semver "$make_version" || fail "Makefile VERSION is not SemVer: $make_version"
[ "$manifest_version" = "$make_version" ] || fail "manifest version $manifest_version differs from Makefile version $make_version"
[ "$tag_version" = "$manifest_version" ] || fail "tag $tag differs from manifest version $manifest_version"

if [ "$#" -eq 2 ]; then
	package_file=$2
	expected_package=$(make -s package-file)
	[ -f "$package_file" ] || fail "package file not found: $package_file"
	[ "$(basename "$package_file")" = "$expected_package" ] || fail "package filename $(basename "$package_file") differs from $expected_package"
	package_manifest=$(tar -xOzf "$package_file" manifest.yaml | sed -nE 's/^version: "([^"]+)"$/\1/p')
	is_semver "$package_manifest" || fail "package manifest version is not SemVer: ${package_manifest:-missing}"
	[ "$package_manifest" = "$tag_version" ] || fail "package manifest version ${package_manifest:-missing} differs from tag $tag"
fi
