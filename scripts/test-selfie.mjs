// 自拍 / 合照：纯逻辑 + 接线静态检查
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SELFIE_DEFAULTS,
  SELFIE_IDENTITY,
  SELFIE_STYLES,
  SELFIE_SCENES,
  selfieCfg,
  cleanScene,
  resolveScene,
  buildSelfiePrompt,
  selfieQuota,
  selfieFileName,
} from '../src/selfie.js';

let pass = 0;
let fail = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const ok = (v, msg) => assert.ok(v, msg);
const eq = (a, b, msg) => assert.deepEqual(a, b, msg);

// ---------- 配置 ----------
t('默认值', () => {
  const c = selfieCfg(null);
  eq(c.enabled, true);
  eq(c.style, 'photo');
  eq(c.maxPerDay, 3);
  eq(c.partnerFace, 'avoid');
});

t('脏值回落（null 不变 0、未知 style 回落）', () => {
  const c = selfieCfg({ socialV2: { selfie: { maxPerDay: null, style: '油画', sceneChars: 'x', partnerFace: 'allow' } } });
  eq(c.maxPerDay, 3);
  eq(c.style, 'photo');
  eq(c.sceneChars, SELFIE_DEFAULTS.sceneChars);
  eq(c.partnerFace, 'allow');
});

t('enabled 只认 false', () => {
  eq(selfieCfg({ socialV2: { selfie: { enabled: false } } }).enabled, false);
  eq(selfieCfg({ socialV2: { selfie: { enabled: 0 } } }).enabled, true);
});

// ---------- 场景 ----------
t('预设场景命中', () => {
  const r = resolveScene('在咖啡店坐着', { ...SELFIE_DEFAULTS });
  eq(r.keyword, '咖啡店');
  ok(r.text.includes('咖啡店'));
});

t('认不出就用原话', () => {
  const r = resolveScene('在天台上看飞机', { ...SELFIE_DEFAULTS });
  eq(r.keyword, '');
  eq(r.text, '在天台上看飞机');
});

t('空场景给默认（家里）', () => {
  eq(resolveScene('', { ...SELFIE_DEFAULTS }).keyword, '家里');
  eq(resolveScene('   ', { ...SELFIE_DEFAULTS }).keyword, '家里');
});

t('场景超长截断', () => {
  const s = cleanScene('长'.repeat(400), { ...SELFIE_DEFAULTS, sceneChars: 20 });
  ok(s.length <= 20);
  ok(s.endsWith('…'));
});

// ---------- 提示词 ----------
t('提示词带身份锁与画风', () => {
  const r = buildSelfiePrompt({ scene: '家里' });
  ok(r.prompt.includes(SELFIE_IDENTITY.slice(0, 20)));
  ok(r.prompt.includes(SELFIE_STYLES.photo.slice(0, 12)));
  ok(r.prompt.includes('只有她一个人'));
  ok(!r.prompt.includes('“'));
});

t('合照默认不画对方正脸', () => {
  const r = buildSelfiePrompt({ scene: '海边', withPartner: true });
  ok(r.prompt.includes('不要画出他的脸'));
  ok(r.prompt.includes('肩膀'));
});

t('允许正脸时可调', () => {
  const r = buildSelfiePrompt({ scene: '海边', withPartner: true, cfg: { ...SELFIE_DEFAULTS, partnerFace: 'allow' } });
  ok(r.prompt.includes('两个人的脸都要清楚'));
});

t('手绘风格可切', () => {
  const r = buildSelfiePrompt({ scene: '街上', style: 'sketchbook' });
  eq(r.style, 'sketchbook');
  ok(r.prompt.includes('彩铅'));
});

t('未知风格回落默认', () => {
  eq(buildSelfiePrompt({ scene: '街上', style: '油画' }).style, 'photo');
});

t('总有防文字水印的约束', () => {
  ok(buildSelfiePrompt({}).prompt.includes('不要出现任何文字'));
});

t('提示词不超上限', () => {
  const r = buildSelfiePrompt({ scene: '长'.repeat(400), cfg: { ...SELFIE_DEFAULTS, promptChars: 260 } });
  ok(r.prompt.length <= 260);
});

// ---------- 配额 ----------
t('配额：没画过可以拍', () => ok(selfieQuota({ todayCount: 0 }).allowed));
t('配额：到上限就不拍', () => eq(selfieQuota({ todayCount: 3 }).allowed, false));
t('配额：关掉就不能拍', () => eq(selfieQuota({ todayCount: 0, cfg: { ...SELFIE_DEFAULTS, enabled: false } }).allowed, false));
t('配额：脏数字不炸', () => ok(selfieQuota({ todayCount: null }).allowed));

// ---------- 文件名 ----------
t('文件名按时间且是 png', () => {
  const n = selfieFileName(new Date('2026-10-29T00:05:09+08:00').getTime());
  ok(/^selfie-\d{8}-\d{6}\.png$/.test(n), n);
});

// ---------- 接线静态检查 ----------
const bridge = fs.readFileSync(path.join(process.cwd(), 'src/bridge.js'), 'utf8');
const gen = fs.readFileSync(path.join(process.cwd(), 'src/modules/image/generate.js'), 'utf8');
const mcp = fs.readFileSync(path.join(process.cwd(), 'src/mcp-snowluma-safe.js'), 'utf8');

t('bridge 有参考图生图与三条辅助', () => {
  ok(bridge.includes('MARKER: selfie-runtime'));
  ok(bridge.includes('/images/edits'));
  ok(bridge.includes('function selfieRefPath'));
  ok(bridge.includes('function selfieCountToday'));
  ok(bridge.includes('new Blob('));
});
t('bridge 把句柄交给模块', () => {
  ok(bridge.includes('MARKER: selfie-helpers'));
  ok(bridge.includes('generateImageWithRef: (opts) => generateImageWithRef(opts)'));
  ok(bridge.includes('selfieQuotaCheck:'));
});
t('模块有 selfie 分支且走参考图', () => {
  ok(gen.includes('MARKER: image-selfie'));
  ok(gen.includes("action === 'selfie'"));
  ok(gen.includes('await h.generateImageWithRef('));
  ok(gen.includes("kind: isSelfie ? 'selfie' : 'generate'"));
  // 自拍不需要 prompt，别让它被空 prompt 卡住
  ok(gen.includes('if (isSelfie) {'), '有 selfie 分支');
  ok(gen.includes('} else {'), '空 prompt 校验必须在 else 里');
});
t('MCP 暴露 action=selfie 与三个参数', () => {
  ok(mcp.includes("z.enum(['generate', 'recent', 'selfie'])"));
  ok(mcp.includes('withPartner: z.boolean()'));
  ok(mcp.includes('style: z.enum([\'photo\', \'sketchbook\'])'));
  ok(mcp.includes("act === 'selfie'"));
});

for (const [name, fn] of cases) {
  try { fn(); pass += 1; } catch (error) { fail += 1; console.log(`✗ ${name}\n   ${error.message}`); }
}
console.log(`自拍/合照：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
