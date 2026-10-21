#!/bin/bash
# 把 QQ 机器人的模型渠道切到 LoomY(主) / Raccoon(备)，并解开群 906710082 的禁用。
# 可重复执行（幂等）：已改过的部分会跳过。
set -u
STAMP=$(date +%Y%m%d-%H%M%S)
B=/opt/qq-bridge
SRC=$B/src/bridge.js
CFG=$B/config.json
EXEC=$(systemctl cat qq-provider-switch 2>/dev/null | grep -oE 'ExecStart=.*' | head -1 | cut -d= -f2-)
SW=$(printf '%s\n' $EXEC | grep -E '\.sh$' | head -1)
[ -z "$SW" ] && SW="$B/scripts/switch-provider.sh"
[ -f "$SW" ] || { echo "❌ 找不到 switch 脚本（ExecStart=$EXEC）"; exit 1; }
echo "switch 脚本: $SW"

fail() { echo "❌ $*"; exit 1; }

# ── 0. 备份 ───────────────────────────────────────────────────────────────
cp -a "$SRC" "$SRC.bak-loomy-$STAMP"
cp -a "$CFG" "$CFG.bak-loomy-$STAMP"
cp -a "$SW"  "$SW.bak-loomy-$STAMP"
echo "✔ 备份: $SRC.bak-loomy-$STAMP / config.json.bak-loomy-$STAMP / $(basename "$SW").bak-loomy-$STAMP"

# ── 1. 探测脚本就位 ──────────────────────────────────────────────────────
if [ -f /tmp/probe-model.mjs ]; then
  install -m 644 /tmp/probe-model.mjs "$B/scripts/probe-model.mjs"
  echo "✔ 安装 scripts/probe-model.mjs"
else
  echo "⚠️ /tmp/probe-model.mjs 不存在，跳过安装（真实探测会因此不可用）"
fi

# ── 2. switch-provider.sh：渠道对 + role 判定 + 真探测 ───────────────────
python3 - "$SW" <<'PY' || fail "switch-provider.sh 改写失败"
import re, sys
p = sys.argv[1]
src = open(p, encoding='utf-8').read()
orig = src

# 2a. 渠道对：LoomY 主 / Raccoon 备
src = re.sub(r'^A_PROVIDER=.*$',
             'A_PROVIDER=loomy; A_MODEL=DeepSeek-V4.1-Flash; A_EFFORT=low',
             src, count=1, flags=re.M)
src = re.sub(r'^B_PROVIDER=.*$',
             'B_PROVIDER=raccoon; B_MODEL=sn-deepseek-v4-1-flash; B_EFFORT=on',
             src, count=1, flags=re.M)

# 2b. role 判定写死了 'buddy'，切到 loomy 后会永远记成 fallback
src = src.replace("d['role'] = 'main' if to == 'buddy' else 'fallback'",
                  "d['role'] = 'main' if to == main_provider else 'fallback'")
src = src.replace('python3 - "$STATE" "$1" "$2" "$3" <<\'PY\'',
                  'python3 - "$STATE" "$1" "$2" "$3" "$A_PROVIDER" <<\'PY\'')
if 'main_provider' in src and 'main_provider = ' not in src:
    src = src.replace("p, frm, to, reason = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]",
                      "p, frm, to, reason, main_provider = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]")

# 2c. 假探测（只 curl 本地控制台，根本没碰上游）换成真实模型调用
start = src.find('probe_buddy() {')
end = src.find('should_probe() {')
if start != -1 and end != -1 and start < end:
    newfn = '''probe_primary() {
  # 旧实现只 curl 本地 /api/dsh/model 看控制台能不能报出模型，**从未碰过上游**，
  # 所以主渠道实际还在报错时也会判「已恢复」（实测 09:02:11 判恢复、09:02:14 又失败）。
  # 现在改成发一次真实的最小请求：只有上游真的回了文本才算可用。
  local script="$B/scripts/probe-model.mjs"
  [ -f "$script" ] || { log "探测主渠道：找不到 $script，判定不可用（不冒险切回）"; return 1; }
  local out rc
  out=$(cd "$B" && timeout 90 node "$script" "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" 70 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    log "探测主渠道：真实调用成功 -> $A_PROVIDER/$A_MODEL 可用"
    return 0
  fi
  log "探测主渠道：真实调用失败（exit=$rc）：$(echo "$out" | tail -2 | tr '\\n' ' ')"
  return 1
}

'''
    src = src[:start] + newfn + src[end:]
src = src.replace('if probe_buddy; then', 'if probe_primary; then')
src = src.replace('probe_buddy()', 'probe_primary()')

if src == orig:
    print('（switch-provider.sh 已是目标状态，无改动）')
else:
    open(p, 'w', encoding='utf-8').write(src)
    print('✔ switch-provider.sh 已改写')
PY

grep -q '^A_PROVIDER=loomy' "$SW" || fail "A_PROVIDER 未改成 loomy"
grep -q 'probe_primary' "$SW" || fail "真实探测未替换成功"
bash -n "$SW" || fail "switch-provider.sh 语法检查未通过"
echo "✔ switch-provider.sh 语法 OK"

# ── 3. bridge.js：放开思考强度白名单（Raccoon 用 on/off、Loomy 有 none/medium/xhigh）──
python3 - "$SRC" <<'PY' || fail "bridge.js 改写失败"
import sys
p = sys.argv[1]
src = open(p, encoding='utf-8').read()
old = "const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];"
new = ("// 各渠道的档位 id 并不统一：deepseek-official/buddy 是 low/high/max，Loomy 是\n"
       "// none/low/medium/high/xhigh，Raccoon 是 on/off，trae 是 light/high/extra_high。\n"
       "// 旧白名单只有 low/high/max，会把 config.json 里合法的渠道档位判成非法、静默回退成\n"
       "// max，接着让每条消息的 selectModel 都失败。这里放宽成已知档位的并集；真正的合法性\n"
       "// 由 DSH 的模型目录裁决（非法档位会在 selectModel 报错并写日志），不再由桥接替它猜。\n"
       "const REASONING_EFFORT_OPTIONS = ['none', 'off', 'on', 'light', 'low', 'medium', 'high', 'xhigh', 'extra_high', 'max'];")
if old in src:
    open(p, 'w', encoding='utf-8').write(src.replace(old, new, 1))
    print('✔ 强度白名单已放开')
elif 'extra_high' in src:
    print('（强度白名单已是目标状态，跳过）')
else:
    print('❌ 找不到强度白名单那一行')
    sys.exit(1)
PY
node --check "$SRC" || fail "bridge.js 语法检查未通过"
echo "✔ bridge.js 语法 OK"

# ── 4. config.json：换渠道 + 解开群 906710082 ────────────────────────────
python3 - "$CFG" <<'PY' || fail "config.json 改写失败"
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding='utf-8'))
c.setdefault('dsh', {})
before = (c['dsh'].get('provider'), c['dsh'].get('model'), c['dsh'].get('reasoningEffort'))
c['dsh']['provider'] = 'loomy'
c['dsh']['model'] = 'DeepSeek-V4.1-Flash'
c['dsh']['reasoningEffort'] = 'low'
deny = c.setdefault('deny', {})
groups = [str(g) for g in (deny.get('groups') or [])]
removed = [g for g in groups if g == '906710082']
deny['groups'] = [g for g in groups if g != '906710082']
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('  渠道:', before, '->', (c['dsh']['provider'], c['dsh']['model'], c['dsh']['reasoningEffort']))
print('  deny.groups:', groups, '->', deny['groups'], ('（解开 906710082）' if removed else ''))
PY

# ── 5. 重启 + 验证 ──────────────────────────────────────────────────────
systemctl restart qq-bridge
sleep 12
echo
echo "=== 服务状态 ==="
systemctl is-active qq-bridge qq-dsh qq-provider-switch | paste -sd' ' -
echo "实例数(PPID=1 的 node src/bridge.js): $(pgrep -af 'node src/bridge.js' | awk '$2==1||$3==1' | wc -l)"
[ -f "$B/state/bridge.lock" ] && echo "lock: $(cat "$B/state/bridge.lock")"
ss -ltn 2>/dev/null | grep -q ':3100' && echo "端口 3100: 在听" || echo "端口 3100: 未监听 ⚠️"

echo
echo "=== /api/dsh/model ==="
T=$(tr -d '\n' < "$B/state/console-token" 2>/dev/null)
curl -s -m 8 -H "x-console-token: $T" "http://127.0.0.1:3100/api/dsh/model" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    print('  解析失败'); raise SystemExit
print('  provider =', d.get('provider'), '| model =', d.get('model'), '| effort =', d.get('reasoningEffort'))
print('  options  =', d.get('options'), '| catalogSource =', d.get('catalogSource'))
"

echo
echo "=== 启动日志（末 14 行） ==="
tail -14 /var/log/qqbridge.log 2>/dev/null || journalctl -u qq-bridge -n 14 --no-pager
