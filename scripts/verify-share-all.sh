#!/usr/bin/env bash
# 在隔离副本上完整验证阶段 3 的接线。
#
# 教训：/tmp 下没有 package.json 时，node 按 CJS 解析 `.js`，`node --check`
# 对这些 ESM 文件**直接返回 0**，什么也没检查。必须把 package.json 一起放
# 进去（或者--check 前先改成 .mjs）。这个脚本两件都做。
set -euo pipefail
cd /tmp/ssv

echo "=== 语法（package.json 在场，才是真的按 ESM 检查）==="
node --check bridge.js
node --check mcp.js
node --check share-signal-store.js
# 双保险：换成 .mjs 再查一遍，不依赖 package.json
for f in bridge mcp share-signal-store; do
  cp "$f.js" "chk-$f.mjs"
  node --check "chk-$f.mjs"
  rm -f "chk-$f.mjs"
done
echo "syntax OK"

echo
echo "=== 接线层（从打补丁后的 bridge.js 抽函数实跑）==="
node verify-share-signal-wire.mjs 2>/dev/null | tail -22

echo
echo "=== share 唤醒文案（真跑 buildWakePromptV2）==="
node verify-share-prompt.cjs | tail -12
