#!/bin/bash
# 把 provider 真正切成 LoomY 主 / Raccoon 备，并堵住「守护进程用旧常量把配置改回 buddy」
set -u
B=/opt/qq-bridge
SW=$B/switch-provider.sh
CFG=$B/config.json

echo "=== 1. 停掉守护进程（它是 08:41 启动的，内存里还是 buddy/trae） ==="
systemctl stop qq-provider-switch
sleep 1
systemctl is-active qq-provider-switch || true

echo
echo "=== 2. 给 count_recent_failures 加窗口夹紧（不继承旧渠道的失败） ==="
python3 - "$SW" <<'PY'
import sys
p = sys.argv[1]
t = open(p, encoding='utf-8').read()
old = "  window_start=$((now_epoch - WINDOW_SEC))\n"
new = old + """  # 2026-10-21：窗口起点不早于上次切换时刻 —— 否则新渠道一上来就继承旧渠道的失败数，
  # 刚切过去就被判"主渠道故障"再切走（12:24 与 12:28 两次回退都是这个原因）。
  local _lsw _lsw_s
  _lsw=$(python3 -c "import json;print(json.load(open('$STATE')).get('lastSwitchAt') or 0)" 2>/dev/null || echo 0)
  if [ "${_lsw:-0}" -gt 0 ] 2>/dev/null; then
    _lsw_s=$((_lsw / 1000))
    [ "$_lsw_s" -gt "$window_start" ] && window_start=$_lsw_s
  fi
"""
if old not in t:
    print("✖ 找不到 window_start 行，未改")
    sys.exit(1)
if "_lsw_s" in t:
    print("· 已打过补丁，跳过")
else:
    t = t.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(t)
    print("✔ 已加窗口夹紧")
PY
bash -n "$SW" && echo "✔ 语法 OK"

echo
echo "=== 3. 配置改成 loomy 主 ==="
python3 - "$CFG" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p, encoding='utf-8'))
before = dict(c['dsh'])
c['dsh']['provider'] = 'loomy'
c['dsh']['model'] = 'DeepSeek-V4.1-Flash'
c['dsh']['reasoningEffort'] = 'low'
c.setdefault('deny', {})['groups'] = []
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print("channels:", before.get('provider'), '->', c['dsh']['provider'], '|', c['dsh']['model'], '|', c['dsh']['reasoningEffort'])
print("deny.groups:", c['deny']['groups'])
PY

echo
echo "=== 4. 重启桥接并验活 ==="
systemctl restart qq-bridge
sleep 12
TOKEN=$(cat $B/state/console-token)
curl -s -m 10 -H "x-console-token: $TOKEN" http://127.0.0.1:3100/api/dsh/model | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('provider =', d.get('provider'), '| model =', d.get('model'), '| effort =', d.get('reasoningEffort'))
print('options  =', d.get('options'), '| catalogSource =', d.get('catalogSource'))
"
echo "--- 实例/端口 ---"
pgrep -af "node .*src/bridge.js" | grep -v pgrep
ss -ltn 2>/dev/null | grep -q ':3100' && echo "端口 3100 在听"

echo
echo "=== 5. 启动守护进程（读新常量 loomy/raccoon） ==="
systemctl start qq-provider-switch
sleep 3
systemctl is-active qq-provider-switch
echo "--- 守护进程首行启动日志 ---"
tail -3 /var/log/provider-switch.log

echo
echo "=== 6. 等一个检查周期（70s），看是否还会被改回 ==="
sleep 70
echo "--- config 现状 ---"
python3 -c "
import json
c=json.load(open('$CFG'))
print('provider =', c['dsh']['provider'], '| model =', c['dsh']['model'], '| effort =', c['dsh']['reasoningEffort'])
"
echo "--- 守护日志 ---"
tail -6 /var/log/provider-switch.log
