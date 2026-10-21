// item7 server-side probe: 隔离副本里用「线上真实表情库 + 真实日志文案」验，不碰生产 state。
import fs from 'node:fs';

let pass = 0;
const fails = [];
const notes = [];
const ok = (c, l) => { if (c) pass += 1; else fails.push(l); };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (${JSON.stringify(a)} !== ${JSON.stringify(b)})`);

export default async function run(api) {
  const {
    STATE_DIR, STICKER_FILE, SLANG_SESSION_FILE, cfg,
    stickerEntries, findSticker, resolveStickerRef, stickerRefError,
    classifySlangLearnerError, handleSlangLearnerFailure, noteSlangLearnerHealthy,
    ensureSlangLearnerSession, slangState
  } = api;

  try {
    // ── 0. 隔离 ──
    ok(STATE_DIR.includes('/tmp/item7-test'), '0.1 状态目录已隔离 ' + STATE_DIR);
    ok(!STATE_DIR.startsWith('/opt/qq-bridge'), '0.2 没有指向生产目录');
    const stickerMtimeBefore = fs.existsSync(STICKER_FILE) ? fs.statSync(STICKER_FILE).mtimeMs : -1;
    notes.push('表情库文件 ' + STICKER_FILE + ' mtime=' + stickerMtimeBefore);

    // ── 1. 真实表情库读得出 ──
    ok(Array.isArray(stickerEntries), '1.1 stickerEntries 是数组');
    ok(stickerEntries.length > 1000, `1.2 真实库条数 ${stickerEntries.length} > 1000`);
    const withDesc = stickerEntries.filter((e) => String(e?.desc ?? '').trim());
    notes.push(`有 desc 的表情 ${withDesc.length} 条`);
    ok(withDesc.length > 50, '1.3 有足够多带描述的表情可供解析');

    // ── 2. 复现原始 bug：描述当 id 传，旧路径必然失败 ──
    const target = stickerEntries.find((e) => String(e?.id ?? '') === 'mfuns-11' && String(e?.desc ?? '').trim())
      || withDesc[0];
    ok(!!target, '2.1 找到样本表情 ' + (target?.id ?? '无'));
    eq(findSticker(stickerEntries, target.desc), null, `2.2 旧 findSticker 认不出描述「${target.desc}」`);
    const fixed = resolveStickerRef(stickerEntries, target.desc);
    eq(fixed.how, 'desc', '2.3 新 resolveStickerRef 能按描述解析');
    eq(fixed.entry?.id, target.id, '2.4 解析到的正是目标 id');

    // ── 3. 线上那次真实失败案例（10-21 01:01:40Z） ──
    const hist = resolveStickerRef(stickerEntries, '你这吃白饭的蓝色大肥鱼');
    if (hist.entry) {
      eq(hist.how, 'desc', '3.1 线上那条失败文案按 desc 解析成功');
      eq(hist.entry.desc, '你这吃白饭的蓝色大肥鱼', '3.2 命中的是 desc 与输入完全一致的那一条（不是模糊猜）');
      notes.push('历史案例解析成功 -> ' + hist.entry.id);
    } else {
      notes.push('历史案例不在当前库（how=' + hist.how + '），跳过');
      ok(hist.how !== 'desc', '3.1 历史案例未命中或歧义时不会瞎猜');
    }

    // ── 4. 100 条真实 id 必须仍然精确命中（不能因为新解析器把 id 走歪） ──
    let exactBad = 0;
    const sample = stickerEntries.slice(0, 100);
    for (const e of sample) {
      if (!e?.id) continue;
      const r = resolveStickerRef(stickerEntries, e.id);
      if (r.how !== 'exact' || r.entry?.id !== e.id) exactBad += 1;
    }
    eq(exactBad, 0, `4.1 抽样 ${sample.length} 条 id 全部走精确匹配且指向自身`);

    // ── 5. 歧义不瞎猜（用真实库里同 desc 的组） ──
    const byDesc = new Map();
    for (const e of withDesc) {
      const k = String(e.desc).trim();
      if (!byDesc.has(k)) byDesc.set(k, []);
      byDesc.get(k).push(e);
    }
    const dupKey = [...byDesc.entries()].find(([, v]) => v.length > 1)?.[0];
    if (dupKey) {
      const r = resolveStickerRef(stickerEntries, dupKey);
      eq(r.how, 'ambiguous', `5.1 真实库里重名描述「${dupKey}」判为歧义`);
      ok(r.candidates.length > 1, '5.2 歧义时给出候选');
      ok(!r.entry, '5.3 歧义时不返回 entry');
      const msg = stickerRefError(dupKey, r, stickerEntries);
      ok(msg.includes(r.candidates[0].id), '5.4 歧义文案带候选 id');
    } else {
      notes.push('真实库里没有重名 desc，歧义用合成数据验（已在本地测试覆盖）');
    }

    // ── 6. 完全没命中时的文案 ──
    const noneMsg = stickerRefError('根本不存在的表情xyz', resolveStickerRef(stickerEntries, '根本不存在的表情xyz'), stickerEntries);
    ok(noneMsg.includes('必须是 id 而不是描述'), '6.1 没命中时讲清 id vs 描述');
    ok(noneMsg.includes('qq_list_stickers'), '6.2 指路 qq_list_stickers');

    // ── 7. 表情库没被写脏 ──
    const stickerMtimeAfter = fs.existsSync(STICKER_FILE) ? fs.statSync(STICKER_FILE).mtimeMs : -1;
    eq(stickerMtimeAfter, stickerMtimeBefore, '7.1 解析过程没有改写表情库');

    // ── 8. 失败分类跑在真实日志文案上 ──
    const realProvider = 'agent 处理出错 (private:2050117833): buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel';
    eq(classifySlangLearnerError(realProvider), 'provider', '8.1 真实 buddy 报错归 provider');
    eq(classifySlangLearnerError('学习会话 turn 未正常完成：error'), 'unknown', '8.2 真实 turn error 不再被误判成 stale');
    eq(classifySlangLearnerError('等待学习会话 turn 超时(120000ms)'), 'timeout', '8.3 真实超时文案归 timeout');

    // ── 9. provider 坏：退避、不删档、不重建 ──
    noteSlangLearnerHealthy();
    const hadSession = fs.existsSync(SLANG_SESSION_FILE);
    const ret = handleSlangLearnerFailure('黑话研究', new Error(realProvider));
    eq(ret, false, '9.1 provider 失败不可重试');
    ok(slangState().blockedUntil > Date.now(), '9.2 已进入退避');
    eq(slangState().rebuildAt.length, 0, '9.3 provider 失败不计重建次数');
    eq(fs.existsSync(SLANG_SESSION_FILE), hadSession, '9.4 provider 失败不销毁会话文件（重建无用）');

    // ── 10. 退避闸门真拦得住 ──
    let gateMsg = '';
    try {
      await ensureSlangLearnerSession();
      gateMsg = '(没抛错)';
    } catch (e) {
      gateMsg = String(e?.message ?? e);
    }
    ok(gateMsg.includes('退避中'), '10.1 ensureSlangLearnerSession 在退避期内拒绝（' + gateMsg.slice(0, 60) + '）');
    ok(slangState().sessionId === null || slangState().sessionId === undefined, '10.2 闸门没有偷偷建会话');

    // ── 11. 真陈旧：重建 + 可重试 ──
    noteSlangLearnerHealthy();
    const r11 = handleSlangLearnerFailure('黑话研究', new Error('session.prompt failed: not_found: no such session'));
    eq(r11, true, '11.1 stale 失败可重试一次');
    eq(slangState().rebuildAt.length, 1, '11.2 记一次重建');
    eq(fs.existsSync(SLANG_SESSION_FILE), false, '11.3 陈旧会话文件已删');

    // ── 12. 超时：重建但不重试 ──
    const r12 = handleSlangLearnerFailure('黑话研究', new Error('等待学习会话 turn 超时(120000ms)'));
    eq(r12, false, '12.1 timeout 不重试');
    eq(slangState().rebuildAt.length, 2, '12.2 记第二次重建');

    // ── 13. 第三次、然后耗尽 ──
    handleSlangLearnerFailure('黑话研究', new Error('等待学习会话 turn 超时(120000ms)'));
    eq(slangState().rebuildAt.length, 3, '13.1 第三次重建');
    const before = slangState().rebuildAt.length;
    handleSlangLearnerFailure('黑话研究', new Error('等待学习会话 turn 超时(120000ms)'));
    eq(slangState().rebuildAt.length, before, '13.2 预算耗尽后不再记重建');
    ok(slangState().rebuildAt.length === 3, '13.3 重建次数停在 3');

    // ── 14. 一次成功就全清 ──
    noteSlangLearnerHealthy();
    eq(slangState().blockedUntil, 0, '14.1 恢复后退避清零');
    eq(slangState().rebuildAt.length, 0, '14.2 恢复后重建计数清零');
    eq(slangState().last, null, '14.3 恢复后失败记录清空');
  } catch (e) {
    fails.push('未捕获异常: ' + (e && e.stack ? e.stack : e));
  }

  console.log('\n' + '='.repeat(56));
  for (const n of notes) console.log('· ' + n);
  if (fails.length) {
    console.log(`❌ ${pass} 过，${fails.length} 失败：`);
    for (const f of fails) console.log('   - ' + f);
    process.exitCode = 1;
  } else {
    console.log(`✅ 全部 ${pass} 条断言通过`);
  }
}
