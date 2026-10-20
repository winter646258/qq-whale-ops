#!/usr/bin/env bash
# QQ 小鲸鱼 · provider 自动兜底（CodeBuddy 主 / TRAE 仅临时）
#
# ══ 2026-10-21 改版：从「双向交替」改成「单向兜底」══
#
# 改动原因（实测）：
#   trae 渠道的 prompt cache 命中率是 **0%**，而 buddy 是 **97.8%**。
#   实测 2026-10-20 22:00 → 10-21 06:00 期间：
#     buddy  205 次请求 | 未命中 109 万 | 命中 4912 万
#     trae   188 次请求 | 未命中 4750 万 | 命中 0
#   也就是 trae 每一轮都在拿 53 万 token 的新鲜上下文按全价计费。
#
#   根因不在我们的请求格式：trae 的 serializeTraeMessages() / transformToSOLOBody()
#   都不带 cache_control；buddy 的 adapter 里同样不带，但它的缓存是**上游自动开启**。
#   trae 走的是 SOLO 私有接口（/api/agent/v3/llm_utils_chat），没有这个机制。
#   ⇒ 改 vendored 代码去硬塞 cache_control 既脆弱（升级会被覆盖），上游也未必认。
#
# 所以 trae 的定位改成：
#   **只在 buddy 真失败时临时顶上，buddy 一恢复就立刻切回来。**
#
# 行为：
#   1. 当前是 buddy：连续失败 >= 阈值 → 临时切到 trae
#   2. 当前是 trae：
#      - 连续失败 >= 阈值 → trae 也不行，只记日志告警（**不再来回切**）
#      - 否则每 RECOVER_PROBE_INTERVAL 秒探一次主渠道，恢复就切回
#   3. 当前是别的（如 deepseek-official）→ 按主渠道 buddy 归位
#
# 用法：
#   bash /opt/qq-bridge/switch-provider.sh                 # 后台守护（systemd 用这个）
#   bash /opt/qq-bridge/switch-provider.sh --once          # 只查一次
#   bash /opt/qq-bridge/switch-provider.sh --status        # 打印当前状态
#   bash /opt/qq-bridge/switch-provider.sh --reset         # 重置水位线
#   bash /opt/qq-bridge/switch-provider.sh --force-buddy   # 立刻切回主渠道
#   bash /opt/qq-bridge/switch-provider.sh --probe         # 只探一次主渠道是否可用
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
MAX_LOG_BYTES="${MAX_LOG_BYTES:-8388608}"          # 8 MiB，超出则轮转
# 处于兜底渠道时，每隔多久探一次主渠道是否恢复（秒）。
# 5 分钟：既不会把 buddy 打爆，也能在它恢复后较快切回。
RECOVER_PROBE_INTERVAL="${RECOVER_PROBE_INTERVAL:-300}"

# ── 渠道定义：主渠道 A，兜底渠道 B ──────────────────────────────────────
A_PROVIDER=buddy; A_MODEL=deepseek-v4.1-flash; A_EFFORT=low
B_PROVIDER=trae;  B_MODEL=deepseek-v4.1-flash; B_EFFORT=high

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

rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || return 0
    : > "$LOG"
    log "日志已轮转（原 ${size} 字节 -> ${LOG}.1），水位线重置到 0"
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

restart_bridge() {
  if has_bridge_unit; then
    log "-> systemctl restart ${BRIDGE_UNIT}"
    systemctl restart "$BRIDGE_UNIT"
    return $?
  fi
  log "-> 回退方式：pkill + setsid nohup npm start"
  pkill -f "node src/bridge.js" 2>/dev/null
  sleep 3
  cd /opt/qq-bridge || return 1
  setsid nohup npm start > "$LOG" 2>&1 < /dev/null &
  disown
  return 0
}

# 写 config 并重启。$1=provider $2=model $3=effort
set_provider() {
  local np="$1" nm="$2" ne="$3"
  python3 - "$CFG" "$np" "$nm" "$ne" <<'PY'
import json, sys
p, np, nm, ne = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
c = json.load(open(p, encoding='utf-8'))
c['dsh']['provider'] = np
c['dsh']['model'] = nm
c['dsh']['reasoningEffort'] = ne
json.dump(c, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
  restart_bridge
  sleep 20
  log_lines > "$WATERMARK"
  if has_bridge_unit; then
    if systemctl is-active --quiet "$BRIDGE_UNIT"; then
      log "✔ 桥接已用 ${np} 重启"
      return 0
    fi
    log "✖ 桥接重启失败：${BRIDGE_UNIT} 非 active，请手动检查"
    return 1
  fi
  if pgrep -f "node src/bridge.js" >/dev/null; then
    log "✔ 桥接已用 ${np} 重启"
    return 0
  fi
  log "✖ 桥接重启失败，请手动检查"
  return 1
}

record_history() {
  python3 - "$STATE" "$1" "$2" "$3" <<'PY'
import json, sys, time
p, frm, to, reason = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    d = json.load(open(p))
except Exception:
    d = {}
d.setdefault('history', []).append({
    'at': int(time.time() * 1000),
    'from': frm,
    'to': to,
    'reason': reason,
})
d['lastSwitchAt'] = int(time.time() * 1000)
d['role'] = 'main' if to == 'buddy' else 'fallback'
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
PY
}

# ── 探测主渠道是否恢复 ───────────────────────────────────────────────────
# 关键：**不去打真实会话**（那会烧 token，也可能污染上下文）。
# 用 dsh 自己的模型目录接口探活：它会走到 provider 的凭据解析，
# buddy 的额度/限流问题会在这里暴露成明确失败。
#
# 注意这是「试探」而非「担保」：接口通只说明凭据链路正常，
# 真切回去后若连续失败 3 次会被再切回 trae —— 代价可控，不会死循环。
probe_buddy() {
  local port t resp code
  port=$(python3 -c "
import json
try: print(json.load(open('$CFG')).get('consolePort') or 3100)
except Exception: print(3100)
" 2>/dev/null)
  t=$([ -f /opt/qq-bridge/state/console-token ] && tr -d '\n' < /opt/qq-bridge/state/console-token || echo '')
  [ -z "$t" ] && { log "探测主渠道：读不到 console-token，判定不可用"; return 1; }

  resp=$(curl -s -m 8 -H "x-console-token: $t" "http://127.0.0.1:${port}/api/dsh/model" 2>/dev/null)
  code=$?
  if [ "$code" -ne 0 ] || [ -z "$resp" ]; then
    log "探测主渠道：接口无响应（curl exit=$code），判定不可用"
    return 1
  fi
  if echo "$resp" | grep -qiE '"error"|unauthorized|quota|insufficient|balance|rate.?limit|额度|限流'; then
    log "探测主渠道：接口返回错误或限流，判定不可用"
    return 1
  fi
  log "探测主渠道：接口正常，判为可用"
  return 0
}

# 是否到了该探测的时间（避免每 60s 都打一次）
should_probe() {
  local last now
  last=$(python3 -c "
import json
try: print(json.load(open('$STATE')).get('lastProbeAt') or 0)
except Exception: print(0)
" 2>/dev/null)
  now=$(date +%s)
  # lastProbeAt 存的是毫秒
  if [ $((now * 1000 - last)) -ge $((RECOVER_PROBE_INTERVAL * 1000)) ]; then
    python3 - "$STATE" <<'PY'
import json, sys, time
p = sys.argv[1]
try: d = json.load(open(p))
except Exception: d = {}
d['lastProbeAt'] = int(time.time() * 1000)
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
PY
    return 0
  fi
  return 1
}

check_once() {
  local cur total wm new_lines hits
  rotate_log
  cur=$(current_provider)

  # ── 不在两个渠道里：按主渠道归位 ──
  if [ "$cur" != "$A_PROVIDER" ] && [ "$cur" != "$B_PROVIDER" ]; then
    log "当前 provider 为 ${cur:-未知}，不在（${A_PROVIDER}/${B_PROVIDER}）内，按主渠道 ${A_PROVIDER} 归位"
    set_provider "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" && record_history "$cur" "$A_PROVIDER" 'not-in-pair'
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
    "unauthorized|quota|insufficient|balance|rate.?limit|额度不足|余额不足|发送失败|限流|解禁|所有账号|可用账号|AI 反馈.*error|agent 处理出错|Illegal API invocation|unapproved channel" || true)
  hits=${hits:-0}

  echo "$total" > "$WATERMARK"

  # ── 没到阈值 ──
  if [ "$hits" -lt "$FAIL_THRESHOLD" ]; then
    # 正处在兜底渠道时，趁这个机会看看主渠道恢复没有
    if [ "$cur" = "$B_PROVIDER" ] && should_probe; then
      if probe_buddy; then
        log "主渠道 ${A_PROVIDER} 已恢复 -> 切回（退出兜底）"
        set_provider "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" && record_history "$B_PROVIDER" "$A_PROVIDER" 'recovered'
      fi
    fi
    return 0
  fi

  # ── 到达失败阈值 ──
  if [ "$cur" = "$A_PROVIDER" ]; then
    log "新增 $new_lines 行中有 $hits 次失败（阈值 $FAIL_THRESHOLD）：主渠道 ${A_PROVIDER} 故障 -> 临时切到兜底 ${B_PROVIDER}"
    set_provider "$B_PROVIDER" "$B_MODEL" "$B_EFFORT" && record_history "$A_PROVIDER" "$B_PROVIDER" 'main-failed'
  else
    # 已在兜底渠道还继续失败 —— 不再来回切，只告警。
    # 来回切只会让两边都跑不稳，而且每次切换都要重启桥接（丢主动计时器）。
    log "⚠️ 已处于兜底渠道 ${B_PROVIDER} 且持续失败（$hits 次），不再切换；请人工检查主渠道额度与兜底账号"
    record_history "$B_PROVIDER" "$B_PROVIDER" 'fallback-also-failing'
  fi
}

case "${1:-}" in
  --once)  check_once; exit 0 ;;
  --reset)
    log_lines > "$WATERMARK"
    log "水位线已重置到 $(cat "$WATERMARK")"
    exit 0 ;;
  --probe)
    if probe_buddy; then echo "主渠道 ${A_PROVIDER}: 可用"; exit 0; else echo "主渠道 ${A_PROVIDER}: 不可用"; exit 1; fi ;;
  --force-buddy)
    cur_before=$(current_provider)
    if [ "$cur_before" = "$A_PROVIDER" ]; then
      echo "已经是 ${A_PROVIDER}，无需切换"
      exit 0
    fi
    log "人工要求切回主渠道 ${A_PROVIDER}（当前 ${cur_before:-未知}）"
    set_provider "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" && record_history "$cur_before" "$A_PROVIDER" 'manual'
    exit 0 ;;
  --status)
    printf 'provider       = %s\n' "$(current_provider)"
    printf '角色           = %s\n' "$([ "$(current_provider)" = "$A_PROVIDER" ] && echo '主渠道' || echo '兜底（临时）')"
    printf '主渠道         = %s（%s / %s）\n' "$A_PROVIDER" "$A_MODEL" "$A_EFFORT"
    printf '兜底渠道       = %s（%s / %s，仅主渠道故障时临时顶上）\n' "$B_PROVIDER" "$B_MODEL" "$B_EFFORT"
    printf '日志           = %s\n' "$LOG"
    printf '日志行数       = %s\n' "$(log_lines)"
    printf '水位线         = %s\n' "$(read_watermark)"
    printf '距上次检查新增 = %s 行\n' "$(( $(log_lines) - $(read_watermark) ))"
    printf '阈值 / 间隔    = %s 次 / %ss\n' "$FAIL_THRESHOLD" "$INTERVAL"
    printf '恢复探测间隔   = %ss（仅处于兜底时）\n' "$RECOVER_PROBE_INTERVAL"
    printf '桥接 unit      = %s\n' "$(systemctl is-active "$BRIDGE_UNIT" 2>/dev/null || echo n/a)"
    exit 0 ;;
esac

log "provider 自动兜底守护启动（主 ${A_PROVIDER}，兜底 ${B_PROVIDER} 仅故障时临时用；阈值=$FAIL_THRESHOLD，间隔=${INTERVAL}s，恢复探测=${RECOVER_PROBE_INTERVAL}s，当前=$(current_provider)）"
read_watermark >/dev/null

trap 'log "收到停止信号，守护退出"; exit 0' TERM INT
while true; do
  check_once
  sleep "$INTERVAL"
done
