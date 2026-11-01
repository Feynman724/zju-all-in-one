#!/bin/zsh
# Run the source checkout with its own Node; no DMG installation is needed.
set -eu
cd -- "$(dirname -- "$0")"
case "$(uname -m)" in
  arm64) campus_node="node_modules/node-bin-darwin-arm64/bin/node" ;;
  x86_64) campus_node="node_modules/node-darwin-x64/bin/node" ;;
  *) print -u2 '不支持的 Mac 架构'; exit 1 ;;
esac
if [[ ! -x "$campus_node" || ! -d node_modules/esbuild ]]; then
  print -u2 '请先使用 Node.js 24.18+（24.x）和 npm 11，在项目目录运行 npm ci。'
  exit 1
fi
unset ELECTRON_RUN_AS_NODE
exec "$campus_node" ui/build.mjs --app
