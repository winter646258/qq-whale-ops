#!/usr/bin/env bash
# QQ 小鲸鱼 · provider 自动切换
#
# 逻辑：监控 qq-bridge 日志，CodeBuddy（buddy）连续失败 N 次 → 自动切到
#       DeepSeek 官方 API（deepseek-official），重启桥接，写日志。
#       不自动切回（额度恢复需人工确认）。
#
# 关键：用日志行数做水位线，只统计「上一次检查之后」新增的失败，
#       避免历史旧日志造成误触发。水位线随日志轮转同步重置。
#
# systemd 适配（2026-10-19）：
#   - 日志改到 /var/log/qqbridge.log（/tmp 会被 tmpfiles 清理，水位线会错乱）
#   - 重启桥接优先走 `systemctl restart qq-bridge.service`；没有 unit 时回退旧方式
#   - 自带按大小轮转，避免日志无限膨胀
#
# 用法：
#   bash /opt/qq-bridge/switch-provider.sh            # 后台守护（systemd 用这个）
#   bash /opt/qq-bridge/switch-provider.sh --once     # 只查一次
#   bash /opt/qq-bridge/switch-provider.sh --reset    # 重置水位线
#   bash /opt/qq-bridge/switch-provider.sh --status   # 打印当前状态
#
set -uo pipefail

CFG=/opt/qq-bridge/config.json
LOG=/var/log/qqbridge.log
SWLOG=/var/log/provider-switch.log
STATE=/opt/qq-bridge/state/provider-switch.json
WATERMARK=/opt/qq-bridge/state/.log-watermark

BRIDGE_UNIT=qq-bridge.service
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"
INTERVAL="${INTERVAL:-60}"
MAX_LOG_BYTES="${MAX_LOG_BYTES:-8388608}"   # 8 MiB，超出则轮转

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

# 按大小轮转日志：保留一个 .1 备份。轮转后旧行数失效，水位线立即归零。
rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || return 0
    : > "$LOG"
    log "日志已轮转（原 ${size} 字节 → ${LOG}.1），水位线重置到 0"
    echo 0 > "$WATERMARK"
  fi
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

has_bridge_unit() {
  systemctl list-unit-files 2>/dev/null | grep -q "^${BRIDGE_UNIT}[[:space:]]"
}

# 重启桥接：优先用 systemd，没有 unit 时回退到旧的 setsid nohup 方式。
restart_bridge() {
  if has_bridge_unit; then
    log "→ systemctl restart ${BRIDGE_UNIT}"
    systemctl restart "$BRIDGE_UNIT"
    return $?
  fi
  log "→ 回退方式：pkill + setsid nohup npm start"
  pkill -f "node src/bridge.js" 2>/dev/null
  sleep 3
  cd /opt/qq-bridge || return 1
  setsid nohup npm start > "$LOG" 2>&1 < /dev/null &
  disown
  return 0
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

  restart_bridge
  sleep 20

  log_lines > "$WATERMARK"

  # systemd 负责保活：有 unit 时看 unit 状态，否则看进程
  if has_bridge_unit; then
    if systemctl is-active --quiet "$BRIDGE_UNIT"; then
      log "✔ 桥接已用官方 API 重启（${BRIDGE_UNIT} active）"
    else
      log "✖ 桥接重启失败：${BRIDGE_UNIT} 非 active，请手动检查"
    fi
  elif pgrep -f "node src/bridge.js" >/dev/null; then
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
  rotate_log
  cur=$(current_provider)

  if [ "$cur" = "deepseek-official" ]; then
    log_lines > "$WATERMARK"
    return 0
  fi

  total=$(log_lines)
  wm=$(read_watermark)

  # 日志被轮转/截断过 ⇒ 水位线高于当前行数，直接对齐，不误判
  if [ "$total" -lt "$wm" ]; then
    echo "$total" > "$WATERMARK"
    return 0
  fi

  new_lines=$((total - wm))
  if [ "$new_lines" -le 0 ]; then
    return 0
  fi

  # 失败关键词。2026-10-19 补：原表漏了「限流」——CodeBuddy 全部账号被限流时
  # 桥接只把错误发到 QQ 会话、不写任何日志，关键词也没覆盖这种措辞，
  # 于是水位线判定「没有失败」，自动切换从不触发（实测被限流 1 小时没兜住）。
  # 配套改动：bridge.js 的 agent 错误分支现在会 log()，让失败真正进 stdout。
  hits=$(tail -n +$((wm + 1)) "$LOG" 2>/dev/null | grep -ciE \
    "unauthorized|quota|insufficient|balance|rate.?limit|额度不足|余额不足|发送失败|限流|解禁|所有账号|可用账号|AI 反馈.*error|agent 处理出错" || true)
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
  --status)
    echo "provider       = $(current_provider)"
    echo "日志           = $LOG"
    echo "日志行数       = $(log_lines)"
    echo "水位线         = $(read_watermark)"
    echo "距上次检查新增 = $(( $(log_lines) - $(read_watermark) )) 行"
    echo "阈值 / 间隔    = $FAIL_THRESHOLD 次 / ${INTERVAL}s"
    echo "桥接 unit      = $(systemctl is-active "$BRIDGE_UNIT" 2>/dev/null || echo n/a)"
    exit 0 ;;
esac

log "provider 自动切换守护启动（阈值=$FAIL_THRESHOLD，间隔=${INTERVAL}s，日志=$LOG，当前=$(current_provider)）"
read_watermark >/dev/null

trap 'log "收到停止信号，守护退出"; exit 0' TERM INT
while true; do
  check_once
  sleep "$INTERVAL"
done
