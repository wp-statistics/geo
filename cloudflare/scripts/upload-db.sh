#!/bin/bash
# Fetch the latest GeoIP databases and upload them (uncompressed) to the R2 bucket
# the Worker reads from. The Worker reads byte-ranges directly, so the objects must
# be stored UNcompressed.
#
# Works both locally and in CI. In CI, set CLOUDFLARE_API_TOKEN (and
# CLOUDFLARE_ACCOUNT_ID) so wrangler can authenticate.
#
# Usage:  bash scripts/upload-db.sh
set -e

BUCKET="geo-databases"
MAXMIND_URL="https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz"
DBIP_URL="https://cdn.jsdelivr.net/npm/dbip-city-lite/dbip-city-lite.mmdb.gz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch_and_upload() {
  local url="$1" key="$2"
  echo "Downloading $key ..."
  curl -sSL "$url" -o "$TMP/$key.gz"
  echo "Decompressing ..."
  gzip -df "$TMP/$key.gz"   # -> $TMP/$key
  echo "Uploading $key ($(du -h "$TMP/$key" | cut -f1)) to r2://$BUCKET ..."
  wrangler r2 object put "$BUCKET/$key" --file "$TMP/$key" \
    --content-type application/octet-stream --remote
  rm -f "$TMP/$key"
}

fetch_and_upload "$MAXMIND_URL" "GeoLite2-City.mmdb"
fetch_and_upload "$DBIP_URL" "dbip-city-lite.mmdb"

echo "Done — latest databases uploaded to R2 bucket '$BUCKET'."
