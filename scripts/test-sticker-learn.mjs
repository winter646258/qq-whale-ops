// 表情包自动学习的纯逻辑单测。跑法：node scripts/test-sticker-learn.mjs
import {
  LEARN_DEFAULTS, hashOfMedia, buildRecentIndex, learnQuota,
  pickLearnCandidates, buildLearnRemark, recordLearnAttempt
} from '../src/sticker-learn.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`); }
}

const H1 = '0ABD8184126F'.padEnd(32, 'A');
const H2 = 'D0D9D02C2316'.padEnd(32, 'B');
const H3 = 'DAC41DA9030E'.padEnd(32, 'C');

console.log('【hashOfMedia】');
ok('从 file 取 32 位前缀', hashOfMedia({ kind: 'image', file: '63886A6507E0B88591CFCD9F775C5752.jpg' }) === '63886A6507E0B88591CFCD9F775C5752');
ok('转大写', hashOfMedia({ kind: 'image', file: 'abcDEF0123456789abcDEF0123456789.jpg' }) === 'ABCDEF0123456789ABCDEF0123456789');
ok('非图片返回空', hashOfMedia({ kind: 'video', file: '63886A6507E0B88591CFCD9F775C5752.jpg' }) === '');
ok('file 不是哈希时回落 md5 字段', hashOfMedia({ kind: 'image', file: 'x.jpg', md5: 'D41D8CD98F00B204E9800998ECF8427E' }) === 'D41D8CD98F00B204E9800998ECF8427E');
ok('全无返回空', hashOfMedia({ kind: 'image' }) === '');

console.log('【buildRecentIndex】');
const convs = {
  'group:1': {
    recentMessages: [
      { plain: '好紧张', messageId: '1001', media: [] },
      { plain: '[图片]', messageId: '1002', media: [{ kind: 'image', file: `${H1}.jpg`, url: 'u1' }] },
      { plain: '哈哈哈哈', messageId: '1003', media: [] },
      { plain: '[图片]', messageId: '1004', media: [{ kind: 'image', file: `${H2}.png` }] }
    ]
  },
  'private:2': {
    recentMessages: [
      { plain: '看这个', messageId: '2001', media: [] },
      { plain: '[图片]', messageId: '2002', media: [{ kind: 'image', file: `${H2}.png` }] },
      { plain: '[图片]', messageId: '2003', media: [{ kind: 'image', file: `${H3}.jpg` }] }
    ]
  }
};
const idx = buildRecentIndex(convs);
ok('索引到三张图', idx.size === 3, `实际 ${idx.size}`);
ok('纯图消息用上一条文字当语境', idx.get(H1)?.text === '好紧张', `实际 ${idx.get(H1)?.text}`);
ok('后出现的会话覆盖先前的', idx.get(H2)?.key === 'private:2', `实际 ${idx.get(H2)?.key}`);
ok('索引里带 messageId', Boolean(idx.get(H1)?.messageId), `实际 ${JSON.stringify(idx.get(H1))}`);

console.log('【buildRecentIndex 多图/自己发的】');
const convs2 = {
  'group:9': {
    recentMessages: [
      { plain: '两张一起发', messageId: '111', media: [{ kind: 'image', file: `${H1}.jpg` }, { kind: 'image', file: `${H2}.jpg` }] },
      { plain: '单张', messageId: '222', media: [{ kind: 'image', file: `${H3}.jpg` }] },
      { plain: '[图片]', messageId: '333', isSelf: true, media: [{ kind: 'image', file: `${H3}.png` }] }
    ]
  }
};
const idx2 = buildRecentIndex(convs2);
ok('多图消息整条跳过', !idx2.has(H1) && !idx2.has(H2), `实际 size=${idx2.size}`);
ok('自己发的也进索引（由候选层过掉）', idx2.get(H3)?.isSelf === true);

console.log('【learnQuota】');
const now = Date.parse('2026-10-30T10:00:00+08:00');
const todayKey = '2026-10-30';
ok('新记录可学', learnQuota({}, {}, now).can === true);
ok('今天学满 5 张就停', learnQuota({ days: { [todayKey]: 5 } }, {}, now).can === false);
ok('冷却期内不能学', learnQuota({ lastAt: now - 60_000 }, {}, now).can === false);
ok('冷却过了可学', learnQuota({ lastAt: now - 4_000_000 }, {}, now).can === true);
ok('enabled:false 一律不可', learnQuota({}, { enabled: false }, now).can === false);

console.log('【pickLearnCandidates】');
const sightings = [
  { hash: H1, count: 18 },
  { hash: H2, count: 10 },
  { hash: H3, count: 6 },
  { hash: 'ZZZZ', count: 99 }
];
ok('三个都够次数且在缓存里', pickLearnCandidates({ sightings, library: [], recentIndex: idx, record: {}, now }).length === 3);
ok('按次数从高到低', pickLearnCandidates({ sightings, library: [], recentIndex: idx, record: {}, now })[0].hash === H1);
ok('已在库里的跳过', pickLearnCandidates({ sightings, library: [{ md5: H1 }], recentIndex: idx, record: {}, now }).length === 2);
ok('观测次数不够跳过', pickLearnCandidates({ sightings: [{ hash: H1, count: 2 }], library: [], recentIndex: idx, record: {}, now }).length === 0);
ok('缓存里滚掉的跳过', pickLearnCandidates({ sightings: [{ hash: H3, count: 9 }], library: [], recentIndex: new Map(), record: {}, now }).length === 0);
ok('冷却期整批为空', pickLearnCandidates({ sightings, library: [], recentIndex: idx, record: { lastAt: now - 1000 }, now }).length === 0);
ok('日配额用完为空', pickLearnCandidates({ sightings, library: [], recentIndex: idx, record: { days: { [todayKey]: 5 } }, now }).length === 0);
ok('刚失败的图不重试', pickLearnCandidates({ sightings: [{ hash: H1, count: 9 }], library: [], recentIndex: idx, record: { tried: { [H1]: { at: now - 3600_000, ok: false } } }, now }).length === 0);
ok('失败超过重试窗口可以再试', pickLearnCandidates({ sightings: [{ hash: H1, count: 9 }], library: [], recentIndex: idx, record: { tried: { [H1]: { at: now - 7 * 3600_000, ok: false } } }, now }).length === 1);
ok('自己发的图不学', pickLearnCandidates({
  sightings: [{ hash: H3, count: 9 }], library: [],
  recentIndex: new Map([[H3, { key: 'group:9', media: { kind: 'image', file: `${H3}.png` }, messageId: '333', isSelf: true }]]),
  record: {}, now
}).length === 0);
ok('没 messageId 的图不学', pickLearnCandidates({
  sightings: [{ hash: H3, count: 9 }], library: [],
  recentIndex: new Map([[H3, { key: 'group:9', media: { kind: 'image', file: `${H3}.png` }, messageId: '' }]]),
  record: {}, now
}).length === 0);

console.log('【buildLearnRemark】');
ok('带语境', buildLearnRemark({ count: 18, context: '26魍氨雄鹰の迷弟：好紧张' }) === '群里常见18次：好紧张'.slice(0, 20), `实际 ${buildLearnRemark({ count: 18, context: '26魍氨雄鹰の迷弟：好紧张' })}`);
ok('无语境只写次数', buildLearnRemark({ count: 3, context: '' }) === '群里常见3次');
ok('语境是占位符也只写次数', buildLearnRemark({ count: 6, context: '[图片]' }) === '群里常见6次', `实际 ${buildLearnRemark({ count: 6, context: '[图片]' })}`);
ok('语境是表情占位也丢掉', buildLearnRemark({ count: 4, context: '[动画表情]' }) === '群里常见4次');
ok('不超过 20 字', buildLearnRemark({ count: 12, context: '一二三四五六七八九十一二三四五六七八九十' }).length <= 20, `实际 ${buildLearnRemark({ count: 12, context: '一二三四五六七八九十一二三四五六七八九十' })}`);

console.log('【recordLearnAttempt】');
const r1 = recordLearnAttempt({}, H1, { ok: true, now });
ok('成功记日计数', r1.days[todayKey] === 1);
ok('成功更新 lastAt', r1.lastAt === now);
ok('成功也记 tried', r1.tried[H1]?.ok === true);
const r2 = recordLearnAttempt(r1, H2, { ok: false, error: '下载失败', now: now + 1000 });
ok('失败不增日计数', r2.days[todayKey] === 1);
ok('失败保留 lastAt', r2.lastAt === now);
ok('失败记 error', r2.tried[H2]?.error === '下载失败');
const big = {};
for (let i = 0; i < 260; i += 1) big[`H${i}`.padEnd(32, 'F')] = { at: now + i, ok: true };
ok('tried 只留 200 条', Object.keys(recordLearnAttempt({ tried: big }, H1, { ok: true, now }).tried).length === 200);

console.log(`\n结果：${pass} 过 / ${fail} 失败`);
if (fail) process.exit(1);
