// 表情包「观测层」的回归守卫。
//
// 背景（真事，2026-10-27）：群里天天有人发表情包，vision 一天识别几十张，
// 但 `state/sticker-sightings.json` 停在 {"items":[]} 二十多个小时没动，
// 每次启动只打「观测层已启用，已记录 0 张图」。
// 根因不是模块坏了，是**没人调它**：recordSightings 只挂在 v1 的 appendRecentMessage 里，
// 而线上跑的 reserved2 分支在 appendSocialV2Message 之后十几行才到那个函数，
// 中间早就 return 了 —— 观测层永远收不到群消息。
//
// 这个用例守两件事：
//   ① 模块本身能用（媒体哈希提取 + 计数 + 落盘读回）
//   ② 两代入库函数**都**挂着这个钩子（漏一个就等于没修）
//
// 用法：node scripts/test-sticker-sightings-hook.mjs

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BRIDGE = path.join(ROOT, 'src', 'bridge.js');
const MODULE = path.join(ROOT, 'src', 'sticker-sightings.js');

// 临时目录：不写 C 盘（全局规矩）
const TMPROOT = process.platform === 'win32'
  ? 'D:\\DSH-Lab\\disk-guard\\cache\\tmp'
  : os.tmpdir();
const TMP = path.join(TMPROOT, 'stickers-test');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

let pass = 0;
const fail = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✅ ${name}`);
  } catch (e) {
    fail.push(`${name} —— ${e.message}`);
    console.log(`❌ ${name} —— ${e.message}`);
  }
}

const { mediaHashes, initSightings, recordSightings, flushSightingsNow, readSightings } =
  await import(pathToFileURL(MODULE).href);

// ── 一、模块本身 ─────────────────────────────────────────
check('媒体数组里认出 32 位 hex 文件名的图片', () => {
  const hashes = mediaHashes([
    { kind: 'image', file: 'A5A2B725A31BE3972FDD3A4793062908.png', url: 'http://a/1' },
    { kind: 'image', file: 'not-a-hash.jpg' },
    { kind: 'record', file: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC.amr' },
    null,
  ]);
  assert.equal(hashes.length, 1);
  assert.equal(hashes[0].hash, 'A5A2B725A31BE3972FDD3A4793062908');
  assert.equal(hashes[0].url, 'http://a/1');
});

check('没有 32 位文件名时退回 md5 字段', () => {
  const hashes = mediaHashes([{ kind: 'image', file: 'x.png', md5: 'bbadc1f5f0d9a5a4b1e6b5f4c3a29180' }]);
  assert.equal(hashes.length, 1);
  assert.equal(hashes[0].hash, 'BBADC1F5F0D9A5A4B1E6B5F4C3A29180');
});

check('初始化后记录一张图能落盘读回（含上下文与人名）', () => {
  const n = initSightings(TMP, { enabled: true, max: 500, ttlDays: 30 });
  assert.equal(n, 0, '新目录应该是空的');
  const touched = recordSightings(
    'group:201188739',
    [{ kind: 'image', file: 'A5A2B725A31BE3972FDD3A4793062908.png', url: 'http://a/1' }],
    { sender: '小明', text: '这猫好像你' },
  );
  assert.equal(touched, 1);
  assert.equal(flushSightingsNow(), true, 'dirty 之后应该能落盘');
  const back = readSightings(TMP, { enabled: true, max: 500, ttlDays: 30 });
  const list = Array.isArray(back) ? back : (back.items || []);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 1);
  assert.deepEqual(list[0].contexts, ['小明：这猫好像你']);
  assert.equal(list[0].sampleKey, 'group:201188739');
});

check('同一张图第二次出现只加计数、不新增条目', () => {
  recordSightings('group:201188739', [{ kind: 'image', file: 'A5A2B725A31BE3972FDD3A4793062908.png' }], { sender: '小红', text: '又来了' });
  flushSightingsNow();
  const back = readSightings(TMP, { enabled: true, max: 500, ttlDays: 30 });
  const list = Array.isArray(back) ? back : (back.items || []);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 2);
});

check('不是图片的媒体一条都不记', () => {
  const before = (readSightings(TMP, { enabled: true, max: 500, ttlDays: 30 }).items || []).length;
  const touched = recordSightings('group:1', [{ kind: 'record', file: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC.amr' }], { sender: 'x', text: 'y' });
  assert.equal(touched, 0);
  assert.equal((readSightings(TMP, { enabled: true, max: 500, ttlDays: 30 }).items || []).length, before);
});

// ── 二、钩子必须挂在两代入库函数上 ──────────────────────
const src = fs.readFileSync(BRIDGE, 'utf8');

/** 从源码里按花括号配对抠出一个函数体（`function NAME(...) {` 起算）。 */
function functionBody(name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `源码里找不到 function ${name}(`);
  const open = src.indexOf('{', at);
  assert.ok(open > at, `${name} 找不到函数体起点`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${name} 花括号不配对`);
}

const v2Body = functionBody('appendSocialV2Message');
const v1Body = functionBody('appendRecentMessage');

check('reserved2 的入库函数（appendSocialV2Message）里挂上了 recordSightings', () => {
  assert.match(v2Body, /recordSightings\s*\(/, '这就是二十小时记 0 张图的根因：没人调');
  assert.match(v2Body, /sticker-sightings-v2/, '补丁应该带 MARKER，便于以后认出来');
});

check('v1 的 appendRecentMessage 钩子没被移走（两代都要有）', () => {
  assert.match(v1Body, /recordSightings\s*\(/);
});

check('钩子走 safeMedia 而不是可能没定义的变量，且只在有图时才动手', () => {
  assert.match(v2Body, /if\s*\(\s*safeMedia\.length\s*\)/, '没有图就不该进这段');
  assert.match(v2Body, /recordSightings\(key,\s*safeMedia/, '必须把 safeMedia 传进去');
});

check('钩子整段包在 try 里（观测层永不抛）', () => {
  const seg = v2Body.slice(v2Body.indexOf('sticker-sightings-v2'));
  assert.match(seg.slice(0, 1200), /try\s*\{[\s\S]*recordSightings/, 'recordSightings 必须包在 try 里');
});

// 收尾：清掉临时库，别留垃圾
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n# pass ${pass}  # fail ${fail.length}`);
for (const f of fail) console.log(`  ✗ ${f}`);
process.exit(fail.length ? 1 : 0);
