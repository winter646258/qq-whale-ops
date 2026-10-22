#!/usr/bin/env python3
"""生图闸门诊断日志：把「授予/收回/拒绝」三个时刻都打出来。

现象：群里 @ 她生图，她报「当前没有进行中的对话」。日志里连一条
「生图请求」都没有，说明在 imageAllowedNow 的 `!ctx` 分支就被拒了，
连 generateImageNow 都没进去。

加了这三行，就能看出 ctx 到底什么时候没的：

  [image] 授予额度（key，reason）   ← deliverPromptNow 开头
  [image] 收回额度（key）           ← 回合结束
  [image] 拒绝 key：没有回合上下文   ← imageAllowedNow

怀疑是 prompt 队列串行导致的时序错乱：同一 key 排了两条投递，第一条
的 turn/end 会把第二条刚设的 ctx 清掉。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

EDITS = [
    # 1) 授予
    (
        """    globalThis.__qqTurnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };""",
        """    globalThis.__qqTurnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };
    log(`[image] 授予额度（${key}，${opts.wakeReason || '无原因'}）`);"""
    ),
    # 2) 收回（turn/end 块深处，实际 14 空格缩进）
    (
        """              if (globalThis.__qqTurnContext && String(globalThis.__qqTurnContext.key) === String(key)) {
                globalThis.__qqTurnContext = null;
              }""",
        """              if (globalThis.__qqTurnContext && String(globalThis.__qqTurnContext.key) === String(key)) {
                log(`[image] 收回额度（${key}）`);
                globalThis.__qqTurnContext = null;
              }"""
    ),
    # 3) 拒绝
    (
        """    const ctx = globalThis.__qqTurnContext;
    if (!ctx) {
      return { ok: false, why: '当前没有进行中的对话' };
    }""",
        """    const ctx = globalThis.__qqTurnContext;
    if (!ctx) {
      log(`[image] 拒绝 ${key}：没有回合上下文`);
      return { ok: false, why: '当前没有进行中的对话' };
    }"""
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
    print('✅ bridge.js：生图闸门三处诊断日志已加')
    return 0


if __name__ == '__main__':
    sys.exit(main())
