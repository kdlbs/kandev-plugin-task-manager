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
sed -i -E 's/^version: "[^"]+"$/version: "0.2.0-rc.1"/' "$test_dir/prerelease/manifest.yaml"
sed -i -E 's/^VERSION := .+$/VERSION := 0.2.0-rc.1/' "$test_dir/prerelease/Makefile"
(cd "$test_dir/prerelease" && sh "$verify_script" v0.2.0-rc.1)

printf 'release version negative tests passed\n'
