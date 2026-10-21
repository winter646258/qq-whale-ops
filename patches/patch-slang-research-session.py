#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-slang-research-session.py

把「黑话研究会话」从「黑话提取会话」里拆开。

背景（2026-10-21 实测）：
  raccoon（兜底渠道）上跑一次黑话研究 turn，DSH 侧实际要 12 分钟以上
  （17:31:47 发出 → 17:44 会话文件还在写）。桥接侧 180s 就放弃等待，
  但那个 turn 仍然堵在 DSH 会话队列里。提取和研究共用同一个会话，
  于是提取的 prompt 排在研究后面 → 120s 超时 → 连带提取也失败
  （17:38:27 日志）。分开之后提取永不被研究拖累。

改动点：
  1) 新增 SLANG_RESEARCH_SESSION_FILE
  2) 新增 slangResearchSessionId
  3) 新增 ensureSlangResearchSession() / invalidateSlangResearchSession()
  4) runSlangResearch 改用 ensureSlangResearchSession()
  5) 研究超时时丢弃「研究会话」（它是被堵住的那个，留着下轮更堵）
  6) token 记账把研究会话也归到 internal:黑话学习
  7) 研究会话 turn 结束后不必强制从 learnerSessions 移除

每处都是精确串替换 + 命中数断言，任何一处对不上就不写盘。
"""
import sys

SRC = sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js'
DST = sys.argv[2] if len(sys.argv) > 2 else '/tmp/bridge.patched.js'

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


# ---- 1) 研究会话存档文件 ----
sub(
    'session-file-const',
    "const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');",
    "const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');\n"
    "const SLANG_RESEARCH_SESSION_FILE = path.join(STATE_DIR, 'slang-research-session.json');  // MARKER: slang-research-session"
)

# ---- 2) 研究会话 id 变量 ----
sub(
    'session-id-let',
    "  let slangLearnerSessionId = null;",
    "  let slangLearnerSessionId = null;\n"
    "  let slangResearchSessionId = null;  // MARKER: slang-research-session"
)

# ---- 3) 新增两个函数（插在 invalidateSlangLearnerSession 之后、waitLearnerTurn 之前）----
NEW_FUNCS = '''
  // MARKER: slang-research-session
  // 研究会话与提取会话分离。慢渠道上一次研究 turn 可能要十几分钟（实测 12 分钟），
  // 共用会话会把提取的 prompt 排在它后面，导致提取也超时。分开后互不影响：
  // 研究的退避、重建、丢弃都只作用于研究会话。
  async function ensureSlangResearchSession() {
    if (slangLearnerBlockedUntil > Date.now()) {
      const left = Math.ceil((slangLearnerBlockedUntil - Date.now()) / 1000);
      throw new Error(`黑话研究会话退避中（还剩 ${left}s）：${slangLearnerLastFailure?.message ?? '上次失败'}`);
    }
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话研究缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_RESEARCH_SESSION_FILE, null);
    if (saved?.preset !== preset) invalidateSlangResearchSession();
    if (slangResearchSessionId) {
      learnerSessions.add(slangResearchSessionId);
      api.events.follow(slangResearchSessionId);
      return slangResearchSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangResearchSessionId = String(saved.sessionId);
      learnerSessions.add(slangResearchSessionId);
      api.events.follow(slangResearchSessionId);
      await ensureChatModel(slangResearchSessionId);
      return slangResearchSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang research workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang research session.create');
    slangResearchSessionId = value.sessionId;
    learnerSessions.add(slangResearchSessionId);
    api.events.follow(slangResearchSessionId);
    await ensureChatModel(slangResearchSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_RESEARCH_SESSION_FILE, { sessionId: slangResearchSessionId, preset });
    log(`黑话研究会话已创建：${slangResearchSessionId}`);
    return slangResearchSessionId;
  }

  function invalidateSlangResearchSession() {
    const oldId = slangResearchSessionId;
    slangResearchSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_RESEARCH_SESSION_FILE); } catch {}
  }

'''

sub(
    'insert-funcs',
    "    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}\n"
    "  }\n"
    "\n"
    "  function waitLearnerTurn(sessionId, timeoutMs = 120000) {",
    "    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}\n"
    "  }\n"
    + NEW_FUNCS +
    "  function waitLearnerTurn(sessionId, timeoutMs = 120000) {"
)

# ---- 4) 研究改用研究会话 ----
sub(
    'research-uses-research-session',
    "    let sessionId;\n"
    "    try {\n"
    "      sessionId = await ensureSlangLearnerSession();\n"
    "    } catch (error) {\n"
    "      for (const e of targets) slangResearchingIds.delete(e.id);\n"
    "      log('黑话研究会话创建失败:', error?.message ?? error);",
    "    let sessionId;\n"
    "    try {\n"
    "      sessionId = await ensureSlangResearchSession();\n"
    "    } catch (error) {\n"
    "      for (const e of targets) slangResearchingIds.delete(e.id);\n"
    "      log('黑话研究会话创建失败:', error?.message ?? error);"
)

# ---- 5) 超时分支：丢弃研究会话（并改掉与新设计矛盾的注释）----
sub(
    'timeout-drop-research-session',
    "      // MARKER: slang-research-backoff —— 超时只压研究频率，绝不 invalidate 会话：\n"
    "      // 会话是好的，这轮只是慢；删档重建会得到更冷的会话，下一轮照样超时。\n"
    "      if (classifySlangLearnerError(error?.message ?? error) === 'timeout') {\n"
    "        slangResearchBlockedUntil = Date.now() + SLANG_RESEARCH_TIMEOUT_BACKOFF_MS;\n"
    "        const mins = Math.round(SLANG_RESEARCH_TIMEOUT_BACKOFF_MS / 60000);\n"
    "        log(`黑话研究超时（${error?.message ?? error}）—— 会话保留（这轮慢，不是会话坏了），${mins} 分钟内暂停研究；提取不受影响`);",
    "      // MARKER: slang-research-backoff —— 超时只压研究频率。研究会话已与提取会话分离，\n"
    "      // 丢弃研究会话不影响提取。慢渠道上一轮研究 turn 可能十几分钟，超时那一刻它还堵在\n"
    "      // DSH 的会话队列里，留着它下一轮只会排得更久，所以直接丢掉、下次用新会话。\n"
    "      if (classifySlangLearnerError(error?.message ?? error) === 'timeout') {\n"
    "        slangResearchBlockedUntil = Date.now() + SLANG_RESEARCH_TIMEOUT_BACKOFF_MS;\n"
    "        invalidateSlangResearchSession();\n"
    "        const mins = Math.round(SLANG_RESEARCH_TIMEOUT_BACKOFF_MS / 60000);\n"
    "        log(`黑话研究超时（${error?.message ?? error}）—— 已丢弃研究会话（该 turn 仍堵在 DSH 队列里），${mins} 分钟内暂停研究；提取会话独立，不受影响`);"
)

# ---- 6) token 记账把研究会话也归到黑话学习 ----
sub(
    'token-ledger-research',
    "      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)\n"
    "        ? 'internal:黑话学习'\n"
    "        : undefined)",
    "      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)\n"
    "        || (slangResearchSessionId && sessionId === slangResearchSessionId)\n"
    "        ? 'internal:黑话学习'\n"
    "        : undefined)"
)

# ---- 7) 研究会话 turn 结束后不要被当成「旧学习会话」强制移除 ----
sub(
    'learner-sessions-cleanup',
    "                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);",
    "                  if (frame.sessionId !== slangLearnerSessionId && frame.sessionId !== slangResearchSessionId) learnerSessions.delete(frame.sessionId);"
)

with open(DST, 'w', encoding='utf-8') as f:
    f.write(src)

print('OK ->', DST)
for t in edits:
    print('  applied:', t)
print('bytes:', len(src.encode('utf-8')))
