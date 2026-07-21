#!/bin/bash
# Pull the newest signed .ipa from this repo's 'app-latest' release into ota/,
# where server.py serves it publicly at https://<host>/app for OTA install.
# (Same pattern as the notes app's update-app.sh.)
set -e
cd "$(dirname "$0")"
mkdir -p ota
gh release download app-latest -R wzachmorris/terminalclaw \
  --pattern 'terminalclaw.ipa' -O ota/terminalclaw.ipa --clobber
echo "OTA build updated: $(ls -lh ota/terminalclaw.ipa | awk '{print $5, $6, $7, $8}')"
