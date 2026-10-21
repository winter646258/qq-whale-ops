// item56 server-side probe: 隔离副本里直接跑真实模块，验证落盘/续档/隔离
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
const fails = [];
const notes = [];
const ok = (c, l) => { if (c) pass += 1; else fails.push(l); };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (${JSON.stringify(a)} !== ${JSON.stringify(b)})`);

export default async function run(api) {
  const { getSocialV2State, saveSocialV2State, loadSocialV2State, socialV2, scheduleProactiveCheckV2, STATE_DIR, SOCIAL_V2_FILE, cfg } = api;
  const MIN = 30 * 60 * 1000;

  try {
    // ── 0. 隔离 ──
    ok(STATE_DIR.includes('/tmp/item56-test'), '0.1 状态目录已隔离 ' + STATE_DIR);
    ok(!STATE_DIR.startsWith('/opt/qq-bridge'), '0.2 没有指向生产目录');

    // 副本里没有 state/mode.json，currentMode 默认是 chat；主动检查只在 reserved2 下工作
    notes.push('boot mode = ' + api.getMode());
    api.setMode('reserved2');
    ok(api.getMode() === 'reserved2', '0.4 测试切到 reserved2 模式');

    // 主动检查只对白名单对象生效，先从 config 里挑一个真能排档的会话
    // proactiveAllowed 读的是 cfg.allow.private / cfg.allow.groups（顶层，不在 socialV2 里）
    const allowJson = JSON.stringify({ private: cfg?.allow?.private, groups: cfg?.allow?.groups });
    notes.push('allow 摘要: ' + allowJson.slice(0, 300));
    const priv = (cfg?.allow?.private ?? []).map(String);
    const grps = (cfg?.allow?.groups ?? []).map(String);
    const cands = [
      ...priv.map((n) => 'private:' + n),
      ...grps.map((n) => 'group:' + n),
      'private:1124721191', 'group:910502749',
    ];
    let KEY = '';
    let st = null;
    for (const k of cands) {
      const s = getSocialV2State(k);
      if (s.proactiveNextAt > 0) { KEY = k; st = s; break; } // 已被内部排过档
      scheduleProactiveCheckV2(k);
      if (s.proactiveNextAt > 0) { KEY = k; st = s; break; }
    }
    ok(!!KEY, `0.3 找到可排档会话（候选 ${cands.length} 个，命中 ${KEY || '无'}）`);
    if (!KEY) throw new Error('proactiveAllowed 把全部候选都拒了，且 config 里没有白名单');

    // ── 1. 排档会落盘 ──
    ok(st.proactiveNextAt > Date.now(), '1.1 排档后 forward 时间戳');
    ok(st.proactiveTimer, '1.2 定时器已挂');
    saveSocialV2State();
    ok(fs.existsSync(SOCIAL_V2_FILE), '1.3 state 文件已生成');
    const disk1 = JSON.parse(fs.readFileSync(SOCIAL_V2_FILE, 'utf8'));
    const convs1 = disk1.conversations || disk1;
    ok(!!convs1[KEY], '1.4 盘上有该会话');
    ok(Number(convs1[KEY].proactiveNextAt) > 0, '1.5 proactiveNextAt 真写进盘了');
    eq(convs1[KEY].pendingWakeReasons, [], '1.6 pendingWakeReasons 也落盘（空数组）');

    // ── 2. 队列 + 档期 跨重启存活 ──
    st.pendingWakeReasons = [
      { reason: 'private', seq: 24, at: Date.now() - 60 * 1000, pr: 100 },
      { reason: 'atMention', seq: 25, at: Date.now() - 50 * 1000, pr: 90 },
    ];
    const future = Date.now() + 12 * 60 * 1000;
    st.proactiveNextAt = future;
    saveSocialV2State();

    const disk2 = JSON.parse(fs.readFileSync(SOCIAL_V2_FILE, 'utf8'));
    const c2 = (disk2.conversations || disk2)[KEY];
    eq(c2.pendingWakeReasons.length, 2, '2.1 两条暂存写入盘');
    eq(c2.pendingWakeReasons[0].reason, 'private', '2.2 reason 保留');
    eq(c2.pendingWakeReasons[1].seq, 25, '2.3 seq 保留');
    ok(c2.pendingWakeReasons[0].at > 0, '2.4 at 保留');
    eq(Number(c2.proactiveNextAt), future, '2.5 档期原样写入');

    // 模拟重启
    socialV2.conversations.clear();
    loadSocialV2State();
    const st2 = getSocialV2State(KEY);
    eq(st2.pendingWakeReasons.length, 2, '2.6 重启后队列恢复两条');
    eq(st2.pendingWakeReasons[0].reason, 'private', '2.7 恢复后顺序不乱');
    eq(st2.pendingWakeReasons[0].pr, 100, '2.8 恢复后优先级在场');
    const left = st2.proactiveNextAt - Date.now();
    ok(left > 10 * 60 * 1000 && left <= 13 * 60 * 1000, `2.9 档期按剩余时间续上（剩 ${Math.round(left / 60000)}min）`);
    ok(st2.proactiveTimer, '2.10 重启后定时器重新挂上');

    // ── 3. 脏数据容错 ──
    const DK = 'private:999991';
    const st3 = getSocialV2State(DK);
    st3.pendingWakeReasons = [{ reason: 'keyword', seq: '7' }, 'legacy', null, { nope: 1 }];
    st3.proactiveNextAt = 0;
    saveSocialV2State();
    socialV2.conversations.clear();
    loadSocialV2State();
    const st3b = getSocialV2State(DK);
    eq(st3b.pendingWakeReasons.length, 1, '3.1 脏数据只留合法一条');
    eq(st3b.pendingWakeReasons[0].seq, 7, '3.2 字符串 seq 归一');
    eq(st3b.pendingWakeReasons[0].pr, 0, '3.3 缺 pr 存 0（优先级在用时才查表，load 里查会 TDZ）');
    eq(api.pickPendingWakeIndex(st3b), 0, '3.5 只有一条时选队下标正确');
    ok(st3b.pendingWakeReasons[0].at === 0, '3.4 缺 at 补 0 而不是 NaN');

    // ── 4. 反复 load 幂等 ──
    loadSocialV2State();
    loadSocialV2State();
    const st4 = getSocialV2State(KEY);
    eq(st4.pendingWakeReasons.length, 2, '4.1 反复 load 不叠加队列');
    ok(!Number.isNaN(st4.proactiveNextAt), '4.2 档期不是 NaN');

    // ── 5. 落盘截断到 20 ──
    const st5 = getSocialV2State(KEY);
    st5.pendingWakeReasons = Array.from({ length: 40 }, (_, i) => ({ reason: 'keyword', seq: i + 1, at: Date.now(), pr: 60 }));
    saveSocialV2State();
    socialV2.conversations.clear();
    loadSocialV2State();
    eq(getSocialV2State(KEY).pendingWakeReasons.length, 20, '5.1 落盘截断到 20 条');
    eq(getSocialV2State(KEY).pendingWakeReasons[0].seq, 21, '5.2 保留最近 20 条');

    // ── 6. 主动检查关闭时不排 ──
    const OFF = 'private:888881';
    const st6 = getSocialV2State(OFF);
    cfg.socialV2 = cfg.socialV2 || {};
    cfg.socialV2.proactive = Object.assign({}, cfg.socialV2.proactive, { enabled: false });
    scheduleProactiveCheckV2(OFF);
    eq(st6.proactiveNextAt, 0, '6.1 enabled=false 时不排档');
  } finally {
    console.log('\n--- notes ---');
    notes.forEach((n) => console.log('  ' + n));
    console.log(`服务端通过 ${pass} 条，失败 ${fails.length} 条`);
    if (fails.length) {
      console.log('失败项：');
      fails.forEach((f) => console.log('  ✖', f));
    }
    try {
      fs.rmSync(path.join(STATE_DIR, 'social-v2.json'), { force: true });
      fs.rmSync(path.join(STATE_DIR, 'bridge.lock'), { force: true });
    } catch (e) {}
  }
  if (fails.length) throw new Error('服务端断言失败');
  console.log('全部通过（测试状态已清理）');
}
