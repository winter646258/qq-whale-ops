#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生图闸门从「固定 120 秒」改成「跟着回合走」。

背景
----
闸门原本用「这条唤醒发出后 120 秒内」当「回合还活着」的判据。但她一轮对话
经常超过两分钟（回消息、查记录、再画图），等她想画的时候秒表已经走完，被
自己的闸门拒掉。2026-10-22 07:24:46 她在真实对话里就撞上了：

    …我顺手想再试一次生成「吃白饭」的图，结果工具提示「当前没有进行中的对话」

改法
----
1. 回合收工时（bridge 事件循环里 collector 判定 ended 的分支）主动清空
   globalThis.__qqTurnContext —— 这一轮已经结束，不再借出额度。
2. 时间判据退化成兜底（默认 10 分钟，可用 cfg.socialV2.image.turnWindowMs
   覆盖）。它只防「turn/end 事件丢了、闸门永远开着」这一种异常。

语义没有放松
------------
没人跟她说话时 __qqTurnContext 本来就是 null，她自动醒来依然画不了；
群里非主人 @ 也依然被 imageSceneFor 拒。松掉的只是「一轮之内的时间上限」。

用法
----
    python3 patch-turn-gate.py [--dry-run] [bridge.js 路径]
"""
import sys
import io
import os
import shutil
import datetime

TARGET_DEFAULT = "/opt/qq-bridge/src/bridge.js"

# ── 1. 闸门本体：注释 + 时间窗口 ──────────────────────────────────────
OLD_GATE_DOC = """  /**
   * 路由侧的硬闸门：场景要对，且请求必须来自「正在进行的那个回合」。
   * 两分钟窗口的用处是：回合结束后留一点余量给慢工具调用，但不会被无限期借用。
   */
  function imageAllowedNow(key) {
    const ctx = globalThis.__qqTurnContext;
    if (!ctx || Date.now() - Number(ctx.at || 0) > 120000) {
      return { ok: false, why: '当前没有进行中的对话' };
    }
    if (String(ctx.key) !== String(key)) {
      return { ok: false, why: '这个会话不是当前正在进行的那个' };
    }
"""

NEW_GATE_DOC = """  /**
   * 路由侧的硬闸门：场景要对，且请求必须来自「正在进行的那个回合」。
   *
   * 「回合还活着吗」由回合结束时的主动清空来回答（见事件循环里 collector
   * 判定 ended 的分支）—— 那一轮收工，额度立刻收回。下面的时间判据只是兜底：
   * 万一 turn/end 事件丢了，别让闸门永远开着。
   */
  function imageAllowedNow(key) {
    const ctx = globalThis.__qqTurnContext;
    if (!ctx) {
      return { ok: false, why: '当前没有进行中的对话' };
    }
    const turnWindowMs = Number(cfg.socialV2?.image?.turnWindowMs) || 600000;
    if (Date.now() - Number(ctx.at || 0) > turnWindowMs) {
      return { ok: false, why: '这一轮对话过去太久了，先跟主人说句话再画' };
    }
    if (String(ctx.key) !== String(key)) {
      return { ok: false, why: '这个会话不是当前正在进行的那个' };
    }
"""

# ── 2. 回合收工：清空闸门上下文 ────────────────────────────────────────
OLD_TURN_END = """              v2TurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
"""

NEW_TURN_END = """              v2TurnStartAt.delete(frame.sessionId);
              // 回合收工就交还生图额度：这一轮已经结束，不该被下一轮借用。
              // 生图闸门「跟着回合走」靠的就是这一行（另见 imageAllowedNow）。
              if (globalThis.__qqTurnContext && String(globalThis.__qqTurnContext.key) === String(key)) {
                globalThis.__qqTurnContext = null;
              }
              collectors.delete(frame.sessionId);
"""


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f"❌ 命中数不对：{label} — 期望 1 处，实际 {n} 处，未写盘。")
        sys.exit(1)
    print(f"✅ {label}：命中 1 处")
    return text.replace(old, new, 1)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    path = args[0] if args else TARGET_DEFAULT

    if not os.path.isfile(path):
        print(f"❌ 找不到文件：{path}")
        sys.exit(1)

    with io.open(path, "r", encoding="utf-8") as f:
        text = f.read()

    before = text
    text = sub(text, OLD_GATE_DOC, NEW_GATE_DOC, "生图闸门改为回合驱动（含 10 分钟兜底）")
    text = sub(text, OLD_TURN_END, NEW_TURN_END, "回合收工清空 __qqTurnContext")

    if text == before:
        print("（无变化）")
        return

    if dry:
        print("\n— dry-run，未写盘 —")
        return

    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = f"{path}.bak-{stamp}"
    shutil.copy2(path, backup)
    with io.open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"\n✅ 已写入 {path}")
    print(f"   备份：{backup}")


if __name__ == "__main__":
    main()
