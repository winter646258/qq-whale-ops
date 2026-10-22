#!/usr/bin/env python3
"""生图闸门：回合结束后给 90 秒宽限。

现场证据（14:36–14:38 采样，诊断为上一版补丁加的日志）：

    14:36:25 授予额度（group:906710082，无原因）   ← notify-ai
    14:36:27 拒绝：只有主人私聊…（reason 不是 atMention，正常）
    14:37:02 授予额度（group:906710082，question）
    14:37:18 status → ok:true scene=owner-group    ← 场景判定已修好，能画
    14:37:41 收回额度                                ← 回合结束
    14:37:51 授予额度（question）
    14:37:55 收回额度                                ← 只活了 4 秒
    14:38:18 拒绝：没有回合上下文

结论：imageSceneFor 的修复是有效的（owner-group 出现了），但「回合」太短
——trae 回一句话就 turn/end，她若在收尾阶段才想起画图，额度已经收回。

放宽依据：真正的安全闸是 imageSceneFor（必须「主人两分钟内发过言」且
「这轮是被 @/叫名字/提问唤起的」），它跟回合是否还活着无关。回合结束的
严格收回只防「下一轮借用上一轮的额度」，不防冒充——冒充由 scene 挡。
所以回合结束后留 90 秒宽限，不会让她在没人叫的时候乱画。

改动三处：
  1. 回合结束时记下 __qqTurnContextEnded = { key, at }（原来只置 null）
  2. imageAllowedNow 的 !ctx 分支：同一 key 且在宽限内则放行到 scene 判定
  3. 授予额度时清掉 ended 记录，避免旧记录被下一次误用
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

EDITS = [
    # 1) 回合结束：记下 key + reason + 时间（reason 必须留住，否则宽限里 scene 判不出 byMention）
    (
        """              if (globalThis.__qqTurnContext && String(globalThis.__qqTurnContext.key) === String(key)) {
                log(`[image] 收回额度（${key}）`);
                globalThis.__qqTurnContext = null;
              }""",
        """              if (globalThis.__qqTurnContext && String(globalThis.__qqTurnContext.key) === String(key)) {
                log(`[image] 收回额度（${key}）`);
                // 回合收工不等于「立刻不许画」：她可能正处在收尾阶段才想起要图。
                // 真正的安全闸是 imageSceneFor（主人确实 @ 过），这里只是怕跨轮借用。
                // reason 必须一起存：宽限分支要拿它判 byMention。
                globalThis.__qqTurnContextEnded = {
                  key,
                  reason: String(globalThis.__qqTurnContext.reason || ''),
                  at: Date.now()
                };
                globalThis.__qqTurnContext = null;
              }"""
    ),
    # 2) 授予额度时清掉 ended 记录
    (
        """    globalThis.__qqTurnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };
    log(`[image] 授予额度（${key}，${opts.wakeReason || '无原因'}）`);""",
        """    globalThis.__qqTurnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };
    globalThis.__qqTurnContextEnded = null;
    log(`[image] 授予额度（${key}，${opts.wakeReason || '无原因'}）`);"""
    ),
    # 3) !ctx 分支：同 key 且在宽限内 → 继续走 scene 判定
    (
        """    const ctx = globalThis.__qqTurnContext;
    if (!ctx) {
      log(`[image] 拒绝 ${key}：没有回合上下文`);
      return { ok: false, why: '当前没有进行中的对话' };
    }
    const turnWindowMs = Number(cfg.socialV2?.image?.turnWindowMs) || 600000;
    if (Date.now() - Number(ctx.at || 0) > turnWindowMs) {
      return { ok: false, why: '这一轮对话过去太久了，先跟主人说句话再画' };
    }
    if (String(ctx.key) !== String(key)) {
      return { ok: false, why: '这个会话不是当前正在进行的那个' };
    }
    const scene = imageSceneFor(key, String(ctx.reason || ''));""",
        """    let ctx = globalThis.__qqTurnContext;
    if (!ctx) {
      // 回合刚结束的宽限：同一个会话、90 秒内，还允许画。
      // 安全不靠这里，靠下面的 imageSceneFor（主人真的 @ 过才成立）。
      const ended = globalThis.__qqTurnContextEnded;
      const graceMs = Number(cfg.socialV2?.image?.turnGraceMs) || 90000;
      const fresh = ended && String(ended.key) === String(key) && Date.now() - Number(ended.at || 0) <= graceMs;
      if (!fresh) {
        log(`[image] 拒绝 ${key}：没有回合上下文`);
        return { ok: false, why: '当前没有进行中的对话' };
      }
      ctx = { key, reason: '', at: Number(ended.at || 0), grace: true };
      log(`[image] 宽限放行（${key}，回合结束后 ${Math.round((Date.now() - Number(ended.at || 0)) / 1000)}s）`);
    }
    const turnWindowMs = Number(cfg.socialV2?.image?.turnWindowMs) || 600000;
    if (!ctx.grace && Date.now() - Number(ctx.at || 0) > turnWindowMs) {
      return { ok: false, why: '这一轮对话过去太久了，先跟主人说句话再画' };
    }
    if (String(ctx.key) !== String(key)) {
      return { ok: false, why: '这个会话不是当前正在进行的那个' };
    }
    const scene = imageSceneFor(key, String(ctx.reason || ''));"""
    ),
]


def main():
    text = TARGET.read_text(encoding='utf-8')
    new = text
    for i, (old, rep) in enumerate(EDITS, 1):
        n = new.count(old)
        if n != 1:
            print(f'❌ 第 {i} 处命中 {n} 次（应为 1），拒绝写盘')
            return 1
        new = new.replace(old, rep)
    TARGET.write_text(new, encoding='utf-8')
    print('✅ bridge.js：生图闸门已加 90 秒回合结束宽限')
    return 0


if __name__ == '__main__':
    sys.exit(main())
