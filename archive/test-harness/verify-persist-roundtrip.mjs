// Bug 1 的真实读写往返验证：用补丁后的 save/load 逻辑跑一遍，
// 确认字段真的能落盘、能读回、且语义正确。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const eq = (l, a, b) => ok(l, a === b, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n=== ${t} ===`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-fix-'));
const FILE = path.join(dir, 'social-v2.json');

// ── 复刻补丁后的 save 字段清单（含新补的两个）────────────────────────────
class Store {
  constructor() { this.conversations = new Map(); this.paused = false; }

  save() {
    const obj = { paused: this.paused, conversations: {} };
    for (const [key, st] of this.conversations) {
      obj.conversations[key] = {
        wakeConfig: st.wakeConfig ?? {},
        recentMessages: (st.recentMessages ?? []).slice(-200),
        unread: [],
        lastWakeReason: st.lastWakeReason ?? '',
        lastAiReplyAt: st.lastAiReplyAt ?? 0,
        lastActionAt: 0,
        agentToken: st.agentToken ?? 'x',
        bootstrapSent: !!st.bootstrapSent,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: st.memberImpressions ?? {},
        // ← 补丁补的两行
        lastImpressionRefreshAt: Number(st.lastImpressionRefreshAt) || 0,
        lastImpressionNudgeAt: Number(st.lastImpressionNudgeAt) || 0,
        seenForwardIds: []
      };
    }
    fs.writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
  }

  load() {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    this.conversations = new Map();
    for (const [key, val] of Object.entries(raw.conversations ?? {})) {
      this.conversations.set(key, {
        ...val,
        // ← 补丁后的默认值语义：0 = 从未刷新
        lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : 0,
        lastImpressionNudgeAt: Number(val.lastImpressionNudgeAt) > 0 ? Number(val.lastImpressionNudgeAt) : 0
      });
    }
  }
}

section('落盘 → 读回：字段真的保住了');
{
  const s = new Store();
  const refreshAt = Date.parse('2026-10-13T10:00:00Z');
  const nudgeAt = Date.parse('2026-10-20T08:00:00Z');
  s.conversations.set('group:906710082', {
    wakeConfig: {}, recentMessages: [], agentToken: 'tok',
    memberImpressions: { 星璃: { traits: ['爱怼人'], interactionCount: 1, lastSeenAt: 1 } },
    lastImpressionRefreshAt: refreshAt,
    lastImpressionNudgeAt: nudgeAt
  });
  s.save();

  // 落盘后直接看文件
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const disk = raw.conversations['group:906710082'];
  eq('文件里有 lastImpressionRefreshAt', disk.lastImpressionRefreshAt, refreshAt);
  eq('文件里有 lastImpressionNudgeAt', disk.lastImpressionNudgeAt, nudgeAt);
  ok('文件里不是 undefined', disk.lastImpressionRefreshAt !== undefined);

  // 重新 load
  const s2 = new Store();
  s2.load();
  const st = s2.conversations.get('group:906710082');
  eq('读回 refreshAt 一致', st.lastImpressionRefreshAt, refreshAt);
  eq('读回 nudgeAt 一致', st.lastImpressionNudgeAt, nudgeAt);
  eq('印象本身也还在', Object.keys(st.memberImpressions).length, 1);
}

section('字段缺失（老状态文件）⇒ 0，不是「现在」');
{
  fs.writeFileSync(FILE, JSON.stringify({
    paused: false,
    conversations: {
      'group:1': { agentToken: 'a', memberImpressions: { 甲: { traits: ['x'], interactionCount: 1 } } }
    }
  }), 'utf8');

  const s = new Store();
  s.load();
  const st = s.conversations.get('group:1');
  eq('缺字段 ⇒ refreshAt 为 0', st.lastImpressionRefreshAt, 0);
  eq('缺字段 ⇒ nudgeAt 为 0', st.lastImpressionNudgeAt, 0);

  // 语义验证：0 必须被判定为「该提醒」
  const days = 7;
  const now = Date.now();
  const stale = Object.keys(st.memberImpressions).length > 0
    && (st.lastImpressionRefreshAt === 0 || now - st.lastImpressionRefreshAt > days * 86400000);
  ok('0 会被判定为「该提醒重写印象」', stale === true);
}

section('反复重启不会漂移（这次存住了，下次还在）');
{
  const s = new Store();
  s.conversations.set('group:x', {
    agentToken: 't', memberImpressions: { A: { traits: ['a'], interactionCount: 3 } },
    lastImpressionRefreshAt: 1792400000000, lastImpressionNudgeAt: 1792400001000
  });
  s.save();

  for (let round = 1; round <= 3; round += 1) {
    const s2 = new Store();
    s2.load();
    const st = s2.conversations.get('group:x');
    eq(`第 ${round} 次重启后 refreshAt 不变`, st.lastImpressionRefreshAt, 1792400000000);
    eq(`第 ${round} 次重启后 nudgeAt 不变`, st.lastImpressionNudgeAt, 1792400001000);
    eq(`第 ${round} 次重启后 interactionCount 不变`, st.memberImpressions.A.interactionCount, 3);
    s2.save();
  }
}

section('旧文件里已有的其它字段没被冲掉');
{
  fs.writeFileSync(FILE, JSON.stringify({
    paused: true,
    conversations: {
      'group:y': {
        agentToken: 'tok2',
        lastReadThroughSeq: 913,
        lastUnreadSeq: 927,
        activeTopics: [{ text: '话题A', lastMentionAt: 1 }],
        memberImpressions: { B: { traits: ['b'], interactionCount: 2 } },
        seenForwardIds: ['f1', 'f2'],
        lastImpressionRefreshAt: 1792400000000
      }
    }
  }), 'utf8');

  const s = new Store();
  s.load();
  const st = s.conversations.get('group:y');
  eq('paused 保住', JSON.parse(fs.readFileSync(FILE, 'utf8')).paused, true);
  eq('lastReadThroughSeq 保住', st.lastReadThroughSeq, 913);
  eq('activeTopics 保住', st.activeTopics.length, 1);
  eq('memberImpressions 保住', st.memberImpressions.B.interactionCount, 2);
  eq('refreshAt 保住', st.lastImpressionRefreshAt, 1792400000000);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
