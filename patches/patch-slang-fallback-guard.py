#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-slang-fallback-guard.py

两件事：

1) 兜底渠道上跳过「黑话研究」。
   实测（2026-10-21 17:31:47 发出 → 17:44 会话文件仍在写）raccoon 上跑一次研究 turn
   要 12 分钟以上，注定超过任何合理超时；桥接侧放弃后那个 turn 还堵在 DSH 里，
   继续白烧上游额度、拖慢提取。role 由 switch-provider.sh 维护（primary/fallback），
   切回主渠道后研究自动恢复，不需要人手动开。

2) 提取 turn 超时 120s → 180s。
   兜底渠道上提取也时常在 120s 边缘（17:57:49 就超时过一次），
   给 60s 余量能显著降低「删档重建」的代价。

精确串替换 + 命中数断言，对不上就不写盘。
"""
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
DST = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bridge.fallback-guard.js'

with open(SRC, 'r', encoding='utf-8') as f:
    src = f.read()

edits = []


def sub(tag, old, new, expect=1):
    global src
    n = src.count(old)
    if n != expect:
        raise SystemExit(f'[FAIL] {tag}: 命中 {n} 次，期望 {expect} 次')
    src = src.replace(old, new, expect)
    edits.append(tag)


# ---- 1) 提取超时常量 ----
sub(
    'extract-timeout-const',
    "  const SLANG_RESEARCH_TIMEOUT_MS = 180000;                  // 研究 turn 等待上限",
    "  const SLANG_EXTRACT_TIMEOUT_MS = 180000;                   // 提取 turn 等待上限（兜底渠道 120s 常在边缘）\n"
    "  const SLANG_RESEARCH_TIMEOUT_MS = 180000;                  // 研究 turn 等待上限"
)

# ---- 2) 提取等 turn 用上新常量 ----
sub(
    'extract-uses-timeout',
    "      const output = await waitLearnerTurn(sessionId);",
    "      const output = await waitLearnerTurn(sessionId, SLANG_EXTRACT_TIMEOUT_MS);"
)

# ---- 3) 新增兜底渠道判断函数 + 节流日志时间戳 ----
NEW = '''
  // MARKER: slang-fallback-guard
  // 兜底渠道（慢）上跑一次黑话研究 turn 实测要 12 分钟以上，注定超过任何合理超时，
  // 只会白烧会话和上游额度，还反过来拖慢提取。只在主渠道做研究；
  // role 由 switch-provider.sh 写进 state/provider-switch.json（primary / fallback）。
  function slangResearchChannelIsFallback() {
    try {
      const st = readJsonSafe(path.join(STATE_DIR, 'provider-switch.json'), null);
      return String(st?.role ?? '') === 'fallback';
    } catch {
      return false;
    }
  }

'''

sub(
    'insert-fallback-checker',
    "  function invalidateSlangResearchSession() {",
    NEW + "  function invalidateSlangResearchSession() {"
)

sub(
    'fallback-skip-log-ts',
    "  let slangResearchBlockedUntil = 0;  // 研究专用退避：只压研究频率，不碰会话、不挡提取",
    "  let slangResearchBlockedUntil = 0;  // 研究专用退避：只压研究频率，不碰会话、不挡提取\n"
    "  let slangFallbackSkipLoggedAt = 0;  // 兜底跳过研究的日志节流（每小时一次）"
)

# ---- 4) 研究入口：兜底渠道直接跳过 ----
sub(
    'research-fallback-guard',
    "    // MARKER: slang-research-backoff —— 退避期内直接跳过，不建会话也不打日志，避免刷屏。\n"
    "    if (slangResearchBlockedUntil > Date.now()) return;",
    "    // MARKER: slang-research-backoff —— 退避期内直接跳过，不建会话也不打日志，避免刷屏。\n"
    "    if (slangResearchBlockedUntil > Date.now()) return;\n"
    "    if (slangResearchChannelIsFallback()) {\n"
    "      if (Date.now() - slangFallbackSkipLoggedAt > 3600000) {\n"
    "        slangFallbackSkipLoggedAt = Date.now();\n"
    "        log('黑话研究：当前在兜底渠道上，跳过（研究 turn 太慢，等切回主渠道后自动恢复；提取照常）');\n"
    "      }\n"
    "      return;\n"
    "    }"
)

with open(DST, 'w', encoding='utf-8') as f:
    f.write(src)

print('OK ->', DST)
for t in edits:
    print('  applied:', t)
print('bytes:', len(src.encode('utf-8')))
