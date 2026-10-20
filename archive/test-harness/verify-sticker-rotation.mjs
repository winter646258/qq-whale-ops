import fs from 'node:fs';

const { buildStickerContext } = await import('/tmp/st-test/sticker-lib.js');
const raw = JSON.parse(fs.readFileSync('/tmp/st-test/stickers.json', 'utf8'));
const entries = raw.stickers || raw;

const extract = (txt) => txt.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.replace(/^- /, ''));
const descOf = (line) => line.split(' [')[0].split('（用过')[0].trim();

// 与补丁内一致的判定（用于独立复核）
const describeLess = (s) => {
  const raw = String(s || '').trim();
  if (!raw) return true;
  const st = raw.replace(/[0-9a-f]{8,}/gi, '').replace(/[0-9]{4,}/g, '')
    .replace(/[『』【】<>《》()（）\[\]]/g, '')
    .replace(/表情包|表情|DeepSeek娘|DeepSeek|deepseek/gi, '').trim();
  return ((st.match(/[\u4e00-\u9fa5]/g) || []).length) < 2;
};

console.log('=== ① 轮换池规模 ===');
const poolSize = entries.filter((e) => (e.desc || e.localNote) && !describeLess(e.desc || e.localNote)).length;
console.log('  干净轮换池:', poolSize, '/', entries.length, `（排除 ${entries.length - poolSize} 条无信息量描述）`);

console.log('\n=== ② 默认候选池 ===');
const base = buildStickerContext(entries, 8);
console.log(base);
console.log('\n  长度:', base.length, '字符');

console.log('\n=== ③ 抽样 800 次，检查是否还有垃圾文案 ===');
let junk = 0, junkSample = [];
for (let i = 0; i < 800; i++) {
  for (const line of extract(buildStickerContext(entries, 8, { daySeed: i * 2654435761 }))) {
    if (describeLess(descOf(line))) { junk++; if (junkSample.length < 3) junkSample.push(descOf(line)); }
  }
}
console.log('  垃圾文案出现次数:', junk, junk === 0 ? '✅' : `⚠️ 例: ${junkSample.join(' / ')}`);

console.log('\n=== ④ 头部稳定 / 跨天轮换 ===');
const d1 = buildStickerContext(entries, 8, { daySeed: 11111 });
const d1b = buildStickerContext(entries, 8, { daySeed: 11111 });
const d2 = buildStickerContext(entries, 8, { daySeed: 99999 });
const usedDescs = entries.filter((e) => (e.useCount || 0) > 0).map((e) => e.desc || e.localNote);
const first5 = extract(base).slice(0, 5).map(descOf);
console.log('  用过的图:', usedDescs.length, '张；候选池前 5 条中命中的:',
  first5.filter((x) => usedDescs.some((u) => String(u) && x.includes(String(u).slice(0, 10)))).length, '/ 5');
console.log('  同日可复现:', JSON.stringify(extract(d1)) === JSON.stringify(extract(d1b)) ? '✅' : '❌');
console.log('  跨天不同  :', JSON.stringify(extract(d1)) !== JSON.stringify(extract(d2)) ? '✅' : '❌');

console.log('\n=== ⑤ 覆盖度（模拟 90 天轮换）===');
const seen = new Set();
for (let i = 0; i < 90; i++) for (const x of extract(buildStickerContext(entries, 8, { daySeed: i * 7919 + 13 }))) seen.add(descOf(x));
console.log('  90 天出现过:', seen.size, '个不同文案（池子', poolSize, '）');

console.log('\n=== ⑥ 边界 ===');
console.log('  空库:', JSON.stringify(buildStickerContext([], 8)));
console.log('  mixTail=0 长度:', buildStickerContext(entries, 8, { mixTail: 0 }).length, '（≈原行为）');
console.log('  max=30 长度:', buildStickerContext(entries, 30).length);
console.log('  max=1:', extract(buildStickerContext(entries, 1)).length, '条');
