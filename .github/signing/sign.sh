#!/bin/bash
# Signs a macOS executable with Switchboard's own certificate under one fixed
# identifier. macOS keys Local Network and other privacy grants to the code
# signature, and the linker's ad hoc signature changes with every build, so
# each update had to be allowed again.
# Usage: sign.sh EXECUTABLE (needs MACOS_SIGNING_P12 base64 and MACOS_SIGNING_PASSWORD)
set -euo pipefail
executable=$1
here=$(cd "$(dirname "$0")" && pwd)
identifier=dev.switchboard.zellij
identity=$(openssl x509 -in "$here/certificate.pem" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
work=$(mktemp -d)
keychain="$work/signing.keychain-db"
original=$(security list-keychains -d user | tr -d '"')
trap 'security list-keychains -d user -s $original; security delete-keychain "$keychain" 2>/dev/null || true; rm -rf "$work"' EXIT
printf '%s' "$MACOS_SIGNING_P12" | base64 --decode > "$work/signing.p12"
security create-keychain -p "" "$keychain"
security unlock-keychain -p "" "$keychain"
security import "$work/signing.p12" -k "$keychain" -P "$MACOS_SIGNING_PASSWORD" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "" "$keychain" >/dev/null
# codesign on CI finds the identity only in a keychain on the search list.
security list-keychains -d user -s "$keychain" $original
codesign --force --keychain "$keychain" --sign "$identity" --identifier "$identifier" "$executable"
# Grants follow the designated requirement, so it must name only the
# identifier and this certificate, never a per-build hash.
leaf=$(openssl x509 -in "$here/certificate.pem" -outform der | openssl sha1 -binary | xxd -p)
expected="designated => identifier \"$identifier\" and certificate leaf = H\"$leaf\""
actual=$(codesign -d -r- "$executable" 2>&1 | grep '^designated')
if [ "$actual" != "$expected" ]; then
    echo "Unexpected designated requirement: $actual (wanted $expected)" >&2
    exit 1
fi
codesign --verify --strict "$executable"
echo "Signed $executable as $identifier"
