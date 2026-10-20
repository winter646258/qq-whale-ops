#!/usr/bin/env bash
# QQ 小鲸鱼 · 一键安装脚本（幂等，可重复执行）
#
# 前提：qq-bridge 已经 clone 到 /opt/qq-bridge 且 npm install 完成，
#       DSH 已就绪（/root/.dsh/.env 存在），SnowLuma 容器已在跑。
# 本脚本负责：装 systemd 单元、装脚本、建目录、放人格卡、打补丁、起服务、自检。
#
# 用法：
#   sudo bash setup.sh            # 完整安装
#   sudo bash setup.sh --check     # 只做自检，不改动任何东西
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="${BRIDGE_DIR:-/opt/qq-bridge}"
ENV_FILE=/etc/qq-bridge.env
MODE="${1:-}"

ok()   { echo "  ✔ $*"; }
warn() { echo "  ⚠ $*"; }
die()  { echo "  ✖ $*"; exit 1; }
step() { echo; echo "=== $* ==="; }

need_root() { [ "$(id -u)" = "0" ] || die "请用 root 运行（sudo bash setup.sh）"; }

preflight() {
  step "0. 前置检查"
  command -v node >/dev/null || die "缺 node"
  command -v npm  >/dev/null || die "缺 npm"
  command -v docker >/dev/null || warn "缺 docker（SnowLuma 需要）"
  python3 -c "import yaml" 2>/dev/null || warn "python3 无 pyyaml（补丁脚本要用）"
  [ -d "$BRIDGE_DIR" ] || die "$BRIDGE_DIR 不存在，请先 clone qq-bridge"
  [ -f "$BRIDGE_DIR/config.json" ] || die "$BRIDGE_DIR/config.json 不存在"
  [ -f /root/.dsh/.env ] || warn "/root/.dsh/.env 不存在（DSH 需要 DEEPSEEK_API_KEY）"
  [ -f "$ENV_FILE" ] || warn "$ENV_FILE 不存在 —— qzone-watch 就绪检查需要 SNOWLUMA_TOKEN"
  [ -f "$BRIDGE_DIR/node_modules/@snowluma/sdk/package.json" ] || warn "依赖未装全（npm install 跑过吗）"
  free -m | awk 'NR==2 { if ($7 < 400) print "  ⚠ 可用内存仅 " $7 " MB，2 GiB 机器会很紧" }'
  ok "前置检查完成"
}

install_files() {
  step "1. 安装 systemd 单元"
  cp -a "$REPO_DIR/systemd/"*.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable qq-dsh.service qq-bridge.service qq-zone-watch.service qq-provider-switch.service >/dev/null 2>&1
  ok "四个单元已安装并 enable"

  step "2. 安装脚本与目录"
  install -m755 "$REPO_DIR/scripts/switch-provider.sh" "$BRIDGE_DIR/switch-provider.sh"
  install -m755 "$REPO_DIR/scripts/whale-ctl.sh"       "$BRIDGE_DIR/whale-ctl.sh"
  [[ -f "$REPO_DIR/scripts/import-memes.py" ]] && install -m755 "$REPO_DIR/scripts/import-memes.py" "$BRIDGE_DIR/import-memes.py"
  [[ -f "$REPO_DIR/scripts/selftest-wake.py" ]] && install -m755 "$REPO_DIR/scripts/selftest-wake.py" "$BRIDGE_DIR/selftest-wake.py"
  [[ -f "$REPO_DIR/scripts/probe-official-api.py" ]] && install -m755 "$REPO_DIR/scripts/probe-official-api.py" "$BRIDGE_DIR/probe-official-api.py"

  mkdir -p "$BRIDGE_DIR/diary" "$BRIDGE_DIR/album"
  if [[ ! -f "$BRIDGE_DIR/diary/日记.md" ]]; then
    printf '# 日记\n\n（这里是小鲸鱼自己的日记，她自己想写就写，追加在下面。不要当成任务清单。）\n' > "$BRIDGE_DIR/diary/日记.md"
    ok "已创建 diary/日记.md"
  else
    ok "diary/日记.md 已存在（未覆盖）"
  fi
  if [[ ! -f "$BRIDGE_DIR/album/README.md" ]]; then
    printf '# 相册\n\n小鲸鱼自己挑的图放这里。放的时候另起一个同名的 .txt 写一句为什么留它。\n' > "$BRIDGE_DIR/album/README.md"
    ok "已创建 album/README.md"
  else
    ok "album/README.md 已存在（未覆盖）"
  fi

  step "3. 安装人格卡"
  if [[ -f "$BRIDGE_DIR/roles/小鲸鱼.md" ]]; then
    cp -a "$BRIDGE_DIR/roles/小鲸鱼.md" "$BRIDGE_DIR/roles/小鲸鱼.md.bak-$(date +%Y%m%d-%H%M%S)"
    warn "已备份现有人格卡"
  fi
  install -m644 "$REPO_DIR/persona/roles-小鲸鱼.md" "$BRIDGE_DIR/roles/小鲸鱼.md"
  local n
  n=$(python3 -c "print(len(open('$BRIDGE_DIR/roles/小鲸鱼.md',encoding='utf-8').read()))")
  ok "人格卡 $(echo "$n") 字符（注入上限 6000，余量 $((6000-n))）"
  [[ "$n" -le 6000 ]] || warn "人格卡超限，会被截断！"
}

apply_patches() {
  step "4. 打补丁（已打过的会因锚点不匹配而跳过，属正常）"
  for f in patch-bridge-friend-refresh.py patch-bridge-log-agent-error.py \
           patch-impression-refresh.py patch-impression-persist.py; do
    [[ -f "$REPO_DIR/patches/$f" ]] || continue
    printf '  %-38s ' "$f"
    if python3 "$REPO_DIR/patches/$f" >/tmp/patch-out.txt 2>&1; then
      grep -q '已存在\|跳过' /tmp/patch-out.txt && echo '跳过（已打过）' || echo '已应用'
    else
      echo "失败：$(tail -1 /tmp/patch-out.txt)"
    fi
  done
  node --check "$BRIDGE_DIR/src/bridge.js" && ok "bridge.js 语法 OK" || die "bridge.js 语法错误，请检查补丁"
}

start_all() {
  step "5. 启动服务"
  systemctl restart qq-dsh.service
  local i=0
  while [[ $i -lt 60 ]]; do ss -tln | grep -q ':3081' && break; sleep 2; i=$((i+1)); done
  systemctl restart qq-bridge.service
  i=0; while [[ $i -lt 75 ]]; do ss -tln | grep -q ':3100' && break; sleep 2; i=$((i+1)); done
  systemctl restart qq-zone-watch.service
  systemctl restart qq-provider-switch.service
  sleep 3
  ok "启动指令已下发"
}

selfcheck() {
  step "6. 自检"
  local fail=0
  for s in qq-dsh qq-bridge qq-zone-watch qq-provider-switch; do
    local st; st=$(systemctl is-active "$s" 2>/dev/null || echo inactive)
    local en; en=$(systemctl is-enabled "$s" 2>/dev/null || echo disabled)
    printf '  %-22s %-9s %s\n' "$s" "$st" "$en"
    [[ "$st" == "active" ]] || fail=1
    [[ "$en" == "enabled" ]] || fail=1
  done
  echo
  bash "$BRIDGE_DIR/whale-ctl.sh" status 2>/dev/null || warn "whale-ctl 不可用"
  echo
  grep -aq 'SnowLuma 已连接' /var/log/qqbridge.log 2>/dev/null && ok "桥接已连上 SnowLuma" || warn "没看到「SnowLuma 已连接」"
  grep -aq 'DSH 已就绪'      /var/log/qqbridge.log 2>/dev/null && ok "桥接已连上 DSH" || warn "没看到「DSH 已就绪」"
  [[ -f "$ENV_FILE" ]] || warn "$ENV_FILE 缺失：qq-zone-watch 的就绪检查会失败"
  echo
  if [[ $fail -eq 0 ]]; then
    echo "  全部通过 ✅  去 QQ 里给她发一句话试试"
  else
    echo "  有服务没起来 ✖  看：journalctl -u <服务名> -n 50 和 /var/log/qqbridge.log"
  fi
}

preflight
if [[ "$MODE" == "--check" ]]; then
  selfcheck
  exit 0
fi
need_root
install_files
apply_patches
start_all
selfcheck
