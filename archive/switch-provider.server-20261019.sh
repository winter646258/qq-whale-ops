#!/usr/bin/env bash
# QQ 小鲸鱼 · provider 自动切换
#
# 逻辑：监控 qq-bridge 日志，CodeBuddy（buddy）连续失败 N 次 → 自动切到
#       DeepSeek 官方 API（deepseek-official），重启桥接，写日志。
#       不自动切回（额度恢复需人工确认）。
#
# 关键：用日志行数做水位线，只统计「上一次检查之后」新增的失败，
#       避免历史旧日志造成误触发。
#
# 用法：
#   bash /opt/qq-bridge/switch-provider.sh            # 后台守护
#   bash /opt/qq-bridge/switch-provider.sh --once     # 只查一次
#   bash /opt/qq-bridge/switch-provider.sh --reset    # 重置水位线
#
set -uo pipefail

CFG=/opt/qq-bridge/config.json
LOG=/tmp/qqbridge.log
SWLOG=/var/log/provider-switch.log
STATE=/opt/qq-bridge/state/provider-switch.json
WATERMARK=/opt/qq-bridge/state/.log-watermark

FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
INTERVAL="${INTERVAL:-60}"

mkdir -p "$(dirname "$STATE")"
touch "$SWLOG"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$SWLOG"; }

current_provider() {
  python3 -c "
import json
c=json.load(open('$CFG'))
print(c['dsh'].get('provider',''))
" 2>/dev/null
}

log_lines() {
  [ -f "$LOG" ] && wc -l < "$LOG" | tr -d ' ' || echo 0
}

read_watermark() {
  if [ -f "$WATERMARK" ]; then
    cat "$WATERMARK" 2>/dev/null || echo 0
  else
    local n
    n=$(log_lines)
    echo "$n" > "$WATERMARK"
    echo "$n"
  fi
}

switch_to_official() {
  log "⚡ 触发切换：buddy -> deepseek-official"
  python3 - <<'PY'
import json
p='/opt/qq-bridge/config.json'
c=json.load(open(p, encoding='utf-8'))
c['dsh']['provider']='deepseek-official'
c['dsh']['model']='deepseek-flash'
c['dsh']['reasoningEffort']=c['dsh'].get('reasoningEffort') or 'max'
json.dump(c, open(p,'w',encoding='utf-8'), ensure_ascii=False, indent=2)
PY

  pkill -f "node src/bridge.js" 2>/dev/null
  sleep 3
  cd /opt/qq-bridge
  setsid nohup npm start > "$LOG" 2>&1 < /dev/null &
  disown
  sleep 20

  log_lines > "$WATERMARK"

  if pgrep -f "node src/bridge.js" >/dev/null; then
    log "✔ 桥接已用官方 API 重启"
  else
    log "✖ 桥接重启失败，请手动检查"
  fi

  python3 - "$STATE" <<'PY'
import json, sys, time
p=sys.argv[1]
try: d=json.load(open(p))
except Exception: d={}
d.setdefault('history', []).append({
    'at': int(time.time()*1000),
    'from': 'buddy',
    'to': 'deepseek-official',
    'reason': 'consecutive-failures',
})
json.dump(d, open(p,'w'), ensure_ascii=False, indent=2)
PY
}

check_once() {
  local cur total wm new_lines hits
  cur=$(current_provider)

  if [ "$cur" = "deepseek-official" ]; then
    log_lines > "$WATERMARK"
    return 0
  fi

  total=$(log_lines)
  wm=$(read_watermark)

  if [ "$total" -lt "$wm" ]; then
    echo "$total" > "$WATERMARK"
    return 0
  fi

  new_lines=$((total - wm))
  if [ "$new_lines" -le 0 ]; then
    return 0
  fi

  hits=$(tail -n +$((wm + 1)) "$LOG" 2>/dev/null | grep -ciE \
    "unauthorized|quota|insufficient|balance|额度不足|发送失败|AI 反馈.*error" || true)
  hits=${hits:-0}

  echo "$total" > "$WATERMARK"

  if [ "$hits" -ge "$FAIL_THRESHOLD" ]; then
    log "新增 $new_lines 行中有 $hits 次失败（阈值 $FAIL_THRESHOLD），准备切换"
    switch_to_official
  fi
}

case "${1:-}" in
  --once)  check_once; exit 0 ;;
  --reset)
    log_lines > "$WATERMARK"
    log "水位线已重置到 $(cat "$WATERMARK")"
    exit 0 ;;
esac

log "provider 自动切换守护启动（阈值=$FAIL_THRESHOLD，间隔=${INTERVAL}s，当前=$(current_provider)）"
read_watermark >/dev/null
while true; do
  check_once
  sleep "$INTERVAL"
done
