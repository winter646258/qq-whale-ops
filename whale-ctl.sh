#!/usr/bin/env bash
# QQ 小鲸鱼 · 一键暂停 / 恢复 / 查状态
#
# 走桥接自己的控制台接口（127.0.0.1:3100）。
# ⚠️ 控制台令牌必须走 `x-console-token` 头（或 ?token=），走 authorization 会 401。
#
# socialV2.paused = 「一秒钟让她闭嘴」的总闸：
#   暂停后不再唤醒、不再主动说话，AI 通道一律 403，但你还能正常看状态/发消息。
#
# 用法：
#   bash /opt/qq-bridge/whale-ctl.sh status     # 看现状
#   bash /opt/qq-bridge/whale-ctl.sh pause      # 立刻闭嘴
#   bash /opt/qq-bridge/whale-ctl.sh resume     # 恢复
#
# 更彻底（连被动回复都停）：systemctl stop qq-bridge
set -uo pipefail

PORT=3100
TOKEN_FILE=/opt/qq-bridge/state/console-token
BASE="http://127.0.0.1:${PORT}"

token() { [ -f "$TOKEN_FILE" ] && tr -d '\n' < "$TOKEN_FILE" || echo ''; }

call() {
  local method="$1" path="$2" body="${3:-}"
  local t; t=$(token)
  if [ -z "$t" ]; then echo '{"ok":false,"error":"读不到 console-token"}'; return 1; fi
  if [ -n "$body" ]; then
    curl -s -m 10 -X "$method" -H "x-console-token: $t" \
      -H 'content-type: application/json' -d "$body" "$BASE$path"
  else
    curl -s -m 10 -X "$method" -H "x-console-token: $t" "$BASE$path"
  fi
}

read_paused() {
  call GET /api/socialV2/activity | python3 -c "
import json,sys
try: print('true' if json.load(sys.stdin).get('paused') else 'false')
except Exception: print('unknown')
"
}

show_status() {
  local p; p=$(read_paused)
  case "$p" in
    true)  echo "  二代 AI 活动 : ⏸ 已暂停（她不会主动说话，AI 发消息被拦）" ;;
    false) echo "  二代 AI 活动 : ▶ 正常运行" ;;
    *)     echo "  二代 AI 活动 : ❓ 读不到（接口异常，请检查桥接）" ;;
  esac
}

# 设定暂停状态并回读校验；只有真的改成了才报成功
set_paused() {
  local want="$1" label="$2"
  local resp; resp=$(call POST /api/socialV2/activity "{\"paused\":$want}")
  local now; now=$(read_paused)
  if [ "$now" != "$want" ]; then
    echo "✖ $label 失败！桥接返回：$(echo "$resp" | head -c 200)"
    echo "  当前实际状态：$now"
    return 1
  fi
  echo "✔ $label 成功（已回读校验）"
  show_status
}

case "${1:-status}" in
  pause)  set_paused true "暂停" ;;
  resume) set_paused false "恢复" ;;
  status|*)
    echo "=== 小鲸鱼状态 ==="
    show_status
    for s in qq-dsh qq-bridge qq-zone-watch qq-provider-switch; do
      printf '  %-22s %s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo n/a)"
    done
    echo "  桥接端口 3100        : $([ "$(ss -tlnH 2>/dev/null | grep -c ':3100')" -gt 0 ] && echo 活 || echo 死)"
    echo "  桥接日志最后一行     : $(tail -n 1 /var/log/qqbridge.log 2>/dev/null | cut -c1-58)"
    ;;
esac
