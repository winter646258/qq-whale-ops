#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""黑话研究超时死循环修复（bridge.js）

现象（2026-10-21 16:35 起）：每 2 分钟一条
  `黑话研究失败（timeout，会话已标记失效）: 等待学习会话 turn 超时(120000ms)`
后面紧跟 `黑话学习会话已创建：session-xxx`，一路不停。

根因有两层：
  1. `waitLearnerTurn(sessionId)` 默认 120s。raccoon 是慢渠道（首答 55s，复杂研究 turn
     超过 120s），必然超时。
  2. `classifySlangLearnerError` 把 timeout 归到「重建」分支 → `invalidateSlangLearnerSession()`
     删档重建。冷会话第一次 turn 更慢 → 又超时。恶性循环，每 2 分钟白建一个 DSH 会话。
  3. 限流（30min 内最多重建 3 次）永远不触发：`runSlangExtraction` 每次成功都调
     `noteSlangLearnerHealthy()`，把 `slangLearnerRebuildAt` 清空 —— 提取和研究共用同一份
     重建预算，提取一成功就替研究把账销了。

修法（不动会话、不动提取）：
  - timeout 不再重建会话：会话没坏，只是这一轮慢。删了只会更冷更慢。
  - 改由「研究专用退避」压频率：`slangResearchBlockedUntil`，只拦研究，不拦提取。
  - 研究 turn 超时放宽到 180s（给慢渠道多 50% 余量，代价可控）。
  - 研究成功时清空退避。
"""
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
DST = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bridge.patched.js'

t = open(SRC, encoding='utf-8').read()


def rep(old, new, expect, label):
    global t
    n = t.count(old)
    if n != expect:
        raise SystemExit(f'[{label}] 命中 {n} 处，期望 {expect}，未写盘')
    t = t.replace(old, new)


# ── 0) provider 正则补额度关键词 ───────────────────────────────────────────
# 原正则只有 quota|额度，而实际报错文案是「loomy: 积分余额不足，请获取积分后再试」，
# 一个词都不命中 → 被归为 unknown → 走「重建但不重试」→ 额度耗尽时反复删档重建。
# 这正是交接文档 3.3 想修的那类问题，只是关键词漏了。
rep(
    "if (/Illegal API invocation|unapproved channel|请求被拦截|unauthorized|forbidden|401|403|quota|额度/i.test(m)) return 'provider';",
    "if (/Illegal API invocation|unapproved channel|请求被拦截|unauthorized|forbidden|401|403|quota|额度|余额不足|积分不足|积分余额|balance|insufficient/i.test(m)) return 'provider';",
    1,
    'provider 额度关键词',
)

# ── 1) 常量：研究专用超时 + 退避 ────────────────────────────────────────────
rep(
    "  const SLANG_LEARNER_PROVIDER_BACKOFF_MS = 10 * 60 * 1000;  // provider 类失败的退避\n",
    "  const SLANG_LEARNER_PROVIDER_BACKOFF_MS = 10 * 60 * 1000;  // provider 类失败的退避\n"
    "  // 2026-10-21：研究 turn 在慢渠道（raccoon）上会超过 120s。超时不是「会话坏了」，\n"
    "  // 重建只会更慢；改为加大超时 + 研究专用退避，把频率压下来而不动会话。\n"
    "  const SLANG_RESEARCH_TIMEOUT_MS = 180000;                  // 研究 turn 等待上限\n"
    "  const SLANG_RESEARCH_TIMEOUT_BACKOFF_MS = 15 * 60 * 1000;  // 研究超时后的退避\n",
    1,
    '研究超时/退避常量',
)

# ── 2) 变量：研究专用退避时间戳 ─────────────────────────────────────────────
rep(
    "  let slangLearnerLastFailure = null; // { at, kind, message }\n",
    "  let slangLearnerLastFailure = null; // { at, kind, message }\n"
    "  let slangResearchBlockedUntil = 0;  // 研究专用退避：只压研究频率，不碰会话、不挡提取\n",
    1,
    '研究退避变量',
)

# ── 3) 研究入口：退避期内静默跳过 ───────────────────────────────────────────
rep(
    "  async function runSlangResearch(candidates, opts = {}) {\n"
    "    if (!candidates || !candidates.length) return;\n"
    "    if (cfg.slang?.enabled === false) return;\n"
    "    if (!dshReady) return;\n",
    "  async function runSlangResearch(candidates, opts = {}) {\n"
    "    if (!candidates || !candidates.length) return;\n"
    "    if (cfg.slang?.enabled === false) return;\n"
    "    if (!dshReady) return;\n"
    "    // MARKER: slang-research-backoff —— 退避期内直接跳过，不建会话也不打日志，避免刷屏。\n"
    "    if (slangResearchBlockedUntil > Date.now()) return;\n",
    1,
    '研究入口退避',
)

# ── 4) 研究 turn 超时放宽 ───────────────────────────────────────────────────
rep(
    "      const output = await waitLearnerTurn(sessionId);\n"
    "      const results = parseResearchJson(output);\n",
    "      const output = await waitLearnerTurn(sessionId, SLANG_RESEARCH_TIMEOUT_MS);\n"
    "      const results = parseResearchJson(output);\n",
    1,
    '研究 turn 超时',
)

# ── 5) 研究成功：清空退避 ───────────────────────────────────────────────────
rep(
    "      log(`黑话研究：已更新 ${results.length} 条候选解释`);\n"
    "      noteSlangLearnerHealthy();  // MARKER: item7-slang\n",
    "      log(`黑话研究：已更新 ${results.length} 条候选解释`);\n"
    "      slangResearchBlockedUntil = 0;\n"
    "      noteSlangLearnerHealthy();  // MARKER: item7-slang\n",
    1,
    '研究成功清退避',
)

# ── 6) catch：timeout 不再走「删档重建」────────────────────────────────────
rep(
    "    } catch (error) {\n"
    "      // MARKER: item7-slang\n"
    "      if (handleSlangLearnerFailure('黑话研究', error) && !opts.retried) {\n",
    "    } catch (error) {\n"
    "      // MARKER: item7-slang\n"
    "      // MARKER: slang-research-backoff —— 超时只压研究频率，绝不 invalidate 会话：\n"
    "      // 会话是好的，这轮只是慢；删档重建会得到更冷的会话，下一轮照样超时。\n"
    "      if (classifySlangLearnerError(error?.message ?? error) === 'timeout') {\n"
    "        slangResearchBlockedUntil = Date.now() + SLANG_RESEARCH_TIMEOUT_BACKOFF_MS;\n"
    "        const mins = Math.round(SLANG_RESEARCH_TIMEOUT_BACKOFF_MS / 60000);\n"
    "        log(`黑话研究超时（${error?.message ?? error}）—— 会话保留（这轮慢，不是会话坏了），${mins} 分钟内暂停研究；提取不受影响`);\n"
    "      } else if (handleSlangLearnerFailure('黑话研究', error) && !opts.retried) {\n",
    1,
    '研究 catch 超时分流',
)

open(DST, 'w', encoding='utf-8').write(t)
print(f'OK -> {DST}  ({len(t)} bytes)')
