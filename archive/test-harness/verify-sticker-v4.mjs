import fs from 'node:fs';

const mod = await import('/tmp/st4/sticker-lib.js');
const build = mod.buildStickerContext;
const raw = JSON.parse(fs.readFileSync('/tmp/st4/stickers.json', 'utf8'));
const entries = raw.stickers || raw;

const GENERIC = /表情包|表情|DeepSeek娘|DeepSeek|deepseek|鲸娘|大肥鱼|AI娘|Claude娘|GPT娘|Kimi娘|Gemini娘|Grok娘|豆大妈|无字/gi;
const stripAll = (s) => String(s || '')
  .replace(/[0-9a-f]{8,}/gi, '').replace(/[0-9]{4,}/g, '')
  .replace(/[『』【】<>《》()（）\[\]]/g, '').replace(GENERIC, '').trim();
const hanCount = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;
const informativeDesc = (s) => hanCount(stripAll(s)) >= 2;
const hasHumanNote = (e) => Boolean(String(e.localNote || '').trim()) || Boolean(String(e.usage || '').trim());
const allowedInPool = (e) => {
  if ((e.useCount || 0) > 0) return true;
  if (hasHumanNote(e)) return true;
  return informativeDesc(e.desc);
};

// 把候选行还原成「有效 desc」（去掉标签/用过标记，并把截断的 … 去掉）
const lineToDesc = (line) => {
  let d = line.replace(/^- /, '');
  d = d.split(' [')[0];                 // 去掉标签
  d = d.split('（用过')[0];             // 去掉用过标记
  d = d.trim();
  if (d.endsWith('…')) d = d.slice(0, -1);
  return d;
};

console.log('=== ① 泄漏复检（用前缀匹配，处理 60 字截断）===');
let leak = 0, checked = 0, samp = [];
for (let i = 0; i < 3000; i++) {
  const ctx = build(entries, 8, { daySeed: i * 2654435761 });
  for (const line of ctx.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const d = lineToDesc(line);
    checked++;
    // 前缀匹配：库里任意条目 desc 以 d 开头（或 d 是其前缀）
    const cands = entries.filter((e) => {
      const ed = String(e.desc || '').trim();
      return ed === d || ed.startsWith(d) || d.startsWith(ed.slice(0, 40));
    });
    if (!cands.length) { /* 可能是 localNote 当标签用的情况，跳过 */ continue; }
    if (!cands.some(allowedInPool)) {
      leak++;
      if (samp.length < 5) samp.push(d.slice(0, 40));
    }
  }
}
console.log(`  检查 ${checked} 行；真泄漏 ${leak} 次 ${leak === 0 ? '✅' : '❌'}`);
samp.forEach((s) => console.log('   泄漏样例:', s));

console.log('\n=== ② 候选池成分审计（核心指标）===');
const poolIds = new Set();
for (let i = 0; i < 800; i++) {
  const ctx = build(entries, 8, { daySeed: i * 7919 + 3 });
  for (const line of ctx.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const d = lineToDesc(line);
    for (const e of entries) {
      const ed = String(e.desc || '').trim();
      if (ed === d || ed.startsWith(d) || d.startsWith(ed.slice(0, 40))) poolIds.add(e.id);
    }
  }
}
const arr = [...poolIds].map((id) => entries.find((e) => e.id === id)).filter(Boolean);
const threeNothing = arr.filter((e) => (e.useCount || 0) === 0 && !hasHumanNote(e) && !informativeDesc(e.desc));
console.log(`  800 次抽样覆盖 ${arr.length} 个条目`);
console.log(`  三无条目（无use/无note/描述无料）: ${threeNothing.length} ${threeNothing.length === 0 ? '✅' : '❌'}`);
threeNothing.slice(0, 5).forEach((b) => console.log('   ', b.id, String(b.desc).slice(0, 40)));

console.log('\n=== ③ 泛化占位是否真的进不来（直接查规则）===');
const genericEntries = entries.filter((e) => (e.useCount || 0) === 0 && !hasHumanNote(e) && !informativeDesc(e.desc));
console.log(`  库中「泛化占位且无保护」条目: ${genericEntries.length}`);
console.log(`  按规则应全部排除；抽查 500 条是否混进候选池:`);
const poolSet = new Set();
for (let i = 0; i < 200; i++) {
  const ctx = build(entries, 8, { daySeed: i * 104729 });
  for (const line of ctx.split('\n')) if (line.startsWith('- ')) poolSet.add(lineToDesc(line));
}
const hit = genericEntries.filter((e) => {
  const ed = String(e.desc || '').trim();
  return [...poolSet].some((d) => ed === d || ed.startsWith(d));
});
console.log(`  抽到 ${hit.length} 条 ${hit.length === 0 ? '✅ 全部挡住' : '❌ 漏了'}`);
hit.slice(0, 5).forEach((e) => console.log('   ', e.id, String(e.desc).slice(0, 36)));

console.log('\n=== ④ 硬保护用例 ===');
const cases = [
  ['有note + 泛化desc ⇒ 保留', entries.find((e) => (e.useCount || 0) === 0 && hasHumanNote(e) && !informativeDesc(e.desc)), true],
  ['无note + 泛化desc ⇒ 排除', entries.find((e) => (e.useCount || 0) === 0 && !hasHumanNote(e) && !informativeDesc(e.desc)), false],
  ['有信息量 desc ⇒ 保留', entries.find((e) => (e.useCount || 0) === 0 && !hasHumanNote(e) && informativeDesc(e.desc)), true],
  ['用过 ⇒ 保留', entries.find((e) => (e.useCount || 0) > 0), true],
];
let pass = 0;
for (const [name, e, want] of cases) {
  if (!e) { console.log(`  SKIP ${name}（无样本）`); continue; }
  const got = allowedInPool(e);
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}: ${e.id} desc="${String(e.desc).slice(0, 24)}" -> ${got}`);
  if (ok) pass++;
}
console.log(`  用例 ${pass}/4`);
