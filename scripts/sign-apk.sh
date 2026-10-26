#!/usr/bin/env bash
# Signs the unsigned release APK with APK Signature Scheme v2 + v3 (v1 is skipped automatically for minSdk 29+).
# Usage: KEYSTORE=/path/release.keystore KS_PASS_FILE=/path/pass scripts/sign-apk.sh in-unsigned.apk out-signed.apk
set -euo pipefail
IN="$1"; OUT="$2"
ALIGNED="$(mktemp --suffix=.apk)"
# AGP output is already page-aligned (16 KB); only re-align if it is not.
if zipalign -c -p 4 "$IN" >/dev/null 2>&1; then cp "$IN" "$ALIGNED"; else zipalign -f -p 4 "$IN" "$ALIGNED"; fi
apksigner sign --ks "$KEYSTORE" --ks-key-alias "${KS_ALIAS:-studytutor}" \
  --ks-pass "file:$KS_PASS_FILE" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --min-sdk-version 24 \
  --out "$OUT" "$ALIGNED"
rm -f "$ALIGNED"
apksigner verify --verbose --print-certs --min-sdk-version 24 "$OUT"
