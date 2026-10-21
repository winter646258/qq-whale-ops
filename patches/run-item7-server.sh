#!/bin/bash
# item7 server probe：隔离副本里跑真实 bridge.js（真实表情库 + 真实失败文案，不碰生产 state、不监听端口）
set -u
T=/tmp/item7-test
SRC=/opt/qq-bridge

rm -rf "$T"
mkdir -p "$T/src" "$T/state"

cp -rs "$SRC/src/." "$T/src/" 2>/dev/null
rm -f "$T/src/bridge.js"
cp /tmp/bridge-hook7-test.js "$T/src/bridge.js"
cp /tmp/test-item7-server.mjs "$T/test-item7-server.mjs"
cp "$SRC/config.json" "$T/config.json" 2>/dev/null
cp "$SRC/package.json" "$T/package.json" 2>/dev/null
ln -s "$SRC/node_modules" "$T/node_modules"

# 只读拷一份真实表情库给解析器用（写入会落在副本里）
cp "$SRC/state/stickers.json" "$T/state/stickers.json" 2>/dev/null && echo "表情库已拷入副本"
[ -f "$SRC/state/slang-session.json" ] && cp "$SRC/state/slang-session.json" "$T/state/" && echo "学习会话档已拷入"

echo "--- 生产侧基线（跑完要逐条核对没变）---"
stat -c '%n %s %Y' "$SRC/state/stickers.json" 2>/dev/null
ls -l "$SRC/state/slang-session.json" 2>/dev/null || echo "slang-session.json 不存在（正常：失败会被 unlink）"

echo "--- 副本就绪 ---"
ls -l "$T/src/bridge.js" "$T/state/stickers.json" 2>/dev/null

cd "$T" || exit 1
echo "--- 启动（钩子跑完测试即退出）---"
BRIDGE_TEST_EXPORT=1 BRIDGE_TEST_SCRIPT="$T/test-item7-server.mjs" \
  timeout 180 node src/bridge.js 2>&1 | tail -70
echo "exit=${PIPESTATUS[0]}"

echo "--- 生产侧复核（应与基线完全一致）---"
stat -c '%n %s %Y' "$SRC/state/stickers.json" 2>/dev/null
ls -l "$SRC/state/slang-session.json" 2>/dev/null || echo "slang-session.json 仍不存在 ✓"
