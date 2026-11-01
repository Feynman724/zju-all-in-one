#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ "$(uname -s)" == Darwin ]] || { echo '此脚本只适用于 macOS'; exit 1; }
mkdir -p .local-tools
xcrun clang++ -std=c++17 -O2 -Wall -Wextra -Wno-deprecated-declarations \
  core/wechat/scripts/local/mac-key.cpp -framework Security -framework CoreFoundation \
  -o .local-tools/wechat-mac-key.new
chmod 700 .local-tools/wechat-mac-key.new
mv .local-tools/wechat-mac-key.new .local-tools/wechat-mac-key
