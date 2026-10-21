#!/bin/bash
# 第 5、6 项上线：备份 → 替换 → 语法检查 → 重启 → 验活
set -u
SRC=/opt/qq-bridge
TS=$(date +%Y%m%d-%H%M%S)
BAK="$SRC/src/bridge.js.bak-item56-$TS"

echo "=== 1. 备份 ==="
cp "$SRC/src/bridge.js" "$BAK" && echo "备份 -> $BAK ($(stat -c%s "$BAK") 字节)"

echo "=== 2. 替换 ==="
cp /tmp/bridge-patched.js "$SRC/src/bridge.js"
chown root:root "$SRC/src/bridge.js" 2>/dev/null
chmod 644 "$SRC/src/bridge.js"
echo "新文件 $(stat -c%s "$SRC/src/bridge.js") 字节"

echo "=== 3. 语法检查 ==="
if ! node --check "$SRC/src/bridge.js"; then
  echo "!! 语法检查失败，回滚"
  cp "$BAK" "$SRC/src/bridge.js"
  exit 1
fi
echo "语法 OK"

echo "=== 4. 关键改动确认 ==="
for pat in 'MARKER: poke-target' 'MARKER: busy-queue' 'MARKER: proactive-persist' 'function enqueuePendingWake' 'function sweepPendingWakeReasons' 'pendingWakeReasons:' 'proactiveNextAt:'; do
  printf '  %-34s %s\n' "$pat" "$(grep -c "$pat" "$SRC/src/bridge.js")"
done
echo "  旧 FIFO 残留: $(grep -c 'st.pendingWakeReasons.push({ reason, seq });' "$SRC/src/bridge.js")"
echo "  旧出队残留: $(grep -c 'stEnd.pendingWakeReasons.shift()' "$SRC/src/bridge.js")"

echo "=== 5. 重启 qq-bridge ==="
systemctl restart qq-bridge
for i in $(seq 1 20); do
  sleep 2
  st=$(systemctl is-active qq-bridge)
  [ "$st" = "active" ] && break
done
echo "状态: $(systemctl is-active qq-bridge)"

echo "=== 6. 验活 ==="
sleep 3
main=$(pgrep -af 'node src/bridge.js' | grep -v 'bash -c' || true)
echo "进程:"; echo "$main"
echo "PPID=1 实例数: $(pgrep -f 'node src/bridge.js' | while read p; do [ "$(awk '{print $4}' /proc/$p/stat 2>/dev/null)" = "1" ] && echo x; done | wc -l)"
echo "锁: $(cat "$SRC/state/bridge.lock" 2>/dev/null | tr -d '\n') | 实际: $main"
echo "端口: $(ss -ltnp 2>/dev/null | grep -c ':3100 ')"

echo "=== 7. 状态文件是否已带上新字段 ==="
python3 - <<'PY'
import json
d = json.load(open('/opt/qq-bridge/state/social-v2.json'))
convs = d.get('conversations', d)
tot = 0
withq = 0
for k, v in convs.items():
    if not isinstance(v, dict):
        continue
    tot += 1
    if 'pendingWakeReasons' in v or 'proactiveNextAt' in v:
        withq += 1
print(f'会话 {tot} 个，已带新字段 {withq} 个')
for k, v in list(convs.items())[:4]:
    if isinstance(v, dict):
        print(' ', k, 'proactiveNextAt=', v.get('proactiveNextAt'), 'queue=', len(v.get('pendingWakeReasons') or []))
PY

echo "=== 8. 启动日志（近 40 行）==="
tail -40 "$SRC/state/bridge.log" 2>/dev/null || journalctl -u qq-bridge -n 40 --no-pager
echo "=== 启动错误扫描 ==="
tail -300 "$SRC/state/bridge.log" 2>/dev/null | grep -nE 'before initialization|ReferenceError|读取 socialV2 状态失败|TypeError' || echo "(无 TDZ/读取失败)"
