#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把「二元兜底」时代留下的文案改成「候选链」的说法。

`patch-provider-chain.py` 改的是逻辑，但有几处**说给人听的话**还留在旧世界：

  - `switch-provider.sh` 的启动日志写「主 X，兜底 Y 仅故障时临时用」
  - `--status` 的角色写「主渠道 / 兜底（临时）」
  - systemd unit 的 Description 写「CodeBuddy 主 ⇄ TRAE 备」

这三处都不影响运行，但会误导下一个人（包括几个月后的我）以为链路还是两级。
这个项目已经吃过一次「文档说已上线、实际没跑过」的亏，所以文案也算缺陷。

## 用法
python3 patch-provider-labels.py
"""
import sys
import time

SCRIPT = "/opt/qq-bridge/switch-provider.sh"
UNIT = "/etc/systemd/system/qq-provider-switch.service"
STAMP = time.strftime("%Y%m%d-%H%M")


def sub_file(path, old, new, label):
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
    hits = src.count(old)
    if hits != 1:
        print("❌ [%s] 命中 %d 次，期望恰好 1 次。整份未写盘。" % (label, hits))
        sys.exit(1)
    with open(path + ".bak-" + STAMP, "w", encoding="utf-8") as fh:
        fh.write(src)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(src.replace(old, new))
    print("   ✓ %s" % label)


sub_file(
    SCRIPT,
    """    printf '角色           = %s\\n' "$([ "$(current_provider)" = "$A_PROVIDER" ] && echo '主渠道' || echo '兜底（临时）')"
""",
    """    printf '角色           = 候选链第 %s 级（链首即主渠道）\\n' "$(chain_index_of "$(current_provider)")"
""",
    "--status 角色行",
)

sub_file(
    SCRIPT,
    """log "provider 自动兜底守护启动（主 ${A_PROVIDER}，兜底 ${B_PROVIDER} 仅故障时临时用；滑动窗口=${WINDOW_SEC}s 阈值=${FAIL_THRESHOLD} 检查=${INTERVAL}s 冷却=${SWITCH_COOLDOWN_SEC}s 恢复探测=${RECOVER_PROBE_INTERVAL}s；当前=$(current_provider)）"
""",
    """log "provider 候选链守护启动（链 $(chain_names)；滑动窗口=${WINDOW_SEC}s 阈值=${FAIL_THRESHOLD}；慢判定：最近 ${SLOW_MIN_SAMPLES} 条平均首字 > ${SLOW_TTFT_MS}ms 连续 ${SLOW_STRIKES} 次；检查=${INTERVAL}s 冷却=${SWITCH_COOLDOWN_SEC}s 恢复探测=${RECOVER_PROBE_INTERVAL}s；当前=$(current_provider) 第 $(chain_index_of "$(current_provider)") 级）"
""",
    "启动日志行",
)

sub_file(
    UNIT,
    "Description=QQ provider 自动交替守护（CodeBuddy 主 ⇄ TRAE 备，永不切官方）",
    "Description=QQ provider 候选链守护（loomy → trae → raccoon，永不切官方）",
    "systemd Description",
)

print("✅ 文案已更新（备份后缀 .bak-%s）。记得 systemctl daemon-reload 让 unit 描述生效。" % STAMP)
