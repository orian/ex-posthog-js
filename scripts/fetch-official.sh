#!/usr/bin/env bash
# Downloads the official posthog-js npm package (pinned) for differential tests.
set -euo pipefail
VERSION="${1:-1.450.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/test/diff/vendor/posthog-js-$VERSION"
if [ -d "$DEST" ]; then echo "$DEST"; exit 0; fi
TMP="$(mktemp -d)"
curl -sfL -o "$TMP/pkg.tgz" "https://registry.npmjs.org/posthog-js/-/posthog-js-$VERSION.tgz"
mkdir -p "$DEST" && tar xzf "$TMP/pkg.tgz" -C "$TMP" && cp -r "$TMP/package/dist" "$DEST/dist"
rm -rf "$TMP"
echo "$DEST"
