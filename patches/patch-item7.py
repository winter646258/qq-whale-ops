#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-item7.py — 计划 6（原「7+」）：黑话学习会话失效检测 / 表情包引用解析

两个独立改动，都只碰 src/bridge.js：

A. 黑话学习会话：把「猜失效」换成「分类 + 一次性重建 + 退避」
   旧实现两处 catch 都用 /会话|session|not found|404/ 判断失效，实测两头都错：
     · 误判：`学习会话 turn 未正常完成：error` 含「会话」二字 ⇒ 被当成会话失效，
       于是 provider 坏掉时每 30 秒删档重建一个新会话（10-21 一天建了 4 个：
       6ced0b6d / 2bd6c7bf / de7d8bc4 / 9d51104f，全在 DSH 里留成垃圾）。
     · 漏判：`等待学习会话 turn 超时(120000ms)` 不含这两个词 ⇒ 真·陈旧会话反而不重建。
   改法：classifySlangLearnerError() 把失败分成 provider / stale / timeout / unknown；
        provider 类只退避（重建用的是同一个坏渠道，没意义）；
        stale 类立刻重建并在本次调用里重试一次（换新会话，同一份素材还有机会）；
        timeout/unknown 重建但不重试；30 分钟内最多重建 3 次，超了暂停自动研究。
    成功一次即清空退避与重建计数。

B. 表情包：qq_send_sticker 的 stickerId 支持「按描述兜底解析」
   实测 2026-10-21 01:01:40Z 她传 `stickerId:"你这吃白饭的蓝色大肥鱼"`（描述而不是 id）直接失败，
   7 秒后自己改用 qq_list_stickers 查到 mfuns-11 才发出去。
   改法：唯一命中就直接用；多个命中把候选 id 列出来让她挑；一个都没中时给出真实 id 样例。
   只改「发送」和「取图」两处；setStickerRemarkV2 保持精确匹配（模糊匹配会把备注贴错表情）。

用法：
    python3 patch-item7.py            # 在 bridge-patched.js 基础上生成 bridge-patched7.js
    python3 patch-item7.py --inplace  # 直接改 bridge-patched.js（先自己备份）

回滚：把 bridge.js.bak-item7-<时间戳> 拷回去，systemctl restart qq-bridge。
"""

import sys
import io

SRC = 'bridge-patched.js'
OUT = 'bridge-patched7.js'

def main():
    inplace = '--inplace' in sys.argv
    with io.open(SRC, encoding='utf-8') as f:
        text = f.read()
    original_len = len(text)

    def rep(old, new, expect=1, label=''):
        nonlocal text
        got = text.count(old)
        if got != expect:
            raise SystemExit(f'[FAIL] {label}: 期望命中 {expect} 处，实际 {got} 处 —— 不写盘')
        text = text.replace(old, new, expect)
        print(f'  ok  {label}')

    # ── A1. 状态与纯函数 ─────────────────────────────────────────────
    rep(
        "  const learnerCollectors = new Map();  // sessionId -> turn collector\n"
        "  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]",
        """  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]

  // MARKER: item7-slang
  // 黑话学习会话的失效判定与重建预算（见 patch-item7.py 头部「为什么」）。
  const SLANG_LEARNER_REBUILD_MAX = 3;                       // 窗口内最多重建几次
  const SLANG_LEARNER_REBUILD_WINDOW_MS = 30 * 60 * 1000;    // 重建预算窗口
  const SLANG_LEARNER_PROVIDER_BACKOFF_MS = 10 * 60 * 1000;  // provider 类失败的退避
  const slangLearnerRebuildAt = [];   // 最近的重建时间戳
  let slangLearnerBlockedUntil = 0;   // 在此之前不再创建/复用学习会话
  let slangLearnerLastFailure = null; // { at, kind, message }

  // 把学习会话的失败分类。纯函数，便于单测。
  function classifySlangLearnerError(message) {
    const m = String(message ?? '');
    if (/Illegal API invocation|unapproved channel|请求被拦截|unauthorized|forbidden|401|403|quota|额度/i.test(m)) return 'provider';
    if (/not[- ]?found|no such session|404|不存在|已删除|已归档|已失效/i.test(m)) return 'stale';
    if (/超时|timeout/i.test(m)) return 'timeout';
    return 'unknown';
  }

  // 该不该重建、该不该退避。纯函数。
  // 关键取舍：provider 坏掉时重建没有意义 —— 新会话还是那个坏渠道，只会白建会话。
  function decideSlangLearnerAction({ kind, now = Date.now(), rebuildTimes = slangLearnerRebuildAt, blockedUntil = slangLearnerBlockedUntil } = {}) {
    const at = Number(now) || Date.now();
    if (Number(blockedUntil) > at) {
      return { action: 'backoff', rebuild: false, retry: false, waitMs: Number(blockedUntil) - at, reason: 'cooling' };
    }
    if (kind === 'provider') {
      return { action: 'backoff', rebuild: false, retry: false, waitMs: SLANG_LEARNER_PROVIDER_BACKOFF_MS, reason: 'provider' };
    }
    const recent = (Array.isArray(rebuildTimes) ? rebuildTimes : [])
      .filter((t) => at - Number(t) < SLANG_LEARNER_REBUILD_WINDOW_MS);
    if (recent.length >= SLANG_LEARNER_REBUILD_MAX) {
      return { action: 'exhausted', rebuild: false, retry: false, waitMs: 0, reason: 'budget' };
    }
    // 真正的陈旧会话：立刻重建，并允许调用方在同一轮里重试一次。
    if (kind === 'stale') return { action: 'rebuild', rebuild: true, retry: true, waitMs: 0, reason: 'stale' };
    // 超时 / 未知：重建但不重试（重试只是把同一份 prompt 再压一遍）。
    return { action: 'rebuild', rebuild: true, retry: false, waitMs: 0, reason: kind };
  }

  function noteSlangLearnerRebuild(now = Date.now()) {
    slangLearnerRebuildAt.push(now);
    const keep = slangLearnerRebuildAt.filter((t) => now - Number(t) < SLANG_LEARNER_REBUILD_WINDOW_MS);
    slangLearnerRebuildAt.length = 0;
    slangLearnerRebuildAt.push(...keep);
  }

  // 成功一次即认为会话与渠道都活着：清掉退避和重建计数。
  function noteSlangLearnerHealthy() {
    if (slangLearnerBlockedUntil) log('黑话学习会话已恢复，解除退避');
    slangLearnerBlockedUntil = 0;
    slangLearnerRebuildAt.length = 0;
    slangLearnerLastFailure = null;
  }

  // 统一处理一次学习会话失败。返回 true 表示「已重建，调用方可以重试一次」。
  function handleSlangLearnerFailure(scope, error) {
    const message = String(error?.message ?? error ?? '');
    const kind = classifySlangLearnerError(message);
    const decision = decideSlangLearnerAction({ kind });
    slangLearnerLastFailure = { at: Date.now(), kind, message };
    if (decision.rebuild) {
      noteSlangLearnerRebuild();
      invalidateSlangLearnerSession();
      log(`${scope}失败（${kind}，会话已标记失效）: ${message}`);
      return decision.retry === true;
    }
    const minutes = Math.max(1, Math.round(decision.waitMs / 60000));
    if (decision.reason === 'provider') {
      slangLearnerBlockedUntil = Date.now() + decision.waitMs;
      log(`${scope}失败（provider）: ${message} —— 渠道问题，重建会话无用，${minutes} 分钟内不再尝试`);
      return false;
    }
    if (decision.action === 'backoff') {
      log(`${scope}跳过（退避中，还剩约 ${minutes} 分钟）: ${message}`);
      return false;
    }
    slangLearnerBlockedUntil = Date.now() + SLANG_LEARNER_PROVIDER_BACKOFF_MS;
    log(`${scope}失败（${kind}）: ${message} —— ${Math.round(SLANG_LEARNER_REBUILD_WINDOW_MS / 60000)} 分钟内已重建 ${SLANG_LEARNER_REBUILD_MAX} 次，暂停自动研究 ${minutes} 分钟`);
    return false;
  }""",
        label='A1 学习会话状态与纯函数',
    )

    # ── A2. ensure 里加退避闸门 ─────────────────────────────────────
    rep(
        "  async function ensureSlangLearnerSession() {\n"
        "    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });",
        """  async function ensureSlangLearnerSession() {
    // MARKER: item7-slang
    // 退避期内不建也不复用：provider 坏掉时每次重建都会在 DSH 里留下一个废会话。
    if (slangLearnerBlockedUntil > Date.now()) {
      const left = Math.ceil((slangLearnerBlockedUntil - Date.now()) / 1000);
      throw new Error(`黑话学习会话退避中（还剩 ${left}s）：${slangLearnerLastFailure?.message ?? '上次失败'}`);
    }
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });""",
        label='A2 ensure 退避闸门',
    )

    # ── A3. 提取：签名带 opts + catch 分类 + 成功记恢复 ─────────────
    rep(
        "  async function runSlangExtraction(key) {",
        "  async function runSlangExtraction(key, opts = {}) {",
        label='A3a runSlangExtraction 签名',
    )
    rep(
        "    } catch (error) {\n"
        "      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {\n"
        "        invalidateSlangLearnerSession();\n"
        "      }\n"
        "      log(`黑话提取失败 (${key}):`, error?.message ?? error);\n"
        "    }",
        """    } catch (error) {
      // MARKER: item7-slang
      // 旧逻辑用 `/会话|session/` 猜失效：既误判（「学习会话 turn 未正常完成」也含「会话」），
      // 又漏判（超时文案里没有这两个词）。改成分类 + 一次性重建。
      if (handleSlangLearnerFailure(`黑话提取 (${key})`, error) && !opts.retried) {
        queueSlangTask(() => runSlangExtraction(key, { retried: true }));
      }
    }""",
        label='A3b 提取 catch',
    )
    rep(
        "      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);",
        "      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);\n"
        "      noteSlangLearnerHealthy();  // MARKER: item7-slang",
        label='A3c 提取成功记恢复',
    )

    # ── A4. 研究：签名带 opts + catch 分类 + 成功记恢复 ─────────────
    rep(
        "  async function runSlangResearch(candidates) {",
        "  async function runSlangResearch(candidates, opts = {}) {",
        label='A4a runSlangResearch 签名',
    )
    rep(
        "    } catch (error) {\n"
        "      if (/会话|session|not found|404/i.test(String(error?.message ?? error))) {\n"
        "        invalidateSlangLearnerSession();\n"
        "      }\n"
        "      log('黑话研究失败:', error?.message ?? error);\n"
        "    } finally {",
        """    } catch (error) {
      // MARKER: item7-slang
      if (handleSlangLearnerFailure('黑话研究', error) && !opts.retried) {
        // 这里排队而不是直接 await：catch 之后 finally 才会把这些 id 从
        // slangResearchingIds 里移除，立刻重跑会被自己的去重挡掉。
        queueSlangTask(() => runSlangResearch(targets, { retried: true }));
      }
    } finally {""",
        label='A4b 研究 catch',
    )
    rep(
        "      log(`黑话研究：已更新 ${results.length} 条候选解释`);",
        "      log(`黑话研究：已更新 ${results.length} 条候选解释`);\n"
        "      noteSlangLearnerHealthy();  // MARKER: item7-slang",
        label='A4c 研究成功记恢复',
    )

    # ── B1. 表情引用解析纯函数 ─────────────────────────────────────
    rep(
        "  // 取单个表情的图片字节（多模态用）。\n"
        "  async function getStickerImageData(stickerId) {",
        """  // MARKER: item7-sticker
  // 把「她说的表情」解析成一条表情记录。
  //
  // 为什么需要：qq_send_sticker 只接受 id（emoji_id / md5 / url），但实测她会把**描述**当 id 传：
  // 2026-10-21 01:01:40Z `stickerId:"你这吃白饭的蓝色大肥鱼"` 直接失败，
  // 7 秒后自己改用 qq_list_stickers 查到 mfuns-11 才发出去。
  // 所以补一层「按描述/备注/标签」的兜底：唯一命中直接用；多个命中把候选列给她；一个都没中给 id 样例。
  // 纯函数（entries 进、结果出），便于单测。
  function resolveStickerRef(entries, ref) {
    const list = Array.isArray(entries) ? entries : [];
    const raw = String(ref ?? '').trim().replace(/^[「『“"'《[]+|[」』”"'》\\]]+$/g, '').trim();
    if (!raw) return { entry: null, how: 'empty', candidates: [] };
    const exact = findSticker(list, raw);
    if (exact) return { entry: exact, how: 'exact', candidates: [] };
    const q = raw.toLowerCase();
    const scored = [];
    for (const e of list) {
      if (!e) continue;
      const fields = [e.desc, e.localNote, e.usage, ...(Array.isArray(e.tags) ? e.tags : [])]
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      let score = 0;
      for (const f of fields) {
        const lf = f.toLowerCase();
        if (!lf) continue;
        if (lf === q) score = Math.max(score, 100);
        else if (lf.includes(q)) score = Math.max(score, 80);
        // 长描述只比开头，避免「你这吃白饭的蓝色大肥鱼」和整段备注永远不相等
        else if (q.length >= 4 && lf.includes(q.slice(0, 4))) score = Math.max(score, 40);
      }
      if (score > 0) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => b.score - a.score || (Number(b.entry.useCount) || 0) - (Number(a.entry.useCount) || 0));
    if (!scored.length) return { entry: null, how: 'none', candidates: [] };
    const first = scored[0];
    const second = scored[1];
    // 只有「描述完全相同、且没有并列」才敢直接用；否则让她自己挑，避免发错图。
    if (first.score >= 100 && first.score > (second?.score ?? 0)) {
      return { entry: first.entry, how: 'desc', candidates: [] };
    }
    if (scored.length === 1) return { entry: first.entry, how: 'desc', candidates: [] };
    return { entry: null, how: 'ambiguous', candidates: scored.slice(0, 5).map((s) => s.entry) };
  }

  // 把候选/样例拼成一句人话，避免她只看到「找不到」三个字。
  function stickerRefError(ref, resolution, entries) {
    const list = Array.isArray(entries) ? entries : [];
    const label = String(ref ?? '').trim() || '(空)';
    if (resolution?.how === 'ambiguous') {
      const lines = (resolution.candidates || []).map((e) => `- ${e.id}：${String(e.localNote || e.desc || '').slice(0, 30)}`);
      return `表情「${label}」匹配到多个，请从下面挑一个 id 重发：\\n${lines.join('\\n')}`;
    }
    const samples = list.filter((e) => e && e.id).slice(0, 3)
      .map((e) => `${e.id}（${String(e.localNote || e.desc || '').slice(0, 16)}）`);
    return `找不到表情「${label}」。stickerId 必须是 id 而不是描述；先用 qq_list_stickers（可带 query）查到 id 再发。`
      + `现有 id 样例：${samples.join('、') || '（库里没有表情）'}`;
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {""",
        label='B1 表情解析纯函数',
    )

    # ── B2. 取图改用解析器 ─────────────────────────────────────────
    rep(
        "    const synced = await syncStickerLibrary(false);\n"
        "    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);\n"
        "    if (!entry) {\n"
        "      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）\n"
        "      const forced = await syncStickerLibrary(true);\n"
        "      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);\n"
        "      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);\n"
        "      return entry2;\n"
        "    }\n"
        "    return entry;",
        """    const synced = await syncStickerLibrary(false);
    const pool = synced?.entries ?? stickerEntries;
    const found = resolveStickerRef(pool, stickerId);  // MARKER: item7-sticker
    if (found.entry) return found.entry;
    // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
    const forced = await syncStickerLibrary(true);
    const pool2 = forced?.entries ?? stickerEntries;
    const found2 = resolveStickerRef(pool2, stickerId);
    if (!found2.entry) throw new Error(stickerRefError(stickerId, found2, pool2));
    return found2.entry;""",
        label='B2 取图用解析器',
    )

    # ── B3. 发送改用解析器 ─────────────────────────────────────────
    rep(
        "    const synced = await syncStickerLibrary(true);\n"
        "    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);\n"
        "    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);",
        """    const synced = await syncStickerLibrary(true);
    const pool = synced?.entries ?? stickerEntries;
    const resolution = resolveStickerRef(pool, stickerRef);  // MARKER: item7-sticker
    if (!resolution.entry) throw new Error(stickerRefError(stickerRef, resolution, pool));
    const entry = resolution.entry;
    // 按描述兜底解析成功时留一行日志：既能看出她习惯怎么称呼表情，也方便查「发错图」。
    if (resolution.how !== 'exact') log(`[sticker] 表情引用「${stickerRef}」按${resolution.how === 'desc' ? '描述' : resolution.how}解析到 ${entry.id}`);""",
        label='B3 发送用解析器',
    )

    out = SRC if inplace else OUT
    with io.open(out, 'w', encoding='utf-8', newline='') as f:
        f.write(text)
    print(f'\n[OK] {original_len} -> {len(text)} 字节，已写入 {out}')
    for m in ['item7-slang', 'item7-sticker']:
        print(f'  标记 {m}: {text.count(m)} 处')


if __name__ == '__main__':
    main()
