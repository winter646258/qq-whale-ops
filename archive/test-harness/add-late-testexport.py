"""隔离验证：在**状态加载完成后**导出闭包函数，立即释放锁并返回。

时序约束（踩过）：
  - 太早（main 开头）⇒ `socialV2` 还没初始化，调 buildWakePromptV2 报
    "Cannot access 'socialV2' before initialization"
  - 所以在 loadSocialV2State() 之后导出
  - 但那之前 acquireLock() 已经拿过锁了 ⇒ 必须主动 releaseLock()，
    否则线上桥接下次重启会因为锁被占而拒启（交接文档的「过期锁」一节）

全程不打开 3100 端口、不连 SnowLuma / DSH，因此不会出现
「两个桥接实例抢 social-v2.json」的事故。只改隔离副本。
"""
import os
import sys

P = sys.argv[1]
MARK = 'MARKER: late-testexport'
src = open(P, encoding='utf-8', newline='').read()

if MARK in src:
    print('[skip] 已加过')
    raise SystemExit(0)

# 先撤掉之前那版过早的导出（如果存在）
early = '  // MARKER: early-testexport\n'
if early in src:
    start = src.index(early)
    end = src.index('    return;\n  }\n', start) + len('    return;\n  }\n')
    src = src[:start] + src[end:]
    print('已移除过早的导出')

anchor = '  loadSocialV2State();\n'
if src.count(anchor) != 1:
    print(f'[x] 锚点匹配 {src.count(anchor)} 次（预期 1）')
    raise SystemExit(1)

hook = """  loadSocialV2State();

  // MARKER: late-testexport
  // 仅供隔离验证：状态已加载，导出闭包函数后立刻放锁返回。
  // 不 open 端口、不连网关，避免第二个实例抢状态文件。
  if (process.env.BRIDGE_TEST_EXPORT === '1') {
    globalThis.__bridgeTest = {
      getSocialV2State,
      buildWakePromptV2,
      formatMemoryV2,
      formatScheduleForPrompt,
      formatPortraitForPrompt,
      scheduleStore,
      portraitStore
    };
    globalThis.__bridgeTestReady = true;
    try { releaseLock(); } catch {}
    return;
  }
"""

src = src.replace(anchor, hook, 1)
with open(P + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(P + '.tmp', P)
print(f'[ok] 已加 late-testexport（{P}）')
