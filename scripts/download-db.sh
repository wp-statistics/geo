#!/bin/bash
set -e

mkdir -p data

if [ -f data/GeoLite2-City.mmdb.gz ]; then
    echo "GeoLite2-City.mmdb.gz already exists, skipping download."
else
    echo "Downloading MaxMind GeoLite2-City..."
    curl -sL "https://cdn.jsdelivr.net/npm/geolite2-city/GeoLite2-City.mmdb.gz" -o data/GeoLite2-City.mmdb.gz
    echo "GeoLite2-City.mmdb.gz downloaded ($(du -h data/GeoLite2-City.mmdb.gz | cut -f1))"
fi

if [ -f data/dbip-city-lite.mmdb.gz ]; then
    echo "dbip-city-lite.mmdb.gz already exists, skipping download."
else
    echo "Downloading DB-IP City Lite..."
    curl -sL "https://cdn.jsdelivr.net/npm/dbip-city-lite/dbip-city-lite.mmdb.gz" -o data/dbip-city-lite.mmdb.gz
    echo "dbip-city-lite.mmdb.gz downloaded ($(du -h data/dbip-city-lite.mmdb.gz | cut -f1))"
fi

echo "All databases ready."
