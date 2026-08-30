#!/usr/bin/env bash
# Sole stamp+publish body for publish-registry workflow (and its contract tests).
# CHANNEL arrives only via process env — never expanded into shell source.
# Routing (main→latest / allowlist branch→next) belongs to publish-registry.yml;
# this script owns version stamping and idempotent dist-tag only.
set -euo pipefail

npm --version
VERSION="0.1.$(git rev-list --count HEAD)"
if [ "${CHANNEL:-}" != "latest" ]; then
  VERSION="$VERSION-$CHANNEL.$(git rev-parse --short=7 HEAD)"
fi
npm version "$VERSION" --no-git-tag-version
PACKAGE_NAME="$(node -p 'require("./package.json").name')"
if npm view "$PACKAGE_NAME@$VERSION" version >/dev/null 2>&1; then
  # Same commit re-dispatch (or recovered publish): move dist-tag only.
  npm dist-tag add "$PACKAGE_NAME@$VERSION" "$CHANNEL"
  echo "Dist-tag $CHANNEL → $PACKAGE_NAME@$VERSION (version already on registry)" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
else
  npm publish --access public --tag "$CHANNEL"
  echo "Published $PACKAGE_NAME@$VERSION ($CHANNEL)" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
fi
