// 看图三件事：接线静态检查 + 描述回灌/窗口放宽的关键约束
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const ok = (v, msg) => assert.ok(v, msg);

const bridge = fs.readFileSync(path.join(process.cwd(), 'src/bridge.js'), 'utf8');
const gen = fs.readFileSync(path.join(process.cwd(), 'src/modules/image/generate.js'), 'utf8');
const mcp = fs.readFileSync(path.join(process.cwd(), 'src/mcp-snowluma-safe.js'), 'utf8');

// ---------- 1) 她自己画的图 ----------
t('画完会描述并回灌', () => {
  ok(gen.includes('MARKER: image-feedback'));
  ok(gen.includes('await h.describeLocalImageFile(result.path)'));
  ok(gen.includes('h.noteSelfImage(key, artDesc'));
});
t('登记表带上 desc/kind/day', () => {
  ok(bridge.includes('desc: String(entry?.desc ?? \'\').slice(0, 400)'));
  ok(bridge.includes("kind: String(entry?.kind ?? 'generate')"));
  ok(bridge.includes('day: localDayOf('));
});
t('noteSelfImage 写成「她自己发的消息」', () => {
  ok(bridge.includes('function noteSelfImage'));
  ok(bridge.includes('isSelf: true'));
  ok(bridge.includes('[我发了张图]'));
});

// ---------- 2) 看历史图 ----------
t('有 describeMediaByRef，且按消息取图', () => {
  ok(bridge.includes('async function describeMediaByRef'));
  ok(bridge.includes('messageId') && bridge.includes('recentMessages'));
  ok(bridge.includes('fetchOneBotImage(media)'));
});
t('看过一次就写回原文（后面轮次都能看见）', () => {
  ok(bridge.includes('media.desc = clean.slice(0, 400)'));
  ok(bridge.includes('saveSocialV2State()'));
});
t('命过缓存的不重复花钱', () => {
  ok(bridge.includes('if (cached && !opts.refresh)'));
});
t('模块有 see 分支且不需要 prompt', () => {
  ok(gen.includes('MARKER: image-see-action'));
  ok(gen.includes("if (action === 'see')"));
  ok(gen.includes('h.describeMediaByRef(key'));
  ok(gen.includes("可用 generate / selfie / see / status / recent"));
});
t('MCP 暴露 see 与四个参数', () => {
  ok(mcp.includes("'generate', 'recent', 'selfie', 'see'"));
  ok(mcp.includes('messageRef: z.string()'));
  ok(mcp.includes('refresh: z.boolean()'));
  ok(mcp.includes("act === 'see'"));
});

// ---------- 3) 群里 @ 能画 ----------
t('主人说过话的窗口改成可配（默认 10 分钟）', () => {
  ok(bridge.includes('MARKER: image-owner-window'));
  ok(bridge.includes('Number(cfg.socialV2?.image?.ownerSpokeMs) || 600000'));
  ok(!bridge.includes('const cutoff = Date.now() - 120000;'));
});
t('群宽限把真实 reason 传下去', () => {
  ok(bridge.includes("imageSceneFor(key, String(ended.reason || ''))"));
  ok(!bridge.includes("imageSceneFor(key, '')"));
});

for (const [name, fn] of cases) {
  try { fn(); pass += 1; } catch (error) { fail += 1; console.log(`✗ ${name}\n   ${error.message}`); }
}
console.log(`看图三件事：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
