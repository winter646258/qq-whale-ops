#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""给 switch-provider.sh 加「多级候选链 + 慢了也切」能力。

## 为什么改

原来的守护是**二元**的：主渠道（loomy）失败到阈值 → 切唯一兜底（raccoon）。
两个问题：

1. **兜底选错了对象。** 实测同一天（2026-10-22）的 token-ledger：
      loomy   58 次请求，平均首字 1.70 秒
      trae     2 次请求，平均首字 2.16 秒
      raccoon 13 次请求，平均首字 28.7 秒   ← 兜底比主渠道慢 17 倍
   raccoon 唯一的优势是 cache 命中率高（今日 cacheRead 3.79M），省 token；
   而 trae 的 cache 命中率是 0%（脚本头注释里早就写明了）。所以两个都留着，
   但顺序应该是「快而贵」在前、「慢而省」在后。

2. **只认「报错」，不认「慢」。** 主人原话是「自动检测速度慢了，就自动切换
   下一个模型」。raccoon 那种「能回、但一次等半分钟」不会进 FAIL_PATTERN。

## 改了什么

- 候选链：`loomy` → `trae` → `raccoon`（三级，可继续加）
- 慢速判据：读 `/root/.dsh/channel-pack/token-ledger.json` 的**当日累计增量**
  （本次 ttftSumMs/ttftCount 减去上次快照），平均首字超过 SLOW_TTFT_MS 就记一次；
  连续 SLOW_STRIKES 次触发降级。用增量而不是当日均值，是因为当日均值会被
  切换前的历史数据稀释，越到晚上越迟钝。
- 逐级降级 + 逐级恢复：在链上任意位置失败都往下一级走；不在链首时定期探测
  上一级，能回就回。
- 原有能力全部保留：滑动窗口失败统计、切换冷却、单实例校验、--status 等命令。

## 用法
python3 patch-provider-chain.py
"""
import re
import sys
import time

PATH = "/opt/qq-bridge/switch-provider.sh"
STAMP = time.strftime("%Y%m%d-%H%M")


def sub(src, old, new, label):
    hits = src.count(old)
    if hits != 1:
        print("❌ [%s] 命中 %d 次，期望恰好 1 次。整份未写盘。" % (label, hits))
        sys.exit(1)
    print("   ✓ %s" % label)
    return src.replace(old, new)


def sub_re(src, pattern, new, label):
    """正则版替换。

    有些锚点行里带「─」这种制表符和成串的中文排版空格（头注释、--status 的输出），
    我数不准它们各有几个 —— 数错了断言就会拦下整份补丁，白白来回一趟。
    所以对这类锚点只钉住行首那截可辨认的文字，剩下的交给 [^\\n]*。
    """
    out, n = re.subn(pattern, new, src)
    if n != 1:
        print("❌ [%s] 正则命中 %d 次，期望恰好 1 次。整份未写盘。" % (label, n))
        sys.exit(1)
    print("   ✓ %s" % label)
    return out


with open(PATH, encoding="utf-8") as fh:
    src = fh.read()

# ── 1. 头注释：说明新定位 ────────────────────────────────────────────────
src = sub_re(
    src,
    r"# 主渠道：buddy[^\n]*\n# 兜底渠道：trae[^\n]*\n",
    """# 候选链（2026-10-22 起从「二元兜底」改成「多级降级」）：
#   第 0 级 loomy    DeepSeek-V4.1-Flash      effort=low    快（首字 ~1.7s），cache 命中率高
#   第 1 级 trae     deepseek-v4.1-flash      effort=light  快（~2.2s），但 cache 命中率 0%
#   第 2 级 raccoon  sn-deepseek-v4-1-flash   effort=on     慢（~29s），但 cache 命中率高、省 token
#
# 顺序的理由：能快就别拖。trae 排在前是因为它快；raccoon 排最后是因为它慢但省，
# 长期挂着也不心疼。三者都免费，所以「降级」不产生额外花费。
#
# 降级触发有两种：窗口内失败数达标（报错），或首字延迟连续偏慢（能回但太慢）。
""",
    "头注释",
)

# ── 2. 常量区：候选链 + 慢速阈值 ─────────────────────────────────────────
src = sub(
    src,
    """MAX_LOG_BYTES="${MAX_LOG_BYTES:-8388608}"    # 日志轮转大小
""",
    """MAX_LOG_BYTES="${MAX_LOG_BYTES:-8388608}"    # 日志轮转大小

# ── 慢速判据（2026-10-22 新增）───────────────────────────────────────────
LEDGER="${LEDGER:-/root/.dsh/channel-pack/token-ledger.json}"
SLOW_TTFT_MS="${SLOW_TTFT_MS:-15000}"        # 平均首字超过这个毫秒数算「慢」
SLOW_MIN_SAMPLES="${SLOW_MIN_SAMPLES:-3}"    # 至少要有这么多条新请求才开始判定
SLOW_STRIKES="${SLOW_STRIKES:-2}"            # 连续这么多次检查都慢 -> 降级
""",
    "慢速阈值常量",
)

# ── 3. 候选链定义（A_/B_ 保留为链首/次级的别名，兼容既有引用）─────────────
src = sub(
    src,
    """A_PROVIDER=loomy; A_MODEL=DeepSeek-V4.1-Flash; A_EFFORT=low
B_PROVIDER=raccoon; B_MODEL=sn-deepseek-v4-1-flash; B_EFFORT=on
""",
    """# 候选链：从优到劣。加渠道就往这三个数组尾部追加，判定逻辑会自动跟上。
CHAIN_PROVIDERS=(loomy trae raccoon)
CHAIN_MODELS=(DeepSeek-V4.1-Flash deepseek-v4.1-flash sn-deepseek-v4-1-flash)
CHAIN_EFFORTS=(low light on)

# A_/B_ 是链首与次级的别名 —— 脚本里还有一批地方按这两个名字取「主渠道」，
# 保留它们可以让 record_history 的 role 判定、--status 输出等无需改动。
A_PROVIDER="${CHAIN_PROVIDERS[0]}"; A_MODEL="${CHAIN_MODELS[0]}"; A_EFFORT="${CHAIN_EFFORTS[0]}"
B_PROVIDER="${CHAIN_PROVIDERS[1]}"; B_MODEL="${CHAIN_MODELS[1]}"; B_EFFORT="${CHAIN_EFFORTS[1]}"
""",
    "候选链定义",
)

# ── 4. 辅助函数：插在 record_history 之后 ───────────────────────────────
HELPERS = '''
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
  log "探测：${p}/${m} 失败（exit=$rc）：$(echo "$out" | tail -2 | tr '\\n' ' ')"
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
json.dump(d, open(p, 'w', ensure_ascii=False), indent=2)
PY
}

'''

src = sub_re(
    src,
    r"(?m)^probe_primary\(\) \{",
    HELPERS + "probe_primary() {",
    "链工具函数",
)

# ── 5. probe_primary 改为走通用的 probe_chain_at ────────────────────────
src = sub(
    src,
    """  local script="$BRIDGE_DIR/scripts/probe-model.mjs"
  [ -f "$script" ] || { log "探测主渠道：找不到 $script，判定不可用（不冒险切回）"; return 1; }
  local out rc
  out=$(cd "$BRIDGE_DIR" && timeout 90 node "$script" "$A_PROVIDER" "$A_MODEL" "$A_EFFORT" 70 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ]; then
    log "探测主渠道：真实调用成功 -> $A_PROVIDER/$A_MODEL 可用"
    return 0
  fi
  log "探测主渠道：真实调用失败（exit=$rc）：$(echo "$out" | tail -2 | tr '\\n' ' ')"
  return 1
}""",
    """  probe_chain_at 0
}""",
    "probe_primary 复用链探测",
)

# ── 6. 重写 check_once ──────────────────────────────────────────────────
OLD_CHECK = """check_once() {
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
      if probe_primary; then
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
}"""

NEW_CHECK = """check_once() {
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
        set_provider "$(chain_provider_at "$up")" "$(chain_model_at "$up")" "$(chain_effort_at "$up")" \\
          && record_history "$cur" "$(chain_provider_at "$up")" 'recovered'
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
    set_provider "$(chain_provider_at "$next")" "$(chain_model_at "$next")" "$(chain_effort_at "$next")" \\
      && record_history "$cur" "$(chain_provider_at "$next")" "$reason"
    reset_chain_signals
  else
    log "⚠️ 已在候选链最后一级 ${cur}，窗口内仍有 ${hits} 条失败 / 慢计数 ${slow}，不再切换；请人工检查各渠道额度"
    record_history "$cur" "$cur" 'chain-exhausted'
  fi
}"""

src = sub(src, OLD_CHECK, NEW_CHECK, "重写 check_once")

# ── 7. --status 输出补上链与慢速信息 ────────────────────────────────────
src = sub_re(
    src,
    r"(?m)^    printf '兜底渠道[^\n]*\n",
    """    printf '候选链         = %s\\n' "$(chain_names)"
    for _i in "${!CHAIN_PROVIDERS[@]}"; do
      printf '  第 %s 级       = %s（%s / %s）\\n' "$_i" "${CHAIN_PROVIDERS[$_i]}" "${CHAIN_MODELS[$_i]}" "${CHAIN_EFFORTS[$_i]}"
    done
    printf '慢速判据       = 最近 >= %s 条新请求的平均首字 > %sms，连续 %s 次 -> 降级\\n' "$SLOW_MIN_SAMPLES" "$SLOW_TTFT_MS" "$SLOW_STRIKES"
    printf '当前慢计数     = %s 次（上次平均首字 %s ms）\\n' "$(slow_strikes_now)" "$(python3 -c "
import json
try: print(json.load(open('$STATE')).get('lastSlowAvgMs') or 0)
except Exception: print(0)
" 2>/dev/null)"
""",
    "--status 增补",
)

with open(PATH + ".bak-" + STAMP, "w", encoding="utf-8") as fh:
    fh.write(open(PATH, encoding="utf-8").read())
with open(PATH, "w", encoding="utf-8") as fh:
    fh.write(src)

print("✅ switch-provider.sh 已改（备份 %s.bak-%s）" % (PATH, STAMP))
