#!/bin/bash
# 第 7 项上线：备份 → 替换 → 语法检查 → 重启 → 验活
# 覆盖：黑话学习会话失效检测/重建退避 · 表情引用解析（desc/localNote 也能认）
set -u
SRC=/opt/qq-bridge
TS=$(date +%Y%m%d-%H%M%S)
BAK="$SRC/src/bridge.js.bak-item7-$TS"

echo "=== 1. 备份 ==="
cp "$SRC/src/bridge.js" "$BAK" && echo "备份 -> $BAK ($(stat -c%s "$BAK") 字节)"

echo "=== 2. 替换 ==="
cp /tmp/bridge-patched7.js "$SRC/src/bridge.js"
chown root:root "$SRC/src/bridge.js" 2>/dev/null
chmod 644 "$SRC/src/bridge.js"
echo "新文件 $(stat -c%s "$SRC/src/bridge.js") 字节"

echo "=== 3. 语法检查 ==="
if ! node --check "$SRC/src/bridge.js"; then
  echo "!! 语法检查失败，回滚"
  cp "$BAK" "$SRC/src/bridge.js"
  systemctl restart qq-bridge
  exit 1
fi
echo "语法 OK"

echo "=== 4. 关键改动确认（每项应为 1 或预期数） ==="
for pat in 'MARKER: item7-slang' 'MARKER: item7-sticker' 'function resolveStickerRef' 'function stickerRefError' 'function classifySlangLearnerError' 'function handleSlangLearnerFailure' 'SLANG_LEARNER_REBUILD_MAX' 'slangLearnerBlockedUntil'; do
  printf '  %-40s %s\n' "$pat" "$(grep -c "$pat" "$SRC/src/bridge.js")"
done

echo "=== 5. 旧逻辑残留（应全为 0） ==="
echo "  旧猜失效正则: $(grep -cE '会话\|session\|not found\|404' "$SRC/src/bridge.js")"
echo "  旧表情精确匹配直调: $(grep -c 'findSticker(stickerEntries, ref)' "$SRC/src/bridge.js")"

echo "=== 6. 重启 qq-bridge ==="
systemctl restart qq-bridge
for i in $(seq 1 20); do
  sleep 2
  st=$(systemctl is-active qq-bridge)
  [ "$st" = "active" ] && break
done
echo "状态: $(systemctl is-active qq-bridge)"

echo "=== 7. 验活 ==="
sleep 3
main=$(pgrep -af 'node src/bridge.js' | grep -v 'bash -c' || true)
echo "进程: $main"
echo "PPID=1 实例数: $(pgrep -f 'node src/bridge.js' | while read p; do [ "$(awk '{print $4}' /proc/$p/stat 2>/dev/null)" = "1" ] && echo x; done | wc -l)"
echo "锁: $(cat "$SRC/state/bridge.lock" 2>/dev/null | tr -d '\n')"
echo "端口 3100: $(ss -ltnp 2>/dev/null | grep -c ':3100 ')"

echo "=== 8. 状态文件未被破坏 ==="
python3 - <<'PY'
import json, os
p = '/opt/qq-bridge/state/social-v2.json'
d = json.load(open(p))
convs = d.get('conversations', d)
tot = sum(1 for v in convs.values() if isinstance(v, dict))
q = sum(1 for v in convs.values() if isinstance(v, dict) and ('pendingWakeReasons' in v))
print(f'会话 {tot} 个，仍带 pendingWakeReasons {q} 个（第 6 项成果应保留）')
s = '/opt/qq-bridge/state/slang-session.json'
print('slang-session.json:', ('存在 ' + str(os.path.getsize(s))) if os.path.exists(s) else '不存在')
PY

echo "=== 9. 启动日志（近 30 行） ==="
tail -30 "$SRC/state/bridge.log" 2>/dev/null || journalctl -u qq-bridge -n 30 --no-pager
echo "=== 启动错误扫描 ==="
tail -300 "$SRC/state/bridge.log" 2>/dev/null | grep -nE 'before initialization|ReferenceError|读取 socialV2 状态失败|SyntaxError|is not a function' || echo "(无 TDZ/引用错误)"
