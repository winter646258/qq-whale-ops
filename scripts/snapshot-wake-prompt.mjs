#!/usr/bin/env node
/**
 * 阶段 0-5：唤醒提示词基线快照。
 *
 * 为什么需要它：插件化改造要动 `buildWakePromptV2` 的组装逻辑（拆成模块后，前缀顺序、
 * 片段去留都可能变）。改动前先钉死「现在长什么样」，改完逐字节比对，任何非预期的漂移
 * 都会被抓住。
 *
 * 做法：在**隔离的 node 子进程**里只把 `buildWakePromptV2` 的函数原文抠出来求值
 * （不启动 OneBot、不连 DSH、不监听端口、不触网）。它是 `main()` 内的闭包、无法
 * import，所以给它配一套确定性的「外部世界桩」：角色卡、状态、日程/画像/情绪库、
 * 生图场景判定、发信记录。这些不是本次改造对象；真正要比对的是组装逻辑本身
 * （角色行 → 令牌 → 反AI味 → … → 沉睡前等待，共 20 段 + 结尾按 reason 分支）。
 *
 * 用法：
 *   node scripts/snapshot-wake-prompt.mjs
 *   node scripts/snapshot-wake-prompt.mjs --out /tmp/x.json
 *   node scripts/snapshot-wake-prompt.mjs --compare state/wake-prompt-baseline.json
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = '/opt/qq-bridge';
const SRC = path.join(ROOT, 'src', 'bridge.js');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const cmpIdx = args.indexOf('--compare');
const OUT = outIdx >= 0 ? args[outIdx + 1] : path.join(ROOT, 'state', 'wake-prompt-baseline.json');
const CMP = cmpIdx >= 0 ? args[cmpIdx + 1] : null;

const src = fs.readFileSync(SRC, 'utf8');

/** 从函数声明处开始，按大括号配平截取整段函数体（跳过字符串/注释/模板串）。 */
function extractFn(text, name) {
  const re = new RegExp(`(^|\\n)([ \\t]*)function ${name}\\s*\\(`, 'm');
  const m = re.exec(text);
  if (!m) throw new Error(`找不到函数 ${name}`);
  const start = m.index + m[1].length;
  let i = text.indexOf('{', start);
  let depth = 0;
  let inStr = null;
  let inTpl = 0;
  let inLineCmt = false;
  let inBlockCmt = false;
  for (let p = i; p < text.length; p += 1) {
    const ch = text[p];
    const nxt = text[p + 1];
    if (inLineCmt) { if (ch === '\n') inLineCmt = false; continue; }
    if (inBlockCmt) { if (ch === '*' && nxt === '/') { inBlockCmt = false; p += 1; } continue; }
    if (inStr) { if (ch === '\\') { p += 1; continue; } if (ch === inStr) inStr = null; continue; }
    if (inTpl > 0) { if (ch === '\\') { p += 1; continue; } if (ch === '`') inTpl -= 1; continue; }
    if (ch === '/' && nxt === '/') { inLineCmt = true; p += 1; continue; }
    if (ch === '/' && nxt === '*') { inBlockCmt = true; p += 1; continue; }
    if (ch === '\'' || ch === '"') { inStr = ch; continue; }
    if (ch === '`') { inTpl += 1; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return text.slice(start, p + 1); }
  }
  throw new Error(`函数 ${name} 大括号不配平`);
}

const TARGET = 'buildWakePromptV2';
const mainBody = extractFn(src, TARGET);

// 固定输入样本：覆盖群/私聊 + 高优先/低优先 + 各 reason 分支
const SAMPLES = [
  { key: 'group:906710082', reason: 'atMention' },
  { key: 'group:906710082', reason: 'question' },
  { key: 'group:906710082', reason: 'probability' },
  { key: 'group:201188739', reason: 'nameMention' },
  { key: 'private:1124721191', reason: 'private' },
  { key: 'group:906710082', reason: 'replyCheck' },
  { key: 'group:906710082', reason: 'bootstrap' },
];

const stubsSource = `
const cfg = STUB_CFG;
const ROLE_STATE_FILE = '/tmp/role.json';
const readJsonSafe = () => ({ role: '小鲸鱼', mode: 'active' });
const roleCardInjectSeen = new Map();
const log = () => {};
const readRoleState = () => ({ role: '小鲸鱼', mode: 'active' });
const currentRoleHintV2 = () => STUB_CARD;
const getSocialV2State = (key) => STUB_STATE[key] || STUB_STATE.__default;
const formatMemoryV2 = (st) => st.__memory || '';
const buildSharedMemoryLineFor = () => '';
const formatParticipationV2 = (st) => st.__participation || '';
const stickerEntries = [];
const buildStickerStrategyHint = () => '【表情包策略】<stub>';
const buildStickerContext = () => '<stub 表情包清单>';
const replyTimingV2 = () => ({ quietMs: 20000, remainingQuietMs: 8000 });
const looksLikeUnfinished = (t) => /[，,、…]$/.test(String(t));
const scheduleStore = () => ({});
const formatScheduleForPrompt = () => '【这几天的安排】<stub> 共 2 条';
const shouldReviewToday = () => false;
const markReviewed = () => {};
const saveScheduleSafe = () => {};
const portraitStore = () => ({});
const formatPortraitForPrompt = () => '【主人】<stub> 核心 1 人 / 共 3 人';
const moodStore = () => ({});
const describeMood = () => '【此刻心情】<stub> 有点懒';
const imageSceneFor = (key, reason) => (
  key.startsWith('private:') ? 'owner-private'
    : (reason === 'atMention' || reason === 'nameMention' ? 'owner-group' : null)
);
const buildAffinityLineFor = () => '【好感】<stub> 熟';
const buildGroupDigestLineFor = () => '';
const buildSleepReviewLineFor = () => '';
const shareLastDeliveryInfo = () => ({ valence: 0.5, summary: '<stub 事件>', sourceGroup: 'group:906710082' });
`;

const stateSource = `
const STUB_STATE = {
  __default: { agentToken: '', recentMessages: [], unread: [], wakeConfig: {} },
  'group:906710082': {
    agentToken: 'STUB-AGENT-TOKEN-GRP906',
    recentMessages: [
      { seq: 1, sender: '子房有礼了', text: '今天有人打终末地吗' },
      { seq: 2, sender: '星璃', text: '本猫在等草莓开饭呢 谁要去捞你喵' },
      { seq: 3, sender: '大肥鱼', text: '行 我去', isSelf: true }
    ],
    unread: [{ seq: 4, sender: '子房有礼了', text: '@大肥鱼 你来不来' }],
    lastAiReplyAt: 0,
    unreadCount: 1,
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true, nameMention: false, keywords: ['大肥鱼', '鲸鱼娘'], question: true, poke: true, probability: 0.01 } },
    __memory: '【进行中的话题】\\n- 终末地联机（3分钟前）',
    __participation: '<stub 参与度参考>'
  },
  'group:201188739': {
    agentToken: 'STUB-AGENT-TOKEN-GRP201',
    recentMessages: [{ seq: 11, sender: '主人', text: '画一张你哈气的图' }],
    unread: [{ seq: 12, sender: '主人', text: '画一张你哈气的图' }],
    lastAiReplyAt: 0,
    unreadCount: 1,
    wakeConfig: { mode: 'diving', infinite: true, triggers: { atMention: true, keywords: ['小鲸鱼', '大肥鱼', '鲸鱼'] } },
    __memory: '', __participation: ''
  },
  'private:1124721191': {
    agentToken: 'STUB-AGENT-TOKEN-PRIV',
    recentMessages: [{ seq: 21, sender: '主人', text: '在吗' }],
    unread: [{ seq: 21, sender: '主人', text: '在吗' }],
    lastAiReplyAt: 0,
    unreadCount: 1,
    wakeConfig: { mode: 'active', infinite: true, triggers: { private: true } },
    __memory: '', __participation: ''
  }
};
`;

const cfgJson = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
let cardText = '';
try { cardText = fs.readFileSync(path.join(ROOT, 'roles', '小鲸鱼.md'), 'utf8'); } catch { cardText = ''; }

const program = `
import crypto from 'node:crypto';
const STUB_CFG = ${cfgJson};
const STUB_CARD = ${JSON.stringify(cardText)};
${stubsSource}
${stateSource}
${mainBody}

const out = [];
for (const s of ${JSON.stringify(SAMPLES)}) {
  let text = '';
  let err = null;
  try { text = buildWakePromptV2(s.key, s.reason) ?? ''; } catch (e) { err = String(e?.message ?? e); }
  out.push({ key: s.key, reason: s.reason, length: text.length,
    sha256: crypto.createHash('sha256').update(text).digest('hex'), text, error: err });
}
process.stdout.write(JSON.stringify({ ok: true, samples: out }));
`;

let parsed;
try {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', program], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
  });
  parsed = JSON.parse(stdout);
} catch (e) {
  console.error('沙箱执行失败：', e?.message ?? e);
  if (e?.stderr) console.error(String(e.stderr).slice(0, 3000));
  process.exit(1);
}

// 片段顺序：把提示词切成可读的段，用于发现「顺序变了」
const CUT = /(?=【(?:当前角色|角色卡已更新|会话令牌|进行中的话题|反AI味|积极性|表情包策略|首回复节奏|此刻状态|此刻心情|画画|当前唤醒|这一轮要不要说话|沉睡前强制等待|好感|引导唤醒|唤醒|回复检查|主动机会|跟主人说一声)】)/;
const snapshot = {
  generatedAt: new Date().toISOString(),
  source: SRC,
  sourceSha256: crypto.createHash('sha256').update(src).digest('hex'),
  roleCardSha256: crypto.createHash('sha256').update(cardText).digest('hex'),
  target: TARGET,
  samples: parsed.samples.map((s) => ({
    ...s,
    segments: (s.text.match(CUT) ? s.text.split(CUT).filter(Boolean) : [s.text])
      .map((x) => x.slice(0, 30).replace(/\n/g, ' ')),
  })),
};

if (CMP) {
  if (!fs.existsSync(CMP)) { console.error(`基线文件不存在：${CMP}`); process.exit(2); }
  const base = JSON.parse(fs.readFileSync(CMP, 'utf8'));
  let bad = 0;
  console.log(`=== 与基线比对：${CMP} ===`);
  console.log(`基线生成于 ${base.generatedAt}（源码 sha ${base.sourceSha256.slice(0, 12)}）`);
  console.log(`当前源码 sha ${snapshot.sourceSha256.slice(0, 12)}`);
  const n = Math.max(base.samples.length, snapshot.samples.length);
  for (let i = 0; i < n; i += 1) {
    const a = base.samples[i];
    const b = snapshot.samples[i];
    if (!a || !b) { console.log(`样本 ${i}: 数量不一致`); bad += 1; continue; }
    const same = a.sha256 === b.sha256;
    console.log(`样本 ${i} ${b.key} ${b.reason}  长度 ${a.length} -> ${b.length}  ${same ? '逐字节相同' : '**不同**'}`);
    if (!same) {
      bad += 1;
      let p = 0;
      while (p < a.text.length && p < b.text.length && a.text[p] === b.text[p]) p += 1;
      console.log(`   首个差异第 ${p} 字符：`);
      console.log(`   基线 …${JSON.stringify(a.text.slice(Math.max(0, p - 50), p + 80))}`);
      console.log(`   现在 …${JSON.stringify(b.text.slice(Math.max(0, p - 50), p + 80))}`);
      console.log(`   基线片段 ${a.segments.length} 段 / 现在 ${b.segments.length} 段`);
    }
  }
  console.log(bad === 0 ? '结论：全部样本逐字节一致' : `结论：${bad} 个样本有差异`);
  process.exit(bad === 0 ? 0 : 3);
}

fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 1), 'utf8');
console.log(`已写基线：${OUT}`);
console.log(`源码 sha256  ${snapshot.sourceSha256}`);
console.log(`角色卡 sha256 ${snapshot.roleCardSha256}`);
for (const s of snapshot.samples) {
  console.log(`  ${s.key.padEnd(20)} ${s.reason.padEnd(14)} 长度 ${String(s.length).padStart(6)}  sha ${s.sha256.slice(0, 12)}  ${s.error ? 'ERROR ' + s.error : ''}`);
  console.log(`    片段(${s.segments.length}): ${s.segments.join(' | ')}`);
}
