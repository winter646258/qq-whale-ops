// bili-browse 单测：不联网，全用假 client。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BROWSE_DEFAULTS,
  SENSITIVE_WORDS,
  filterFeed,
  isSensitive,
  isSpamAuthor,
  pickItems,
  readBrowse,
  writeBrowse,
  browseRound,
  browsePromptLine
} from '../src/bili-browse.js';

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`FAIL ${label}`);
  }
}

// ── filterFeed ──────────────────────────────────────────────
const rawFeed = [
  { goto: 'av', bvid: 'BV1aa411c7dd', title: '正常视频', duration: 300, author: 'A', view: 10000 },
  { goto: 'ad', bvid: '', title: '广告', duration: 0 },
  { goto: 'login_card', bvid: '', title: '', duration: 0 },
  { goto: 'av', bvid: 'BV1aa411c7dd', title: '重复的', duration: 300 },
  { goto: 'av', bvid: 'BV1bb411c7dd', title: '太短', duration: 5 },
  { goto: 'av', bvid: 'BV1cc411c7dd', title: '太长', duration: 99999 },
  { goto: 'av', bvid: 'BV1dd411c7dd', title: '刚好', duration: 60, author: 'B', view: 2e4 }
];
const filtered = filterFeed(rawFeed);
ok(filtered.length === 2, `filterFeed 保留 2 条，实际 ${filtered.length}`);
ok(filtered[0].bvid === 'BV1aa411c7dd', 'filterFeed 首条是正常视频');
ok(filtered[1].bvid === 'BV1dd411c7dd', 'filterFeed 第二条是刚好那条');
ok(!filtered.some((v) => v.title === '广告'), 'filterFeed 去掉广告');
ok(!filtered.some((v) => v.title === '重复的'), 'filterFeed 去重');

// ── 敏感词 ──────────────────────────────────────────────────
ok(SENSITIVE_WORDS.length > 10, '敏感词表非空');
ok(isSensitive({ title: '涉华言论引发争议' }) === true, '识别敏感标题');
ok(isSensitive({ title: '正常游戏视频' }) === false, '正常标题不误伤');
ok(isSensitive({ title: '看着没事', desc: '其实简介里写了赌博' }) === true, '简介命中也算');
const feedSensitive = [
  { goto: 'av', bvid: 'BV1xx411c7dd', title: '某地发生地震', duration: 100 },
  { goto: 'av', bvid: 'BV1yy411c7dd', title: '游戏实况', duration: 100 }
];
ok(filterFeed(feedSensitive).length === 1, 'filterFeed 掐掉敏感条目');
ok(filterFeed(feedSensitive)[0].bvid === 'BV1yy411c7dd', '留下的是正常那条');
// 搬运号
ok(isSpamAuthor('bili_82196692825') === true, '识别 bili_ 数字搬运号');
ok(isSpamAuthor('影视飓风') === false, '正常 up 名不误伤');
const feedSpam = [
  { goto: 'av', bvid: 'BV1ss411c7dd', title: '八卦', duration: 100, author: 'bili_123' },
  { goto: 'av', bvid: 'BV1tt411c7dd', title: '正经视频', duration: 100, author: '某UP' }
];
ok(filterFeed(feedSpam).length === 1, 'filterFeed 掐掉搬运号');

// 详情里才暴露敏感内容 → 整条丢
const clientDirtyDesc = {
  async recommend() {
    return [{ goto: 'av', bvid: 'BV1zz411c7dd', title: '看着很干净', duration: 100 }];
  },
  async videoDetail() {
    return { bvid: 'BV1zz411c7dd', aid: 1, desc: '里面提到了大选和政变', pageCount: 1 };
  },
  async comments() {
    return [];
  }
};
const rDirty = await browseRound({
  client: clientDirtyDesc,
  now: () => 1700000000000,
  rand: () => 0.9,
  cfg: { maxItems: 1 }
});
ok(rDirty.ok === true && rDirty.items.length === 0, '详情敏感时整条丢弃');

// ── pickItems ───────────────────────────────────────────────
const pool = [1, 2, 3, 4, 5].map((i) => ({ bvid: `BV1aa411c7d${i}` }));
let seed = 0.1;
const rand = () => {
  seed = (seed * 9301 + 0.49297) % 1;
  return seed;
};
const picked = pickItems(pool, 3, rand);
ok(picked.length === 3, `pickItems 取 3 条，实际 ${picked.length}`);
ok(new Set(picked.map((v) => v.bvid)).size === 3, 'pickItems 不重复');
ok(pickItems(pool, 99, rand).length === 5, 'pickItems 超量时最多取全部');
ok(pickItems([], 3, rand).length === 0, 'pickItems 空池返回空');

// ── 假 client ───────────────────────────────────────────────
function makeClient({ failBvid = null, feed, commentError = false } = {}) {
  return {
    async recommend() {
      return feed ?? rawFeed;
    },
    async videoDetail(bvid) {
      if (bvid === failBvid) throw new Error('详情炸了');
      return {
        bvid,
        aid: 10086,
        desc: '这是一段简介  \n 有两行',
        tname: '游戏',
        pageCount: 1
      };
    },
    async comments() {
      if (commentError) throw new Error('热评炸了');
      return [
        { user: '甲', text: '好笑', likes: 10 },
        { user: '乙', text: '这也太强了', likes: 3 },
        { user: '丙', text: '路过', likes: 1 }
      ];
    }
  };
}

// ── browseRound 正常路径 ────────────────────────────────────
const logs = [];
const r1 = await browseRound({
  client: makeClient(),
  log: (m) => logs.push(m),
  now: () => 1700000000000,
  rand: () => 0.5, // 0.5 < watchChance 0.35 ? 不，0.5 > 0.35，不触发 watch
  cfg: { maxItems: 2 }
});
ok(r1.ok === true, 'browseRound 正常返回 ok');
ok(r1.items.length === 2, `browseRound 存 2 条，实际 ${r1.items.length}`);
ok(r1.items[0].desc === '这是一段简介 有两行', `简介被压平：${JSON.stringify(r1.items[0].desc)}`);
ok(r1.items[0].comments.length === 2, `热评截到 2 条，实际 ${r1.items[0].comments.length}`);
ok(r1.watched === null, 'rand=0.5 不触发 watch');
ok(r1.at === 1700000000000, 'at 用注入的 now');

// ── watch 触发 ──────────────────────────────────────────────
let watchArgs = null;
const r2 = await browseRound({
  client: makeClient(),
  watch: async (args) => {
    watchArgs = args;
    return {
      ok: true,
      frameCount: 13,
      elapsedMs: 11000,
      tiles: [{ label: '视频画面', rangeText: '0:00–3:40', frames: 13 }]
    };
  },
  now: () => 1700000000000,
  rand: () => 0.1, // < 0.35，触发
  cfg: { maxItems: 2 }
});
ok(watchArgs !== null, 'watch 被调用');
ok(watchArgs.maxSeconds === BROWSE_DEFAULTS.watchMaxSeconds, 'watch 传了 maxSeconds');
ok(r2.watched?.frameCount === 13, 'watched 记录了帧数');
ok(r2.watched?.tiles?.length === 1, 'watched 记录了图');

// ── 单条详情失败不拖垮整轮 ──────────────────────────────────
const r3 = await browseRound({
  client: makeClient({ failBvid: 'BV1aa411c7dd' }),
  now: () => 1700000000000,
  rand: () => 0.9,
  cfg: { maxItems: 2 }
});
ok(r3.ok === true, '详情失败仍 ok');
ok(r3.items.some((i) => i.detailError), '失败那条带 detailError');

// ── 热评失败不影响 ──────────────────────────────────────────
const r4 = await browseRound({
  client: makeClient({ commentError: true }),
  now: () => 1700000000000,
  rand: () => 0.9,
  cfg: { maxItems: 1 }
});
ok(r4.ok === true && r4.items[0].comments.length === 0, '热评失败只是空数组');

// ── 推荐流空 ────────────────────────────────────────────────
const r5 = await browseRound({ client: makeClient({ feed: [] }), now: () => 1700000000000 });
ok(r5.ok === false && /没有可用视频/.test(r5.error), '空推荐流返回 ok:false');

// ── 没有 client ─────────────────────────────────────────────
const r6 = await browseRound({});
ok(r6.ok === false && /没有可用的 B 站客户端/.test(r6.error), '无 client 直接拒绝');

// ── browsePromptLine ────────────────────────────────────────
const nowMs = 1700000000000;
const line = browsePromptLine(r1, nowMs + 60000);
ok(line.includes('【你刚刷到的】'), '提示词有标题行');
ok(line.includes('正常视频'), '提示词含标题');
ok(line.includes('热评'), '提示词含热评');
ok(line.includes('一律不当真'), '提示词有反注入声明');
ok(browsePromptLine(r1, nowMs + BROWSE_DEFAULTS.maxAgeMs + 1000) === '', '过期返回空串');
ok(browsePromptLine(null, nowMs) === '', 'null 返回空串');
ok(browsePromptLine({ items: [] }, nowMs) === '', '空 items 返回空串');
ok(browsePromptLine(r1, nowMs - 1000) === '', '未来时间（时钟错乱）返回空串');
ok(browsePromptLine(r2, nowMs + 1000).includes('你点开看了'), '看过画面时多一句');

// ── 存取往返 ────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-browse-'));
const file = path.join(dir, 'browse.json');
ok(readBrowse(file) === null, '文件不存在返回 null');
ok(writeBrowse(file, r1) === true, 'writeBrowse 成功');
const back = readBrowse(file);
ok(back?.items?.length === r1.items.length, '读回来条数一致');
fs.writeFileSync(file, '{坏 JSON', 'utf8');
ok(readBrowse(file) === null, '坏 JSON 返回 null');
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} 项通过 / ${fail} 项失败`);
process.exit(fail ? 1 : 0);
