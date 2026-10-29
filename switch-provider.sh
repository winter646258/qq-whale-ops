#!/usr/bin/env bash
# QQ 小鲸鱼 · provider 自动兜底守护
#
# 候选链（2026-10-22 起从「二元兜底」改成「多级降级」）：
#   第 0 级 loomy    DeepSeek-V4.1-Flash      effort=low    快（首字 ~1.7s），cache 命中率高
#   第 1 级 trae     deepseek-v4.1-flash      effort=light  快（~2.2s），但 cache 命中率 0%
#   第 2 级 raccoon  sn-deepseek-v4-1-flash   effort=on     慢（~29s），但 cache 命中率高、省 token
#   第 3 级 raccoon 之后追加：
#   ※ 2026-10-24 15:20 起把 our-free-model（windking 中转 https://ai.windking.shop/v1，
#     模型 deepseek/deepseek-v4.1-flash，effort=light）放到链首 —— 免费渠道额度用尽，
#     主人给了中转 key，临时用它兜住。要回退就把它从三个数组里删掉。
#
# 顺序的理由：能快就别拖。trae 排在前是因为它快；raccoon 排最后是因为它慢但省，
# 长期挂着也不心疼。三者都免费，所以「降级」不产生额外花费。
#
# 降级触发有两种：窗口内失败数达标（报错），或首字延迟连续偏慢（能回但太慢）。
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
BRIDGE_DIR=/opt/qq-bridge

BRIDGE_UNIT=qq-bridge.service

# ── 可调参数（集中定义，避免散落）─────────────────────────────────────────
FAIL_THRESHOLD="${FAIL_THRESHOLD:-3}"        # 窗口内达到这么多条才切
INTERVAL="${INTERVAL:-60}"                   # 检查间隔（秒）
WINDOW_SEC="${WINDOW_SEC:-600}"              # 滑动窗口长度（秒）
# 2026-10-29 P1-1：重启风暴。上游是秒级抖动（502/521 六秒就过去），
# 旧参数下「降级 -> 300 秒后探通 -> 切回 -> 又抖 -> 再降级」成了死循环，
# 一天把 qq-bridge 重启了 76 次，每次都可能掐断正在进行的回合。
# 现在三刀：①降级后最短驻留，期间不探不切回；②基础探测周期拉长；
# ③同一自然小时内切回次数越多，探测间隔指数退避（封顶 RECOVER_BACKOFF_MAX）。
RECOVER_PROBE_INTERVAL="${RECOVER_PROBE_INTERVAL:-1200}" # 兜底期间探测主渠道的基础间隔
MIN_FALLBACK_DWELL_SEC="${MIN_FALLBACK_DWELL_SEC:-900}"  # 降级后最短驻留（期间不探测、不切回）
RECOVER_BACKOFF_MAX="${RECOVER_BACKOFF_MAX:-7200}"       # 退避后的探测间隔上限
SWITCH_COOLDOWN_SEC="${SWITCH_COOLDOWN_SEC:-180}"        # 切换冷却，防抖动
MAX_LOG_BYTES="${MAX_LOG_BYTES:-8388608}"    # 日志轮转大小

# ── 慢速判据（2026-10-22 新增）───────────────────────────────────────────
LEDGER="${LEDGER:-/root/.dsh/channel-pack/token-ledger.json}"
SLOW_TTFT_MS="${SLOW_TTFT_MS:-15000}"        # 平均首字超过这个毫秒数算「慢」
SLOW_MIN_SAMPLES="${SLOW_MIN_SAMPLES:-3}"    # 至少要有这么多条新请求才开始判定
SLOW_STRIKES="${SLOW_STRIKES:-2}"            # 连续这么多次检查都慢 -> 降级

# 失败关键词。2026-10-19 补「限流」；2026-10-21 补渠道白名单相关。
# 2026-10-29：摘掉过于宽泛的「agent 处理出错」。它既罩渠道故障，也罩内容被拒
# （unpaired surrogate、Illegal API invocation from buddy 之类），后者一律被误判成
# 「渠道坏了」-> 降级 -> 300 秒后又探回 -> 成对重启。今天 18 次重启里大半是这么来的。
# 渠道故障改由下面几条具体信号判定（都只在真断/真没额度时出现）。
FAIL_PATTERN="unauthorized|quota|insufficient|balance|rate.?limit|额度不足|余额不足|发送失败|限流|解禁|所有账号|可用账号|AI 反馈.*error|Illegal API invocation|unapproved channel|522 with an HTML error page|521 with an HTML error page|no usable credential|ENOTFOUND|Service temporarily unavailable"

# 候选链：从优到劣。加渠道就往这三个数组尾部追加，判定逻辑会自动跟上。
# 2026-10-28：把 our-free-model 提到链首。
# 原链首是 loomy，而本部署的日常渠道是 our-free-model ⇒ role 结构性地永远 fallback，
# 黑话研究与结算都被它连累。改序后 chain[0] 就是日常渠道，role 才会是 main。
CHAIN_PROVIDERS=(our-free-model loomy trae raccoon)
CHAIN_MODELS=(deepseek/deepseek-v4.1-flash DeepSeek-V4.1-Flash deepseek-v4.1-flash sn-deepseek-v4-1-flash)
CHAIN_EFFORTS=(light low light on)

# A_/B_ 是链首与次级的别名 —— 脚本里还有一批地方按这两个名字取「主渠道」，
# 保留它们可以让 record_history 的 role 判定、--status 输出等无需改动。
A_PROVIDER="${CHAIN_PROVIDERS[0]}"; A_MODEL="${CHAIN_MODELS[0]}"; A_EFFORT="${CHAIN_EFFORTS[0]}"
B_PROVIDER="${CHAIN_PROVIDERS[1]}"; B_MODEL="${CHAIN_MODELS[1]}"; B_EFFORT="${CHAIN_EFFORTS[1]}"

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
  # 2026-10-21：窗口起点不早于上次切换时刻 —— 否则新渠道一上来就继承旧渠道的失败数，
  # 刚切过去就被判"主渠道故障"再切走（12:24 与 12:28 两次回退都是这个原因）。
  local _lsw _lsw_s
  _lsw=$(python3 -c "import json;print(json.load(open('$STATE')).get('lastSwitchAt') or 0)" 2>/dev/null || echo 0)
  if [ "${_lsw:-0}" -gt 0 ] 2>/dev/null; then
    _lsw_s=$((_lsw / 1000))
    [ "$_lsw_s" -gt "$window_start" ] && window_start=$_lsw_s
  fi

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
  python3 - "$STATE" "$1" "$2" "$3" "$A_PROVIDER" <<'PY'
import json, sys, time
p, frm, to, reason, main_provider = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
try:
    d = json.load(open(p))
except Exception:
    d = {}
# MARKER: history-collapse —— 2026-10-25
# 原来每调一次就 append 一条，文件只增不减。实测 496 条里 431 条是 from==to 的
# 自环（chain-exhausted 独占 419 条）——那根本不是「切换」，是整条链都试穿了。
# 现在改成：连续相同的 (from,to,reason) 只更新时间戳并累加 n，不再新增行。
# 诊断价值不丢（还能看出「这段时间一直在 chain-exhausted」和发生过多少次），
# 但文件不再无限膨胀。
now = int(time.time() * 1000)
hist = d.setdefault('history', [])
last = hist[-1] if hist else None
if last and last.get('from') == frm and last.get('to') == to and last.get('reason') == reason:
    last['at'] = now
    last['n'] = int(last.get('n') or 1) + 1
else:
    hist.append({
        'at': now,
        'from': frm,
        'to': to,
        'reason': reason,
    })
# 硬上限兜底：万一别的 reason 轮着刷，也不会撑爆。
# 定 600 是为了「不删已有」——线上当前 497 条，第一版设 300 会在第一次写入时
# 就把老记录切掉 197 条，那等于偷偷删数据，跟「只堵不删」不符。
HISTORY_MAX = 600
if len(hist) > HISTORY_MAX:
    del hist[:len(hist) - HISTORY_MAX]
d['lastSwitchAt'] = now
d['role'] = 'main' if to == main_provider else 'fallback'
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
}

# ── 探测主渠道是否恢复 ────────────────────────────────────────────────────

# ── 候选链工具（2026-10-22）──────────────────────────────────────────────
chain_size() { echo "${#CHAIN_PROVIDERS[@]}"; }
chain_provider_at() { echo "${CHAIN_PROVIDERS[$1]:-}"; }
chain_model_at() { echo "${CHAIN_MODELS[$1]:-}"; }
chain_effort_at() { echo "${CHAIN_EFFORTS[$1]:-}"; }
chain_names() { local IFS='/'; echo "${CHAIN_PROVIDERS[*]}"; }

# 返回 provider 在链中的下标；不在链里返回 -1。
chain_index_of() {
  local i
  for i in "${!CHAIN_PROVIDERS[@]}"; do
    if [ "${CHAIN_PROVIDERS[$i]}" = "$1" ]; then echo "$i"; return 0; fi
  done
  echo -1
}

# 真实调用链上第 i 级。只有上游回了文本才算通 —— 与 probe_primary 同一标准。
probe_chain_at() {
  local i="$1"
  local script="$BRIDGE_DIR/scripts/probe-model.mjs"
  [ -f "$script" ] || { log "探测：找不到 $script，判定不可用"; return 1; }
  local p m e out rc
  p=$(chain_provider_at "$i"); m=$(chain_model_at "$i"); e=$(chain_effort_at "$i")
  out=$(cd "$BRIDGE_DIR" && timeout 90 node "$script" "$p" "$m" "$e" 70 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    log "探测：${p}/${m} 可用"
    return 0
  fi
  log "探测：${p}/${m} 失败（exit=$rc）：$(echo "$out" | tail -2 | tr '
' ' ')"
  return 1
}

# 读 token-ledger 的**当日累计增量**，判断当前渠道最近这一批请求快不快。
# 输出：ok|slow|insufficient|none + 两个数（平均毫秒、样本数）
# 用增量而不是当日均值：当日均值会被切换前的历史数据稀释，越晚越迟钝。
update_slow_signal() {
  local provider="$1"
  python3 - "$LEDGER" "$STATE" "$provider" "$SLOW_TTFT_MS" "$SLOW_MIN_SAMPLES" <<'PY'
import datetime, json, sys, time

ledger_path, state_path, provider = sys.argv[1], sys.argv[2], sys.argv[3]
slow_ms, min_samples = int(sys.argv[4]), int(sys.argv[5])


def load(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


ledger = load(ledger_path, {})
state = load(state_path, {})
today = datetime.date.today().isoformat()
day = (ledger.get("days") or {}).get(today) or {}

key = None
for k in day:
    parts = k.split("|")
    if len(parts) >= 2 and parts[1] == provider:
        key = k
        break

snap_all = state.setdefault("ledgerSnap", {})
state["lastSlowCheckAt"] = int(time.time() * 1000)

if key is None:
    # 这个渠道今天还没有过请求。不动计数，也不清零 —— 刚切过去时清零会把
    # 上一条渠道留下的信号冲掉，反而更迟钝。
    with open(state_path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, ensure_ascii=False, indent=2)
    print("none 0 0")
    sys.exit(0)

row = day.get(key) or {}
cur_sum = int(row.get("ttftSumMs") or 0)
cur_cnt = int(row.get("ttftCount") or 0)
prev = snap_all.get(key) or {}
d_sum = cur_sum - int(prev.get("ttftSumMs") or 0)
d_cnt = cur_cnt - int(prev.get("ttftCount") or 0)
if d_sum < 0 or d_cnt < 0:          # 计数器被重置过（换天/重装）
    d_sum, d_cnt = cur_sum, cur_cnt
snap_all[key] = {"ttftSumMs": cur_sum, "ttftCount": cur_cnt}

strikes = int(state.get("slowStrikes") or 0)
if d_cnt >= min_samples:
    avg = d_sum // d_cnt
    state["lastSlowAvgMs"] = avg
    if avg > slow_ms:
        strikes += 1
        verdict = "slow"
    else:
        strikes = 0
        verdict = "ok"
    state["slowStrikes"] = strikes
    print("%s %d %d" % (verdict, avg, d_cnt))
else:
    print("insufficient 0 %d" % d_cnt)

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(state, fh, ensure_ascii=False, indent=2)
PY
}

slow_strikes_now() {
  python3 -c "
import json
try: print(json.load(open('$STATE')).get('slowStrikes') or 0)
except Exception: print(0)
" 2>/dev/null
}

# 切换之后必须清信号：失败窗口靠 lastSwitchAt 自动截断，但慢计数与账本快照
# 是我们自己存的，不清就会把上一级渠道的「慢」算到新渠道头上。
reset_chain_signals() {
  python3 - "$STATE" <<'PY'
import json, sys
p = sys.argv[1]
try: d = json.load(open(p))
except Exception: d = {}
d['slowStrikes'] = 0
d['ledgerSnap'] = {}
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
}

probe_primary() {
  # 旧实现只 curl 本地 /api/dsh/model 看控制台能不能报出模型，**从未碰过上游**，
  # 所以主渠道实际还在报错时也会判「已恢复」（实测 09:02:11 判恢复、09:02:14 又失败）。
  # 现在改成发一次真实的最小请求：只有上游真的回了文本才算可用。
  probe_chain_at 0
}

# 记一次「切回主渠道」到本小时计数，供 should_probe 做指数退避。
bump_recover_count() {
  python3 - "$STATE" <<'PY'
import json, sys, time
p = sys.argv[1]
now_ms = int(time.time() * 1000)
cur_hour = now_ms // 3600000
try:
    d = json.load(open(p, encoding="utf-8"))
except Exception:
    d = {}
if int(d.get("recoverHour") or 0) != cur_hour:
    d["recoverHour"] = cur_hour
    d["recoverCount"] = 0
d["recoverCount"] = int(d.get("recoverCount") or 0) + 1
json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
}

# 该不该现在去探主渠道。
# 成功判定走 python 的退出码（0 = 去探，1 = 别探），原因写进 state.probeHold，
# --status 能看见，日志不刷屏。
should_probe() {
  python3 - "$STATE" "$RECOVER_PROBE_INTERVAL" "$MIN_FALLBACK_DWELL_SEC" "$RECOVER_BACKOFF_MAX" <<'PY'
import json, sys, time

state_path = sys.argv[1]
base, dwell, cap = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
now_ms = int(time.time() * 1000)
cur_hour = now_ms // 3600000

try:
    d = json.load(open(state_path, encoding="utf-8"))
except Exception:
    d = {}

last_probe = int(d.get("lastProbeAt") or 0)
last_switch = int(d.get("lastSwitchAt") or 0)

# 同一自然小时内的切回次数；跨小时自动归零
if int(d.get("recoverHour") or 0) != cur_hour:
    d["recoverHour"] = cur_hour
    d["recoverCount"] = 0
count = int(d.get("recoverCount") or 0)

ok = False
if last_switch and now_ms - last_switch < dwell * 1000:
    d["probeHold"] = "dwell:%ds" % dwell          # 刚降级，先待够驻留时间
else:
    exp = max(0, min(3, count - 1)) if count >= 2 else 0
    interval = min(base * (2 ** exp), cap)
    if now_ms - last_probe >= interval * 1000:
        d["lastProbeAt"] = now_ms
        d["probeHold"] = "due:interval=%ds" % interval
        ok = True
    else:
        d["probeHold"] = "wait:interval=%ds" % interval

json.dump(d, open(state_path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
sys.exit(0 if ok else 1)
PY
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
  local cur hits idx size slow sig
  rotate_log
  cur=$(current_provider)
  size=$(chain_size)
  idx=$(chain_index_of "$cur")

  # 不在候选链里：按链首归位
  if [ "$idx" -lt 0 ]; then
    log "当前 provider 为 ${cur:-未知}，不在候选链（$(chain_names)）内，按链首 ${A_PROVIDER} 归位"
    set_provider "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" && record_history "$cur" "$A_PROVIDER" 'not-in-chain'
    reset_chain_signals
    return 0
  fi

  hits=$(count_recent_failures)
  hits=${hits:-0}

  # 慢速信号：只看当前渠道最近这一批真实请求的首字延迟
  sig=$(update_slow_signal "$cur")
  slow=$(slow_strikes_now)
  slow=${slow:-0}
  case "${sig%% *}" in
    slow)         log "首字偏慢：最近 $(echo "$sig" | awk '{print $3}') 次平均 $(echo "$sig" | awk '{print $2}')ms > ${SLOW_TTFT_MS}ms，慢计数 ${slow}/${SLOW_STRIKES}" ;;
    insufficient) log "首字采样不足（$(echo "$sig" | awk '{print $3}') 条 < ${SLOW_MIN_SAMPLES}），本轮不判定快慢" ;;
  esac

  # 不在链首，且当前没有故障迹象：定期往上探一级，能回去就回去
  if [ "$idx" -gt 0 ] && [ "$hits" -lt "$FAIL_THRESHOLD" ] && [ "$slow" -lt "$SLOW_STRIKES" ]; then
    if should_probe; then
      local up=$((idx - 1))
      if probe_chain_at "$up"; then
        log "上游渠道 $(chain_provider_at "$up") 已恢复 -> 切回（退出第 ${idx} 级）"
        set_provider "$(chain_provider_at "$up")" "$(chain_model_at "$up")" "$(chain_effort_at "$up")" \
          && record_history "$cur" "$(chain_provider_at "$up")" 'recovered'
        bump_recover_count
        reset_chain_signals
      fi
    fi
    return 0
  fi

  # 两种判据都没到
  if [ "$hits" -lt "$FAIL_THRESHOLD" ] && [ "$slow" -lt "$SLOW_STRIKES" ]; then
    return 0
  fi

  if in_cooldown; then
    log "触发条件成立（失败 ${hits} 条 / 慢计数 ${slow}），但仍在切换冷却（${SWITCH_COOLDOWN_SEC}s）内，暂不切换"
    return 0
  fi

  # 到了阈值：能往下一级就走，走到头就告警
  if [ "$idx" -lt $((size - 1)) ]; then
    local next=$((idx + 1)) reason='main-failed'
    [ "$slow" -ge "$SLOW_STRIKES" ] && reason='main-slow'
    log "渠道 ${cur} 触发降级（失败 ${hits} 条 / 慢计数 ${slow}）-> 第 ${next} 级 $(chain_provider_at "$next")"
    set_provider "$(chain_provider_at "$next")" "$(chain_model_at "$next")" "$(chain_effort_at "$next")" \
      && record_history "$cur" "$(chain_provider_at "$next")" "$reason"
    reset_chain_signals
  else
    log "⚠️ 已在候选链最后一级 ${cur}，窗口内仍有 ${hits} 条失败 / 慢计数 ${slow}，不再切换；请人工检查各渠道额度"
    record_history "$cur" "$cur" 'chain-exhausted'
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
d['recoverCount'] = 0
d['recoverHour'] = 0
d['probeHold'] = ''
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('已重置探测与切换冷却')
PY
    exit 0 ;;
  --probe)
    if probe_primary; then echo "主渠道 ${A_PROVIDER}: 可用"; exit 0; else echo "主渠道 ${A_PROVIDER}: 不可用"; exit 1; fi ;;
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
    printf '角色           = 候选链第 %s 级（链首即主渠道）\n' "$(chain_index_of "$(current_provider)")"
    printf '主渠道         = %s（%s / %s）\n' "$A_PROVIDER" "$A_MODEL" "$A_EFFORT"
    printf '候选链         = %s
' "$(chain_names)"
    for _i in "${!CHAIN_PROVIDERS[@]}"; do
      printf '  第 %s 级       = %s（%s / %s）
' "$_i" "${CHAIN_PROVIDERS[$_i]}" "${CHAIN_MODELS[$_i]}" "${CHAIN_EFFORTS[$_i]}"
    done
    printf '慢速判据       = 最近 >= %s 条新请求的平均首字 > %sms，连续 %s 次 -> 降级
' "$SLOW_MIN_SAMPLES" "$SLOW_TTFT_MS" "$SLOW_STRIKES"
    printf '当前慢计数     = %s 次（上次平均首字 %s ms）
' "$(slow_strikes_now)" "$(python3 -c "
import json
try: print(json.load(open('$STATE')).get('lastSlowAvgMs') or 0)
except Exception: print(0)
" 2>/dev/null)"
    printf '失败统计       = 滑动窗口 %ss 内 >= %s 条\n' "$WINDOW_SEC" "$FAIL_THRESHOLD"
    printf '当前窗口内失败 = %s 条\n' "$(count_recent_failures)"
    printf '检查间隔       = %ss\n' "$INTERVAL"
    printf '切换冷却       = %ss\n' "$SWITCH_COOLDOWN_SEC"
    printf '恢复探测间隔   = %ss（仅处于兜底时）\n' "$RECOVER_PROBE_INTERVAL"
    printf '最短驻留       = %ss（降级后不探测、不切回）\n' "$MIN_FALLBACK_DWELL_SEC"
    printf '退避上限       = %ss（同小时切回越多，间隔越大）\n' "$RECOVER_BACKOFF_MAX"
    printf '本小时切回     = %s 次 / 探测挂起原因 = %s\n' \
      "$(python3 -c "import json;print(json.load(open('$STATE')).get('recoverCount') or 0)" 2>/dev/null || echo 0)" \
      "$(python3 -c "import json;print(json.load(open('$STATE')).get('probeHold') or '-')" 2>/dev/null || echo -)"
    printf '桥接 unit      = %s\n' "$(systemctl is-active "$BRIDGE_UNIT" 2>/dev/null || echo n/a)"
    exit 0 ;;
esac

log "provider 候选链守护启动（链 $(chain_names)；滑动窗口=${WINDOW_SEC}s 阈值=${FAIL_THRESHOLD}；慢判定：最近 ${SLOW_MIN_SAMPLES} 条平均首字 > ${SLOW_TTFT_MS}ms 连续 ${SLOW_STRIKES} 次；检查=${INTERVAL}s 冷却=${SWITCH_COOLDOWN_SEC}s 恢复探测=${RECOVER_PROBE_INTERVAL}s；当前=$(current_provider) 第 $(chain_index_of "$(current_provider)") 级）"

trap 'log "收到停止信号，守护退出"; exit 0' TERM INT
while true; do
  check_once
  sleep "$INTERVAL"
done
