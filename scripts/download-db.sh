#!/bin/bash
set -e

mkdir -p data

if [ -f data/GeoLite2-City.mmdb ]; then
    echo "GeoLite2-City.mmdb already exists, skipping download."
else
    echo "Downloading MaxMind GeoLite2-City..."
    curl -sL "https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz" | gunzip > data/GeoLite2-City.mmdb
    echo "GeoLite2-City.mmdb downloaded ($(du -h data/GeoLite2-City.mmdb | cut -f1))"
fi

if [ -f data/dbip-city-lite.mmdb ]; then
    echo "dbip-city-lite.mmdb already exists, skipping download."
else
    echo "Downloading DB-IP City Lite..."
    curl -sL "https://cdn.jsdelivr.net/npm/dbip-city-lite/dbip-city-lite.mmdb.gz" | gunzip > data/dbip-city-lite.mmdb
    echo "dbip-city-lite.mmdb downloaded ($(du -h data/dbip-city-lite.mmdb | cut -f1))"
fi

echo "All databases ready."
