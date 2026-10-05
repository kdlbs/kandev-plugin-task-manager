#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd "$(dirname "$0")/.." && pwd)
verify_script=$repo_dir/scripts/verify-release-version.sh
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
base_version=$(sed -nE 's/^version: "([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)"$/\1/p' "$repo_dir/manifest.yaml")
wrong_version=999.999.999
[ "$wrong_version" != "$base_version" ] || wrong_version=999.999.998

make_fixture() {
	fixture=$test_dir/$1
	mkdir -p "$fixture"
	cp "$repo_dir/Makefile" "$repo_dir/manifest.yaml" "$fixture/"
}

set_fixture_version() {
	fixture=$1
	version=$2
	sed "s/^version: .*/version: \"$version\"/" "$fixture/manifest.yaml" > "$fixture/manifest.next"
	mv "$fixture/manifest.next" "$fixture/manifest.yaml"
	sed "s/^VERSION := .*/VERSION := $version/" "$fixture/Makefile" > "$fixture/Makefile.next"
	mv "$fixture/Makefile.next" "$fixture/Makefile"
}

expect_failure() {
	name=$1
	fixture=$2
	shift 2
	if (cd "$fixture" && sh "$verify_script" "$@") > "$test_dir/output" 2>&1; then
		printf 'expected release verification to reject %s\n' "$name" >&2
		exit 1
	fi
}

make_fixture valid
(cd "$test_dir/valid" && sh "$verify_script" "v$base_version")

make_fixture wrong-tag
expect_failure 'a tag that differs from manifest.yaml' "$test_dir/wrong-tag" "v$wrong_version"

make_fixture wrong-manifest
sed "s/^version: \"$base_version\"$/version: \"$wrong_version\"/" "$test_dir/wrong-manifest/manifest.yaml" > "$test_dir/wrong-manifest/manifest.next"
mv "$test_dir/wrong-manifest/manifest.next" "$test_dir/wrong-manifest/manifest.yaml"
expect_failure 'a manifest version that differs from Makefile' "$test_dir/wrong-manifest" "v$base_version"

make_fixture wrong-makefile
sed "s/^VERSION := $base_version$/VERSION := $wrong_version/" "$test_dir/wrong-makefile/Makefile" > "$test_dir/wrong-makefile/Makefile.next"
mv "$test_dir/wrong-makefile/Makefile.next" "$test_dir/wrong-makefile/Makefile"
expect_failure 'a Makefile version that differs from manifest.yaml' "$test_dir/wrong-makefile" "v$base_version"

make_fixture invalid-tag
expect_failure 'a tag without the v prefix' "$test_dir/invalid-tag" "release-$base_version"

make_fixture wrong-package-name
printf 'not a package\n' > "$test_dir/wrong-package-name/wrong-name.tar.gz"
expect_failure 'a package filename that differs from Makefile' "$test_dir/wrong-package-name" "v$base_version" wrong-name.tar.gz

make_fixture wrong-package-manifest
mkdir -p "$test_dir/wrong-package-manifest/archive"
sed "s/^version: \"$base_version\"$/version: \"$wrong_version\"/" "$test_dir/wrong-package-manifest/manifest.yaml" > "$test_dir/wrong-package-manifest/archive/manifest.yaml"
package_file=$(cd "$test_dir/wrong-package-manifest" && make -s package-file)
tar -czf "$test_dir/wrong-package-manifest/$package_file" -C "$test_dir/wrong-package-manifest/archive" manifest.yaml
expect_failure 'an archive manifest version that differs from its tag' "$test_dir/wrong-package-manifest" "v$base_version" "$package_file"

make_fixture matching-package
mkdir -p "$test_dir/matching-package/archive"
cp "$test_dir/matching-package/manifest.yaml" "$test_dir/matching-package/archive/manifest.yaml"
package_file=$(cd "$test_dir/matching-package" && make -s package-file)
tar -czf "$test_dir/matching-package/$package_file" -C "$test_dir/matching-package/archive" manifest.yaml
(cd "$test_dir/matching-package" && sh "$verify_script" "v$base_version" "$package_file")

make_fixture prerelease
set_fixture_version "$test_dir/prerelease" 0.2.0-rc.1
(cd "$test_dir/prerelease" && sh "$verify_script" v0.2.0-rc.1)

make_fixture build-metadata
set_fixture_version "$test_dir/build-metadata" 0.2.0-rc.1+build.7
(cd "$test_dir/build-metadata" && sh "$verify_script" v0.2.0-rc.1+build.7)

for invalid_tag in \
	v01.2.3 v1.02.3 v1.2.03 v1.2.3- v1.2.3-.alpha \
	v1.2.3-alpha. v1.2.3-alpha..1 v1.2.3-01 v1.2.3-1.01; do
	make_fixture "invalid-${invalid_tag#v}"
	expect_failure "malformed SemVer tag $invalid_tag" "$test_dir/invalid-${invalid_tag#v}" "$invalid_tag"
done

make_fixture malformed-manifest
set_fixture_version "$test_dir/malformed-manifest" 01.2.3
expect_failure 'matching non-SemVer manifest and Makefile' "$test_dir/malformed-manifest" v1.2.3

make_fixture malformed-makefile
sed 's/^VERSION := .*/VERSION := 0.1.03/' "$test_dir/malformed-makefile/Makefile" > "$test_dir/malformed-makefile/Makefile.next"
mv "$test_dir/malformed-makefile/Makefile.next" "$test_dir/malformed-makefile/Makefile"
expect_failure 'a non-SemVer Makefile version' "$test_dir/malformed-makefile" "v$base_version"

make_fixture malformed-package
mkdir -p "$test_dir/malformed-package/archive"
sed 's/^version: .*/version: "0.1.03"/' "$test_dir/malformed-package/manifest.yaml" > "$test_dir/malformed-package/archive/manifest.yaml"
package_file=$(cd "$test_dir/malformed-package" && make -s package-file)
tar -czf "$test_dir/malformed-package/$package_file" -C "$test_dir/malformed-package/archive" manifest.yaml
expect_failure 'a package with a non-SemVer manifest version' "$test_dir/malformed-package" "v$base_version" "$package_file"

printf 'release version negative tests passed\n'
