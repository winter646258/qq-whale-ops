import io

src = io.open('bridge-patched7.js', encoding='utf-8').read()
anchor = "  setInterval(sweepPendingWakeReasons, 30_000).unref?.();\n"
assert src.count(anchor) == 1, src.count(anchor)

hook = anchor + """
  // MARKER: test-hook-item7（仅测试副本使用，不随生产发布）
  if (process.env.BRIDGE_TEST_EXPORT === '1') {
    const api = {
      releaseLock, STATE_DIR, SLANG_SESSION_FILE, STICKER_FILE, cfg,
      // 表情包
      stickerEntries, findSticker, resolveStickerRef, stickerRefError,
      // 黑话学习会话
      classifySlangLearnerError, decideSlangLearnerAction, handleSlangLearnerFailure,
      noteSlangLearnerHealthy, ensureSlangLearnerSession,
      slangState: () => ({
        blockedUntil: slangLearnerBlockedUntil,
        rebuildAt: slangLearnerRebuildAt.slice(),
        last: slangLearnerLastFailure,
        sessionId: slangLearnerSessionId,
      }),
    };
    try {
      const mod = await import(process.env.BRIDGE_TEST_SCRIPT);
      await mod.default(api);
    } catch (e) {
      console.error('TEST_FAIL', e && e.stack ? e.stack : e);
      process.exitCode = 1;
    } finally {
      try { releaseLock(); } catch (e) {}
    }
    process.exit(process.exitCode || 0);
  }
"""

io.open('bridge-hook7-test.js', 'w', encoding='utf-8', newline='').write(src.replace(anchor, hook))
print('hook7 copy written', len(src))
