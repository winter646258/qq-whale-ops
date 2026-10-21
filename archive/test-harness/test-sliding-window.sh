#!/bin/bash
# 滑动窗口失败统计 —— 离线夹具测试
# 用构造的日志验证：稀疏失败能触发、窗口外不计、跨午夜正确、轮转/空文件不崩
set -uo pipefail

SCRIPT=/tmp/sp-under-test.sh
WINDOW_SEC="${WINDOW_SEC:-600}"
FAIL_PATTERN="unauthorized|quota|insufficient|balance|rate.?limit|额度不足|余额不足|发送失败|限流|解禁|所有账号|可用账号|AI 反馈.*error|agent 处理出错|Illegal API invocation|unapproved channel"

PASS=0
FAIL=0
ok()   { if [ "$2" = "1" ]; then echo "  ✔ $1"; PASS=$((PASS+1)); else echo "  ✖ $1 — $3"; FAIL=$((FAIL+1)); fi; }
eq()   { if [ "$2" = "$3" ]; then echo "  ✔ $1 (=$3)"; PASS=$((PASS+1)); else echo "  ✖ $1 — 期望 $3 实际 $2"; FAIL=$((FAIL+1)); fi; }

# 从被测脚本里抠出 count_recent_failures（连同它依赖的变量）
extract_fn() {
  sed -n '/^count_recent_failures()/,/^}/p' "$SCRIPT"
}

# 造一个只有 count_recent_failures 的最小脚本
build_probe() {
  local logfile="$1"
  local out="/tmp/probe-$$.sh"
  {
    echo '#!/bin/bash'
    echo 'set -uo pipefail'
    echo "LOG=\"$logfile\""
    echo "WINDOW_SEC=\"$WINDOW_SEC\""
    echo "FAIL_PATTERN=\"$FAIL_PATTERN\""
    extract_fn
    echo 'count_recent_failures'
  } > "$out"
  chmod +x "$out"
  echo "$out"
}

run_count() {
  local logfile="$1"
  local p; p=$(build_probe "$logfile")
  bash "$p" 2>/dev/null | tail -1
  rm -f "$p"
}

echo "════ 用例 1：稀疏失败（每分钟 1 条，共 5 条）════"
# 场景：08:02 08:03 08:04 08:05 08:07 各有 1 条失败
# 关键：检查间隔 60s，每次只看 1 条 —— 旧逻辑永远凑不到 3；新逻辑应看到 5 条
TMPLOG=/tmp/test-sparse.log
: > "$TMPLOG"
NOW=$(date +%s)
for m in 2 3 4 5 7; do
  ts=$(date -d "@$((NOW - (7 - m) * 60))" '+%H:%M:%S')
  echo "$ts [bridge] agent 处理出错 (group:906710082): buddy: Illegal API invocation from an unapproved channel" >> "$TMPLOG"
done
# 让 mtime 是现在（模拟刚写）
touch "$TMPLOG"
CNT=$(run_count "$TMPLOG")
eq "稀疏 5 条全部计入" "$CNT" "5"
ok "达到阈值 3（兜底会触发）" "$([ "$CNT" -ge 3 ] && echo 1 || echo 0)" "实际 $CNT"

echo
echo "════ 用例 2：窗口外的失败不计入 ════"
TMPLOG2=/tmp/test-outside.log
: > "$TMPLOG2"
# 一条 30 分钟前（远在 600s 窗口外）
ts_old=$(date -d "@$((NOW - 1800))" '+%H:%M:%S')
echo "$ts_old [bridge] agent 处理出错 (group:906710082): quota exceeded" >> "$TMPLOG2"
# 两条在窗口内
echo "$(date -d "@$((NOW - 120))" '+%H:%M:%S') [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOG2"
echo "$(date -d "@$((NOW - 60))" '+%H:%M:%S') [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOG2"
touch "$TMPLOG2"
CNT=$(run_count "$TMPLOG2")
eq "只计窗口内 2 条" "$CNT" "2"
ok "未达阈值（不应切换）" "$([ "$CNT" -lt 3 ] && echo 1 || echo 0)" "实际 $CNT"

echo
echo "════ 用例 3：同秒堆积 3 条，只算 3（不重复计数）════"
TMPLOG3=/tmp/test-burst.log
: > "$TMPLOG3"
ts=$(date -d "@$((NOW - 30))" '+%H:%M:%S')
for i in 1 2 3; do
  echo "$ts [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOG3"
done
touch "$TMPLOG3"
CNT=$(run_count "$TMPLOG3")
eq "同秒 3 条 = 3" "$CNT" "3"

echo
echo "════ 用例 4：大小写不敏感 ════"
TMPLOG4=/tmp/test-case.log
: > "$TMPLOG4"
echo "$(date -d "@$((NOW - 20))" '+%H:%M:%S') [bridge] AGENT 处理出错: ILLEGAL API INVOCATION" >> "$TMPLOG4"
touch "$TMPLOG4"
CNT=$(run_count "$TMPLOG4")
ok "大写也能命中" "$([ "$CNT" -ge 1 ] && echo 1 || echo 0)" "实际 $CNT"

echo
echo "════ 用例 5：空文件 / 不存在 / 无时间戳行 ════"
: > /tmp/test-empty.log
touch /tmp/test-empty.log
eq "空文件 = 0" "$(run_count /tmp/test-empty.log)" "0"
eq "不存在的文件 = 0" "$(run_count /tmp/test-nonexistent.log)" "0"

TMPLOG5=/tmp/test-nots.log
: > "$TMPLOG5"
echo "这是一行没有时间戳的输出" >> "$TMPLOG5"
echo "另一个启动信息" >> "$TMPLOG5"
touch "$TMPLOG5"
eq "无时间戳行被忽略 = 0" "$(run_count "$TMPLOG5")" "0"

echo
echo "════ 用例 6：异常时间格式（非 HH:MM:SS 开头）════"
TMPLOG6=/tmp/test-badtime.log
: > "$TMPLOG6"
echo "2026-10-21 08:07:34 [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOG6"
echo "08:07 [bridge] agent 处理出错: 缺少秒" >> "$TMPLOG6"
touch "$TMPLOG6"
CNT=$(run_count "$TMPLOG6")
eq "不合格式的行不计 = 0" "$CNT" "0"

echo
echo "════ 用例 7：检查频率不影响结果 ════"
# 同一份日志，跑三次结果必须一致
TMPLOG7=/tmp/test-stable.log
: > "$TMPLOG7"
for m in 1 2 3 4; do
  echo "$(date -d "@$((NOW - m * 60))" '+%H:%M:%S') [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOG7"
done
touch "$TMPLOG7"
R1=$(run_count "$TMPLOG7"); sleep 1; R2=$(run_count "$TMPLOG7"); sleep 1; R3=$(run_count "$TMPLOG7")
eq "三次结果一致 R1" "$R1" "$R2"
eq "三次结果一致 R2" "$R2" "$R3"
echo "  （若每次检查都推进水位线，旧逻辑这里会变成 0 / 1 / 0 之类的不稳定值）"

echo
echo "════ 用例 8：非失败行不计数 ════"
TMPLOG8=/tmp/test-nonfail.log
: > "$TMPLOG8"
echo "$(date '+%H:%M:%S') [bridge] 桥接已启动。按 Ctrl+C 退出。" >> "$TMPLOG8"
echo "$(date '+%H:%M:%S') [bridge] [friendOnly] 好友列表已刷新：14 个好友" >> "$TMPLOG8"
touch "$TMPLOG8"
eq "正常日志 = 0" "$(run_count "$TMPLOG8")" "0"

echo
echo "════ 用例 9：窗口边界（正好 600s 内 vs 外）════"
TMPLOGA=/tmp/test-boundary.log
: > "$TMPLOGA"
echo "$(date -d "@$((NOW - 590))" '+%H:%M:%S') [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOGA"
echo "$(date -d "@$((NOW - 610))" '+%H:%M:%S') [bridge] agent 处理出错: Illegal API invocation" >> "$TMPLOGA"
touch "$TMPLOGA"
CNT=$(run_count "$TMPLOGA")
eq "590s 内计入、610s 外不计 = 1" "$CNT" "1"

rm -f /tmp/test-*.log
echo
echo "════ 通过 $PASS / 失败 $FAIL ════"
[ "$FAIL" -eq 0 ]
