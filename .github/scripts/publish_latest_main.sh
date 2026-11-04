#!/usr/bin/env bash
# Replace this build's platform assets on the rolling latest-main prerelease.
# Usage: publish_latest_main.sh ARTIFACT_DIRECTORY (holding switchboard-<platform>/ folders).
# Needs GH_REPO, GITHUB_SHA and a gh token. Each platform's job runs in its own
# concurrency group, which serialises publishes but not in commit order: an
# older run that finishes later must not replace a newer build's assets.
set -euo pipefail
artifacts=$1
gh release view latest-main >/dev/null 2>&1 ||
  gh release create latest-main --prerelease --latest=false --target "$GITHUB_SHA" \
    --title 'Latest main build' --notes 'Rolling build used by Switchboard automatic updates.'
release=$(mktemp -d)
for directory in "$artifacts"/switchboard-*; do
  platform=${directory##*/switchboard-}
  published=$(gh release download latest-main -p "switchboard-$platform-bundle.json" -O - 2>/dev/null |
    jq -r '.commit // empty' 2>/dev/null || true)
  if [ -n "$published" ] && [ "$published" != "$GITHUB_SHA" ]; then
    # "behind": this build is an ancestor of the published one. A commit the
    # compare cannot place (force-pushed away) does not block publishing.
    status=$(gh api "repos/$GH_REPO/compare/$published...$GITHUB_SHA" --jq .status 2>/dev/null || echo unknown)
    if [ "$status" = behind ]; then
      echo "Skipping $platform: the published $published is newer than $GITHUB_SHA"
      continue
    fi
  fi
  for file in "$directory"/*; do cp "$file" "$release/switchboard-$platform-$(basename "$file")"; done
done
if [ -z "$(ls -A "$release")" ]; then exit 0; fi
# Manifests last: updaters verify every asset against them and retry on a
# mismatch while a newer upload is in progress.
gh release upload latest-main --clobber $(ls "$release"/* | grep -v -- '-bundle.json$')
gh release upload latest-main --clobber "$release"/*-bundle.json
# The manifest's commit is authoritative; the tag follows for readers.
git tag -f latest-main "$GITHUB_SHA"
git push -f origin refs/tags/latest-main
