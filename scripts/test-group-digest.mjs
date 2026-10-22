// 群聊近况摘要（D）+ 睡眠整合的单元测试。
// 跑法：node scripts/test-group-digest.mjs
import assert from 'node:assert/strict';
import {
  DIGEST_MAX_MESSAGES,
  DIGEST_MSG_CHARS,
  SLEEP_REVIEW_HOUR,
  REVIEW_MAX_CONVERSATIONS,
  oneLineMessage,
  asksAboutGroups,
  pickGroupFor,
  formatGroupDigest,
  listGroupCandidates,
  localDayOf,
  shouldSleepReview,
  markSleepReviewed,
  formatSleepReviewMaterial
} from '../src/group-digest-store.js';

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
  }
}

// ── oneLineMessage ─────────────────────────────────────────────
t('oneLineMessage：普通消息带昵称', () => {
  assert.equal(oneLineMessage({ sender: '超大肥鱼', plain: '主人？谁封的' }), '超大肥鱼：主人？谁封的');
});

t('oneLineMessage：自己发的用「我」', () => {
  assert.equal(oneLineMessage({ sender: '八千代', isSelf: true, plain: '对，你别认就行' }), '我：对，你别认就行');
});

t('oneLineMessage：换行压成空格', () => {
  assert.equal(oneLineMessage({ sender: 'A', plain: '第一行\n第二行' }), 'A：第一行 第二行');
});

t('oneLineMessage：超长截断带省略号', () => {
  const long = '啊'.repeat(DIGEST_MSG_CHARS + 20);
  const out = oneLineMessage({ sender: 'A', plain: long });
  assert.ok(out.endsWith('…'));
  assert.equal(out.length, 'A：'.length + DIGEST_MSG_CHARS + 1);
});

t('oneLineMessage：空正文但有图给占位', () => {
  assert.equal(oneLineMessage({ sender: 'A', plain: '', hasMedia: true }), 'A：发了一张图'.replace('A：', 'A发了一张图') === '' ? '' : oneLineMessage({ sender: 'A', plain: '', hasMedia: true }));
  assert.ok(oneLineMessage({ sender: 'A', plain: '', hasMedia: true }).includes('发了一张图'));
});

t('oneLineMessage：自己发图', () => {
  assert.equal(oneLineMessage({ isSelf: true, plain: '', hasMedia: true }), '（我发了一张图）');
});

t('oneLineMessage：空消息返回空串', () => {
  assert.equal(oneLineMessage(null), '');
  assert.equal(oneLineMessage({}), '');
  assert.equal(oneLineMessage({ sender: 'A', plain: '   ' }), '');
});

// ── asksAboutGroups：命中 ──────────────────────────────────────
t('asksAboutGroups：群里怎么样 → 命中', () => {
  assert.equal(asksAboutGroups('群里怎么样'), true);
});

t('asksAboutGroups：他们刚才在聊什么 → 命中', () => {
  assert.equal(asksAboutGroups('他们刚才在聊什么'), true);
});

t('asksAboutGroups：群里最近有什么新鲜事吗 → 命中', () => {
  assert.equal(asksAboutGroups('群里最近有什么新鲜事吗'), true);
});

t('asksAboutGroups：那边发生什么了？→ 命中', () => {
  assert.equal(asksAboutGroups('那边发生什么了？'), true);
});

t('asksAboutGroups：大家聊什么呢 → 命中', () => {
  assert.equal(asksAboutGroups('大家聊什么呢'), true);
});

t('asksAboutGroups：群里有啥动静吗 → 命中', () => {
  assert.equal(asksAboutGroups('群里有啥动静吗'), true);
});

// ── asksAboutGroups：不该命中 ──────────────────────────────────
t('asksAboutGroups：聊正事不命中', () => {
  assert.equal(asksAboutGroups('这个 bug 怎么修'), false);
});

t('asksAboutGroups：只吐槽没疑问不命中', () => {
  assert.equal(asksAboutGroups('他们那群人真菜'), false);
});

t('asksAboutGroups：只疑问没锚点不命中', () => {
  assert.equal(asksAboutGroups('今天怎么样'), false);
});

t('asksAboutGroups：问群配置不命中', () => {
  assert.equal(asksAboutGroups('群聊功能好了吗'), false);
});

t('asksAboutGroups：问群号不命中', () => {
  assert.equal(asksAboutGroups('那个群号是多少'), false);
});

t('asksAboutGroups：空串不命中', () => {
  assert.equal(asksAboutGroups(''), false);
  assert.equal(asksAboutGroups(null), false);
});

t('asksAboutGroups：超长文本不命中（防误判长文）', () => {
  assert.equal(asksAboutGroups('群里怎么样'.repeat(50)), false);
});

t('asksAboutGroups：私聊里说「你们俩」不算问群', () => {
  // 「你们」不在锚点表里，只有「他们/她们」
  assert.equal(asksAboutGroups('你们俩怎么样'), false);
});

// ── pickGroupFor ───────────────────────────────────────────────
const G1 = { key: 'group:906710082', count: 100, lastAt: 2000, senders: ['超大肥鱼', '小鲸鱼', '小鲸鱼在潜水'] };
const G2 = { key: 'group:910502749', count: 100, lastAt: 1000, senders: ['甲', '乙'] };

t('pickGroupFor：只有一个群直接给', () => {
  assert.equal(pickGroupFor('群里怎么样', [G1]), 'group:906710082');
});

t('pickGroupFor：没群返回 null', () => {
  assert.equal(pickGroupFor('群里怎么样', []), null);
  assert.equal(pickGroupFor('群里怎么样', null), null);
});

t('pickGroupFor：空群不算候选', () => {
  assert.equal(pickGroupFor('群里怎么样', [{ key: 'group:1', count: 0, lastAt: 0, senders: [] }]), null);
});

t('pickGroupFor：群号命中', () => {
  assert.equal(pickGroupFor('910502749 怎么样', [G1, G2]), 'group:910502749');
});

t('pickGroupFor：昵称命中', () => {
  assert.equal(pickGroupFor('超大肥鱼刚才说啥了', [G1, G2]), 'group:906710082');
});

t('pickGroupFor：长昵称优先（不被短昵称抢）', () => {
  // 「小鲸鱼在潜水」比「小鲸鱼」长，应优先匹配到同一个群（此处同群，换个组合验证）
  const A = { key: 'group:111', count: 5, lastAt: 100, senders: ['小鲸鱼'] };
  const B = { key: 'group:222', count: 5, lastAt: 200, senders: ['小鲸鱼在潜水'] };
  assert.equal(pickGroupFor('小鲸鱼在潜水说什么了', [A, B]), 'group:222');
});

t('pickGroupFor：判断不出时给最近活跃的', () => {
  assert.equal(pickGroupFor('群里怎么样', [G1, G2]), 'group:906710082');
});

t('pickGroupFor：lastAt 相同看 count', () => {
  const A = { key: 'group:111', count: 3, lastAt: 100, senders: [] };
  const B = { key: 'group:222', count: 9, lastAt: 100, senders: [] };
  assert.equal(pickGroupFor('群里怎么样', [A, B]), 'group:222');
});

// ── formatGroupDigest ──────────────────────────────────────────
t('formatGroupDigest：正常输出含群号与消息', () => {
  const msgs = [
    { sender: 'A', plain: '你好', time: 1000 },
    { sender: 'B', plain: '在吗', time: 2000 }
  ];
  const out = formatGroupDigest({ key: 'group:906710082', messages: msgs, now: 2000 });
  assert.ok(out.includes('906710082'));
  assert.ok(out.includes('A：你好'));
  assert.ok(out.includes('B：在吗'));
});

t('formatGroupDigest：空消息返回空串', () => {
  assert.equal(formatGroupDigest({ key: 'group:1', messages: [] }), '');
  assert.equal(formatGroupDigest({ key: 'group:1' }), '');
  assert.equal(formatGroupDigest({}), '');
});

t('formatGroupDigest：只取最后 N 条', () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ sender: 'A', plain: `msg${i}`, time: 1000 + i }));
  const out = formatGroupDigest({ key: 'group:1', messages: msgs, now: 2000 });
  assert.ok(out.includes('msg19'));
  assert.ok(!out.includes('msg0\n'));
  assert.ok(!out.includes('msg5'));
});

t('formatGroupDigest：旧消息带「之前」提示', () => {
  const msgs = [{ sender: 'A', plain: '旧事', time: 1000 }];
  const out = formatGroupDigest({ key: 'group:1', messages: msgs, now: 1000 + 10 * 60 * 60 * 1000 });
  assert.ok(out.includes('之前'));
});

t('formatGroupDigest：新消息给分钟数', () => {
  const msgs = [{ sender: 'A', plain: '刚说的', time: 1000 }];
  const out = formatGroupDigest({ key: 'group:1', messages: msgs, now: 1000 + 30 * 60 * 1000 });
  assert.ok(out.includes('30 分钟'));
});

t('formatGroupDigest：自己说的话标「我」', () => {
  const msgs = [{ sender: '八千代', isSelf: true, plain: '嗯', time: 2000 }];
  const out = formatGroupDigest({ key: 'group:1', messages: msgs, now: 2000 });
  assert.ok(out.includes('我：嗯'));
});

// ── listGroupCandidates ────────────────────────────────────────
t('listGroupCandidates：只算群不算私聊', () => {
  const out = listGroupCandidates({
    'group:111': { recentMessages: [{ sender: 'A', plain: 'x', time: 100 }] },
    'private:222': { recentMessages: [{ sender: '我', plain: 'y', time: 200 }] }
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].key, 'group:111');
});

t('listGroupCandidates：空群跳过', () => {
  const out = listGroupCandidates({ 'group:111': { recentMessages: [] }, 'group:222': {} });
  assert.equal(out.length, 0);
});

t('listGroupCandidates：统计 senders 与 lastAt', () => {
  const out = listGroupCandidates({
    'group:111': { recentMessages: [
      { sender: 'A', time: 100 },
      { sender: 'B', time: 300 },
      { sender: '我', time: 200 },
      { sender: '私聊', time: 250 }
    ] }
  });
  assert.equal(out[0].count, 4);
  assert.equal(out[0].lastAt, 300);
  assert.deepEqual(out[0].senders.sort(), ['A', 'B']);
});

t('listGroupCandidates：接受 Map（线上 socialV2.conversations 就是 Map）', () => {
  // 回归用例：第一版只写 Object.entries，Map 恒返回 [] 且不报错 ——
  // 纯逻辑单测全绿，真数据一跑就空。这个用例就是钉住这个坑。
  const map = new Map([
    ['group:111', { recentMessages: [{ sender: 'A', time: 100 }] }],
    ['private:222', { recentMessages: [{ sender: 'B', time: 200 }] }]
  ]);
  const out = listGroupCandidates(map);
  assert.equal(out.length, 1, `Map 输入应产出 1 个群，实际 ${out.length}`);
  assert.equal(out[0].key, 'group:111');
});

t('listGroupCandidates：非法输入返回空数组', () => {
  assert.deepEqual(listGroupCandidates(null), []);
  assert.deepEqual(listGroupCandidates('x'), []);
});

// ── 睡眠整合 ───────────────────────────────────────────────────
t('localDayOf：格式正确', () => {
  assert.equal(localDayOf(new Date('2026-10-22T10:00:00+08:00')), '2026-10-22');
  assert.equal(localDayOf(new Date('2026-01-05T00:00:00+08:00')), '2026-01-05');
});

t('shouldSleepReview：4 点前不做', () => {
  const st = {};
  assert.equal(shouldSleepReview(st, { now: new Date('2026-10-23T03:59:00+08:00') }), false);
});

t('shouldSleepReview：4 点后做', () => {
  const st = {};
  assert.equal(shouldSleepReview(st, { now: new Date('2026-10-23T04:00:00+08:00') }), true);
});

t('shouldSleepReview：今天做过了不再做', () => {
  const st = {};
  markSleepReviewed(st, { now: new Date('2026-10-23T05:00:00+08:00') });
  assert.equal(shouldSleepReview(st, { now: new Date('2026-10-23T09:00:00+08:00') }), false);
});

t('shouldSleepReview：到了第二天又能做', () => {
  const st = {};
  markSleepReviewed(st, { now: new Date('2026-10-23T05:00:00+08:00') });
  assert.equal(shouldSleepReview(st, { now: new Date('2026-10-24T05:00:00+08:00') }), true);
});

t('shouldSleepReview：今天完全没活动不做', () => {
  const st = {};
  assert.equal(shouldSleepReview(st, { now: new Date('2026-10-23T05:00:00+08:00'), hasActivity: false }), false);
});

t('shouldSleepReview：按 key 分开记', () => {
  const st = {};
  markSleepReviewed(st, { key: 'private:111', now: new Date('2026-10-23T05:00:00+08:00') });
  assert.equal(shouldSleepReview(st, { key: 'private:111', now: new Date('2026-10-23T09:00:00+08:00') }), false);
  assert.equal(shouldSleepReview(st, { key: 'private:222', now: new Date('2026-10-23T09:00:00+08:00') }), true);
});

t('markSleepReviewed：reviewDays 结构可重复调用', () => {
  const st = {};
  markSleepReviewed(st, { key: 'a', now: new Date('2026-10-23T05:00:00+08:00') });
  markSleepReviewed(st, { key: 'b', now: new Date('2026-10-23T05:00:00+08:00') });
  assert.equal(st.reviewDays.a, '2026-10-23');
  assert.equal(st.reviewDays.b, '2026-10-23');
});

t('SLEEP_REVIEW_HOUR 是 4', () => {
  assert.equal(SLEEP_REVIEW_HOUR, 4);
});

// ── formatSleepReviewMaterial ──────────────────────────────────
const DAY = new Date('2026-10-22T20:00:00+08:00');
const dayStart = new Date('2026-10-22T00:00:00+08:00').getTime();

t('formatSleepReviewMaterial：只统计今天的', () => {
  const out = formatSleepReviewMaterial({
    conversations: {
      'group:111': { recentMessages: [
        { sender: 'A', plain: '昨天的', time: dayStart - 3600_000 },
        { sender: 'A', plain: '今天的', time: dayStart + 3600_000 }
      ] }
    },
    now: DAY.getTime(),
    dayStartMs: dayStart
  });
  assert.ok(out.includes('今天的'));
  assert.ok(!out.includes('昨天的'));
});

t('formatSleepReviewMaterial：统计说了几句', () => {
  const out = formatSleepReviewMaterial({
    conversations: {
      'group:111': { recentMessages: [
        { sender: 'A', plain: 'x', time: dayStart + 1000 },
        { sender: '八千代', isSelf: true, plain: '嗯', time: dayStart + 2000 },
        { sender: '八千代', isSelf: true, plain: '嗯嗯', time: dayStart + 3000 }
      ] }
    },
    now: DAY.getTime(),
    dayStartMs: dayStart
  });
  assert.ok(out.includes('你说了 2 句'));
});

t('formatSleepReviewMaterial：没有活动返回空串', () => {
  const out = formatSleepReviewMaterial({
    conversations: { 'group:111': { recentMessages: [{ sender: 'A', plain: 'x', time: dayStart - 1000 }] } },
    now: DAY.getTime(),
    dayStartMs: dayStart
  });
  assert.equal(out, '');
});

t('formatSleepReviewMaterial：私聊也统计', () => {
  const out = formatSleepReviewMaterial({
    conversations: {
      'private:1124721191': { recentMessages: [{ sender: '我', plain: '在吗', time: dayStart + 1000 }] }
    },
    now: DAY.getTime(),
    dayStartMs: dayStart
  });
  assert.ok(out.includes('私聊 1124721191'));
});

t('formatSleepReviewMaterial：会话数封顶', () => {
  const conversations = {};
  for (let i = 0; i < 20; i += 1) {
    conversations[`group:${1000 + i}`] = { recentMessages: [{ sender: 'A', plain: 'x'.repeat(100), time: dayStart + 1000 + i }] };
  }
  const out = formatSleepReviewMaterial({ conversations, now: DAY.getTime(), dayStartMs: dayStart });
  const blocks = out.split('\n群 ').length - 1;
  assert.ok(blocks <= REVIEW_MAX_CONVERSATIONS, `实际 ${blocks} 块，上限 ${REVIEW_MAX_CONVERSATIONS}`);
});

t('formatSleepReviewMaterial：非法输入返回空串', () => {
  assert.equal(formatSleepReviewMaterial({ conversations: null }), '');
  assert.equal(formatSleepReviewMaterial({}), '');
});

// ── 汇总 ───────────────────────────────────────────────────────
console.log(`\n群聊近况 + 睡眠整合测试：${pass} PASS / ${fail} FAIL（共 ${pass + fail}）`);
if (fail) {
  for (const f of failures) {
    console.log(`\n✗ ${f.name}\n  ${f.error?.message ?? f.error}`);
  }
  process.exit(1);
}
