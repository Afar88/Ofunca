#!/usr/bin/env bash
# Signs the unsigned release APK with APK Signature Scheme v1 + v2 + v3 (v1 is skipped automatically for minSdk 29+).
# Usage: KEYSTORE=/path/release.keystore KS_PASS_FILE=/path/pass scripts/sign-apk.sh in-unsigned.apk out-signed.apk
# Optional: APKSIGNER=/path/to/apksigner (default: apksigner on PATH), KS_ALIAS (default: ofunca).
#
# zipalign from the Android build-tools is an x86-64 binary. On an ARM machine (or anywhere it can't run) the
# alignment is checked with Python instead: AGP output is already aligned, so signing goes ahead only when every
# stored (uncompressed) entry starts on a 4-byte boundary and every stored .so on a 16 KB page boundary.
set -euo pipefail
IN="$1"; OUT="$2"
APKSIGNER="${APKSIGNER:-apksigner}"
ALIGNED="$(mktemp --suffix=.apk)"

py_align_check() {
  python3 - "$1" <<'PY'
import struct, sys, zipfile
path = sys.argv[1]
bad = 0
with open(path, 'rb') as f, zipfile.ZipFile(path) as z:
    for i in z.infolist():
        if i.compress_type != zipfile.ZIP_STORED:
            continue
        f.seek(i.header_offset)
        h = f.read(30)
        n, e = struct.unpack('<HH', h[26:30])
        data = i.header_offset + 30 + n + e
        need = 16384 if i.filename.endswith('.so') else 4
        if data % need:
            bad += 1
            print(f'misaligned: {i.filename} at {data} (needs {need})', file=sys.stderr)
print('aligned' if not bad else f'{bad} misaligned entries')
sys.exit(1 if bad else 0)
PY
}

if zipalign -c -p 4 "$IN" >/dev/null 2>&1; then
  cp "$IN" "$ALIGNED"
elif command -v zipalign >/dev/null 2>&1 && zipalign -f -p 4 "$IN" "$ALIGNED" >/dev/null 2>&1; then
  : # re-aligned
else
  echo "zipalign not usable here; checking alignment with Python…"
  py_align_check "$IN"
  cp "$IN" "$ALIGNED"
fi
"$APKSIGNER" sign --ks "$KEYSTORE" --ks-key-alias "${KS_ALIAS:-ofunca}" \
  --ks-pass "file:$KS_PASS_FILE" \
  --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --min-sdk-version 24 \
  --out "$OUT" "$ALIGNED"
rm -f "$ALIGNED"
"$APKSIGNER" verify --verbose --print-certs --min-sdk-version 24 "$OUT"
