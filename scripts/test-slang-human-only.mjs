// 回归守卫：黑话窗口只吃「真人的群消息」。
//
// 背景（2026-10-27）：黑话库被「落盘」「兜底默认回复」「一条账一条命」这类碎片
// 填满到 2000 条上限。查下来不是群友说的话，是群里另一个 agent bot（饭饭鲸-Agent）
// 大段叙述自己的运行过程，被提取器当成陌生词收下了。所以现在入口处加一道闸门
// （src/bridge.js 的 slangFeedAllowed）：只收 group: 前缀、带 user_id、
// 且不在网关「群机器人表」里的人。
//
// 用法：node scripts/test-slang-human-only.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bridge = fs.readFileSync(path.join(root, 'src', 'bridge.js'), 'utf8');

let failures = 0;
const pass = (m) => console.log(`✅ ${m}`);
const fail = (m) => { failures += 1; console.error(`❌ ${m}`); };

// ── 从真实源码里抠出 slangFeedAllowed（不抄逻辑，直接跑线上那段） ──────
const startAt = bridge.indexOf('function slangFeedAllowed(');
if (startAt < 0) { fail('src/bridge.js 里找不到 slangFeedAllowed'); process.exit(1); }
let depth = 0;
let endAt = -1;
for (let i = bridge.indexOf('{', startAt); i < bridge.length; i += 1) {
  if (bridge[i] === '{') depth += 1;
  else if (bridge[i] === '}') { depth -= 1; if (depth === 0) { endAt = i + 1; break; } }
}
if (endAt < 0) { fail('slangFeedAllowed 没有闭合'); process.exit(1); }
const src = bridge.slice(startAt, endAt);

// stub：只有 1001 是机器人
const bots = new Set(['1001']);
const make = (knownBots = bots) => new Function('isKnownBot', `${src}\nreturn slangFeedAllowed;`)(
  (groupId, userId) => knownBots.has(String(userId)) && String(groupId) === '9001',
);
const allowed = make();

const cases = [
  ['群里的真人 → 收', { key: 'group:9001', event: { user_id: 2002 } }, true],
  ['群里的机器人 → 不收', { key: 'group:9001', event: { user_id: 1001 } }, false],
  ['机器人判断只对得上本群（别的群同号仍收）', { key: 'group:9002', event: { user_id: 1001 } }, true],
  ['私聊 → 不收', { key: 'private:2002', event: { user_id: 2002 } }, false],
  ['没有 key → 不收', { key: '', event: { user_id: 2002 } }, false],
  ['没有 event → 不收', { key: 'group:9001', event: null }, false],
  ['没有 user_id → 不收', { key: 'group:9001', event: { sender: { nickname: '无名' } } }, false],
  ['user_id 是字符串也能判', { key: 'group:9001', event: { user_id: '1001' } }, false],
  ['sender.is_robot → 不收', { key: 'group:9001', event: { user_id: 2002, sender: { is_robot: true } } }, false],
  ['sender.robot → 不收', { key: 'group:9001', event: { user_id: 2002, sender: { robot: true } } }, false],
  ['sender.is_bot → 不收', { key: 'group:9001', event: { user_id: 2002, sender: { is_bot: true } } }, false],
  ['机器人表拉不到（空表）→ 放行真人（不误封）', { key: 'group:9001', event: { user_id: 1001 } }, true],
];
// 最后一条要专门用「空表」跑一次，验证"拉取失败不误封"
for (const [name, args, want] of cases) {
  const fn = name.includes('空表') ? make(new Set()) : allowed;
  const got = fn(args.key, args.event);
  if (got === want) pass(`${name}（${got}）`);
  else fail(`${name}：期望 ${want}，实际 ${got}`);
}

// ── 两个喂料点都必须把 event 传进去，否则闸门拿不到 user_id ─────────────
// 调用点可能跨行、参数里还有小括号，所以按「出现位置 + 后面 240 字符里有没有 , event)」判
const callSites = [];
for (let i = bridge.indexOf('feedSlangWindow('); i >= 0; i = bridge.indexOf('feedSlangWindow(', i + 1)) {
  if (bridge.slice(Math.max(0, i - 9), i) === 'function ') continue; // 跳过函数定义本身
  callSites.push(bridge.slice(i, i + 240));
}
const bad = callSites.filter((s) => !/,\s*event\s*\)/.test(s));
if (callSites.length === 0) fail('没找到任何 feedSlangWindow 调用点');
else if (bad.length === 0) pass(`${callSites.length} 个喂料点都传了 event`);
else fail(`有 ${bad.length} 个喂料点没传 event：${bad.map((s) => s.split('\n')[0].trim()).join(' / ')}`);

// ── 定义体必须真的调 isKnownBot（别哪天被改成只看前缀） ─────────────────
if (/isKnownBot\(/.test(src)) pass('slangFeedAllowed 里调了 isKnownBot');
else fail('slangFeedAllowed 没有调 isKnownBot —— 机器人又会被当成真人学进去');

if (failures) { console.error(`\n# fail ${failures}`); process.exit(1); }
console.log('\n# fail 0');
