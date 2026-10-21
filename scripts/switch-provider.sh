#!/usr/bin/env bash
# QQ 小鲸鱼 · provider 自动兜底守护
#
# 主渠道：buddy（CodeBuddy/腾讯）  deepseek-v4.1-flash  effort=low
# 兜底渠道：trae（TRAE/字节）      deepseek-v4.1-flash  effort=high
#
# ── 定位（2026-10-21 定稿）────────────────────────────────────────────────
#
#   trae 只做**临时兜底**：buddy 真失败时顶上，buddy 恢复就立刻切回。
#   它不是平级渠道 —— 实测 trae 的 prompt cache 命中率是 0%，
#   每轮按 53 万 token 全价计费；buddy 是 97.8%。
#   根因是 trae 走 SOLO 私有接口，上游没有自动缓存机制（不是我们的请求格式问题）。
#
# ── 2026-10-21 重要修复：失败统计从「水位线」改成「滑动窗口」──────────────
#
# 旧逻辑（有致命缺陷）：
#   每次检查先把水位线推到日志最新，再数「本次新增」里的失败。
#   而真实故障是稀疏的（每分钟 1 条），每次检查只落进 1 条，永远凑不到阈值 3
#   ⇒ 兜底从来不触发。实测 2026-10-21 08:02–08:07 连发 5 次失败，一条都没拦住。
#
# 新逻辑：
#   统计「最近 WINDOW_SEC 秒内」的失败条数，与检查频率无关。
#   只要 10 分钟窗口里累计 3 条失败，就触发兜底。
#
# ⚠️ 日志时间戳只有 HH:MM:SS（没有日期），所以跨午夜要特殊处理：
#   用日志文件 mtime 推「这份日志最后写入是哪天」，
#   再把每条 HH:MM:SS 的秒偏移与当前秒偏移比较；超过的视为前一天。
#
# ── 保留的能力 ────────────────────────────────────────────────────────────
#   --once / --status / --count / --reset / --force-buddy / --probe
#   单向兜底 + 恢复探测 + 不来回切 + 切换冷却
#   systemd 是唯一进程所有者：识别不到 unit 就硬失败，绝不起野进程
#   切换后做状态校验（单实例 / PPID=1 / 锁一致 / 端口在听）
# ═══════════════════════════════════════════════════════════════════════════
set -uo pipefail

CFG=/opt/qq-bridge/config.json
LOG=/var/log/qqbridge.log
SWLOG=/var/log/provider-switch.log
STATE=/opt/qq-bridge/state/provider-switch.json

BRIDGE_UNIT=qq-bridge.service

# ── 可调参数（集中定义，避免散落）─────────────────────────────────────────
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"        # 窗口内达到这么多条才切
INTERVAL="${INTERVAL:-60}"                   # 检查间隔（秒）
WINDOW_SEC="${WINDOW_SEC:-600}"              # 滑动窗口长度（秒）
RECOVER_PROBE_INTERVAL="${RECOVER_PROBE_INTERVAL:-300}"  # 兜底期间探测主渠道的间隔
SWITCH_COOLDOWN_SEC="${SWITCH_COOLDOWN_SEC:-180}"        # 切换冷却，防抖动
MAX_LOG_BYTES="${MAX_LOG_BYTES:-8388608}"    # 日志轮转大小

# 失败关键词。2026-10-19 补「限流」；2026-10-21 补渠道白名单相关。
FAIL_PATTERN="unauthorized|quota|insufficient|balance|rate.?limit|额度不足|余额不足|发送失败|限流|解禁|所有账号|可用账号|AI 反馈.*error|agent 处理出错|Illegal API invocation|unapproved channel"

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

# ── 日志轮转 ──────────────────────────────────────────────────────────────
rotate_log() {
  [ -f "$LOG" ] || return 0
  local size
  size=$(stat -c %s "$LOG" 2>/dev/null || echo 0)
  if [ "$size" -gt "$MAX_LOG_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || return 0
    : > "$LOG"
    log "日志已轮转（原 ${size} 字节 -> ${LOG}.1）"
  fi
}

# ── 滑动窗口统计失败数 ────────────────────────────────────────────────────
# 输出：窗口内的失败条数。
# 时间处理：日志只有 HH:MM:SS，用日志 mtime 的日期做基准日；
#          若某行秒偏移 > 当前秒偏移（+60s 容差），视为前一天（跨午夜）。
count_recent_failures() {
  [ -f "$LOG" ] || { echo 0; return 0; }

  local now_epoch window_start mtime base_day_epoch now_day_epoch now_sec
  now_epoch=$(date +%s)
  window_start=$((now_epoch - WINDOW_SEC))

  mtime=$(stat -c %Y "$LOG" 2>/dev/null || echo "$now_epoch")
  base_day_epoch=$(date -d "$(date -d "@$mtime" '+%F') 00:00:00" '+%s' 2>/dev/null || echo 0)
  now_day_epoch=$(date -d "$(date -d "@$now_epoch" '+%F') 00:00:00" '+%s' 2>/dev/null || echo 0)
  now_sec=$(( now_epoch - now_day_epoch ))

  awk -v since="$window_start" -v now="$now_epoch" \
      -v base="$base_day_epoch" -v nowsec="$now_sec" \
      -v pat="$FAIL_PATTERN" '
    BEGIN { cnt = 0 }
    {
      if (match($0, /^([0-9][0-9]):([0-9][0-9]):([0-9][0-9]) /, m) == 0) next
      sec = (m[1] + 0) * 3600 + (m[2] + 0) * 60 + (m[3] + 0)
      abs = base + sec
      # 跨午夜：该行秒偏移大于「现在」，说明写在前一天
      if (base > 0 && sec > nowsec + 60) abs = base - 86400 + sec
      if (abs < since || abs > now + 60) next
      line = tolower($0)
      n = split(pat, kw, "|")
      for (i = 1; i <= n; i++) {
        k = tolower(kw[i])
        if (k == "") continue
        if (index(line, k) > 0) { cnt++; break }
      }
    }
    END { print cnt + 0 }
  ' "$LOG" 2>/dev/null || echo 0
}

# ── systemd 归属判定 ──────────────────────────────────────────────────────
has_bridge_unit() {
  # ⚠️ 2026-10-21 修复：原来用
  #     systemctl list-unit-files | grep -q "^${BRIDGE_UNIT}[[:space:]]"
  # 实测该判断返回**假**（虽然 unit 确实存在），于是走到 pkill+setsid 分支，
  # 把桥接从 systemd 里摘出去 —— 野进程占锁 + 端口，systemd 无限 activating。
  # 换成 systemctl cat：unit 文件存在即成功，判据单一、不依赖输出排版。
  systemctl cat "$BRIDGE_UNIT" >/dev/null 2>&1
}

restart_bridge() {
  if ! has_bridge_unit; then
    # ⚠️ 故意不提供 pkill+setsid 回退。
    # 回退分支会起脱离 systemd 的野进程，占住 bridge.lock 与端口 3100，
    # 导致 systemd 再拉正式实例时被锁挡住、无限 activating。
    # 找不到 unit 就明确报错让管理员处理，绝不自己起野进程。
    log "✖ 找不到 ${BRIDGE_UNIT}：拒绝用 pkill+setsid 起野进程（会占锁导致 systemd 无限重启）。请先确认 unit 已安装：systemctl cat ${BRIDGE_UNIT}"
    return 1
  fi
  log "-> systemctl restart ${BRIDGE_UNIT}"
  systemctl restart "$BRIDGE_UNIT"
  return $?
}

# ── 切换后状态校验 ────────────────────────────────────────────────────────
verify_bridge_state() {
  local main ppid cnt lock port
  main=$(systemctl show "$BRIDGE_UNIT" -p MainPID --value 2>/dev/null)
  if [ -z "$main" ] || [ "$main" = "0" ]; then
    log "✖ 校验失败：MainPID=${main:-空}（服务未运行）"
    return 1
  fi

  ppid=$(ps -o ppid= -p "$main" 2>/dev/null | tr -d ' ')
  if [ "$ppid" != "1" ]; then
    log "✖ 校验失败：MainPID $main 的 PPID=$ppid，不是 systemd"
    return 1
  fi

  # ⚠️ 数实例不能用 `pgrep -c -f 'node src/bridge.js'`：
  # 它会把**调用者自己的命令行**也匹配进去（比如 `bash -c "...pgrep -f 'node src/bridge.js'..."`），
  # 于是永远多算 1 个，导致校验误报「有 2 个实例」。
  # （交接文档把这条列为已知坑，我们这里同样踩了一次。）
  #
  # 改成：只数「cmd 是 node 且 PPID=1」的真正 systemd 托管实例。
  cnt=$(ps -eo pid,ppid,args --no-headers 2>/dev/null \
        | awk '$2 == 1 && $3 ~ /(^|\/)node$/ && /src\/bridge\.js/ {n++} END {print n+0}')
  if [ "$cnt" -ne 1 ]; then
    log "✖ 校验失败：有 $cnt 个由 systemd 托管的 bridge 实例（预期 1）"
    return 1
  fi

  lock=$(cat /opt/qq-bridge/state/bridge.lock 2>/dev/null | tr -d ' \n')
  if [ -n "$lock" ] && [ "$lock" != "$main" ]; then
    log "✖ 校验失败：锁文件 PID=$lock 与 MainPID=$main 不一致"
    return 1
  fi

  port=$(ss -tlnH 2>/dev/null | grep -c ':3100' || true)
  if [ "${port:-0}" -lt 1 ]; then
    log "✖ 校验失败：端口 3100 未监听"
    return 1
  fi

  log "✔ 状态校验通过：MainPID=$main PPID=1 实例=1 锁=${lock:-无} 端口=活"
  return 0
}

# ── 写 config 并重启 ──────────────────────────────────────────────────────
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
  sleep 18
  verify_bridge_state || log "⚠️ 切换后状态校验未通过，请人工检查（见上方原因）"
  return 0
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

# ── 探测主渠道是否恢复 ────────────────────────────────────────────────────
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

should_probe() {
  local last now
  last=$(python3 -c "
import json
try: print(json.load(open('$STATE')).get('lastProbeAt') or 0)
except Exception: print(0)
" 2>/dev/null)
  now=$(date +%s)
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

# 切换冷却：刚切过就不要再切（防抖动）
in_cooldown() {
  local last now
  last=$(python3 -c "
import json
try: print(json.load(open('$STATE')).get('lastSwitchAt') or 0)
except Exception: print(0)
" 2>/dev/null)
  now=$(date +%s)
  [ $((now - last / 1000)) -lt "$SWITCH_COOLDOWN_SEC" ]
}

# ── 一次完整检查 ──────────────────────────────────────────────────────────
check_once() {
  local cur hits
  rotate_log
  cur=$(current_provider)

  # 不在两个渠道里：按主渠道归位
  if [ "$cur" != "$A_PROVIDER" ] && [ "$cur" != "$B_PROVIDER" ]; then
    log "当前 provider 为 ${cur:-未知}，不在（${A_PROVIDER}/${B_PROVIDER}）内，按主渠道 ${A_PROVIDER} 归位"
    set_provider "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" && record_history "$cur" "$A_PROVIDER" 'not-in-pair'
    return 0
  fi

  hits=$(count_recent_failures)
  hits=${hits:-0}

  # 没到阈值
  if [ "$hits" -lt "$FAIL_THRESHOLD" ]; then
    if [ "$cur" = "$B_PROVIDER" ] && should_probe; then
      if probe_buddy; then
        log "主渠道 ${A_PROVIDER} 已恢复 -> 切回（退出兜底）"
        set_provider "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" && record_history "$B_PROVIDER" "$A_PROVIDER" 'recovered'
      fi
    fi
    return 0
  fi

  # 到了阈值
  if [ "$cur" = "$A_PROVIDER" ]; then
    if in_cooldown; then
      log "窗口内失败 ${hits} 条（阈值 ${FAIL_THRESHOLD}），但仍在切换冷却（${SWITCH_COOLDOWN_SEC}s）内，暂不切换"
      return 0
    fi
    log "最近 ${WINDOW_SEC}s 内有 ${hits} 条失败（阈值 ${FAIL_THRESHOLD}）：主渠道 ${A_PROVIDER} 故障 -> 临时切到兜底 ${B_PROVIDER}"
    set_provider "$B_PROVIDER" "$B_MODEL" "$B_EFFORT" && record_history "$A_PROVIDER" "$B_PROVIDER" 'main-failed'
  else
    log "⚠️ 已处于兜底渠道 ${B_PROVIDER} 且窗口内仍有 ${hits} 条失败，不再切换；请人工检查主渠道额度与兜底账号"
    record_history "$B_PROVIDER" "$B_PROVIDER" 'fallback-also-failing'
  fi
}

case "${1:-}" in
  --once)  check_once; exit 0 ;;
  --reset)
    log "失败统计已改滑动窗口，无水位线可重置；仅清理探测/切换冷却"
    python3 - "$STATE" <<'PY'
import json, sys
p = sys.argv[1]
try: d = json.load(open(p))
except Exception: d = {}
d['lastProbeAt'] = 0
d['lastSwitchAt'] = 0
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
print('已重置探测与切换冷却')
PY
    exit 0 ;;
  --probe)
    if probe_buddy; then echo "主渠道 ${A_PROVIDER}: 可用"; exit 0; else echo "主渠道 ${A_PROVIDER}: 不可用"; exit 1; fi ;;
  --count)
    echo "最近 ${WINDOW_SEC}s 内失败数 = $(count_recent_failures)（阈值 ${FAIL_THRESHOLD}）"
    exit 0 ;;
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
    printf '失败统计       = 滑动窗口 %ss 内 >= %s 条\n' "$WINDOW_SEC" "$FAIL_THRESHOLD"
    printf '当前窗口内失败 = %s 条\n' "$(count_recent_failures)"
    printf '检查间隔       = %ss\n' "$INTERVAL"
    printf '切换冷却       = %ss\n' "$SWITCH_COOLDOWN_SEC"
    printf '恢复探测间隔   = %ss（仅处于兜底时）\n' "$RECOVER_PROBE_INTERVAL"
    printf '桥接 unit      = %s\n' "$(systemctl is-active "$BRIDGE_UNIT" 2>/dev/null || echo n/a)"
    exit 0 ;;
esac

log "provider 自动兜底守护启动（主 ${A_PROVIDER}，兜底 ${B_PROVIDER} 仅故障时临时用；滑动窗口=${WINDOW_SEC}s 阈值=${FAIL_THRESHOLD} 检查=${INTERVAL}s 冷却=${SWITCH_COOLDOWN_SEC}s 恢复探测=${RECOVER_PROBE_INTERVAL}s；当前=$(current_provider)）"

trap 'log "收到停止信号，守护退出"; exit 0' TERM INT
while true; do
  check_once
  sleep "$INTERVAL"
done
