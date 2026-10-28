// 孤立代理修复：函数本身 + 两个 truncate + 发送收口
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repairSurrogates, truncateText, truncateTextTail } from '../src/md-to-plain.js';

let pass = 0;
let fail = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const ok = (v, msg) => assert.ok(v, msg);
const eq = (a, b, msg) => assert.equal(a, b, msg);

// 一个完整 emoji（两个码元）拆开
const EMOJI = '🐳';
const HIGH = EMOJI[0];
const LOW = EMOJI[1];

// ---------- repairSurrogates ----------
t('完整 emoji 原样保留', () => eq(repairSurrogates(`a${EMOJI}b`), `a${EMOJI}b`));
t('孤立高代理换成替换字符', () => eq(repairSurrogates(`a${HIGH}b`), 'a\uFFFDb'));
t('孤立低代理换成替换字符', () => eq(repairSurrogates(`a${LOW}b`), 'a\uFFFDb'));
t('连着的两个孤立高代理都换掉', () => eq(repairSurrogates(HIGH + HIGH), '\uFFFD\uFFFD'));
t('空值不炸', () => {
  eq(repairSurrogates(null), '');
  eq(repairSurrogates(undefined), '');
  eq(repairSurrogates(0), '0');
});
t('普通中文英文不受影响', () => eq(repairSurrogates('小鲸鱼 abc 123'), '小鲸鱼 abc 123'));
t('修完不再含孤立代理（自检）', () => {
  const messy = `x${HIGH}y${LOW}z${EMOJI}`;
  const out = repairSurrogates(messy);
  for (let i = 0; i < out.length; i += 1) {
    const c = out.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = out.charCodeAt(i + 1);
      ok(n >= 0xdc00 && n <= 0xdfff, `位置 ${i} 是孤立高代理`);
      i += 1; // 成对跳过，否则下一轮会把这一对里的低代理当成孤儿
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      ok(false, `位置 ${i} 是孤立低代理`);
    }
  }
});

// ---------- truncateText ----------
t('截断不切半个 emoji（切点正好在 emoji 中间）', () => {
  const s = `12${EMOJI}`;           // 码元：1,2,高,低
  eq(truncateText(s, 3), '12');      // 不会留着高代理
});
t('截断保留能放下的完整 emoji', () => eq(truncateText(`12${EMOJI}`, 4), `12${EMOJI}`));
t('截断会顺手修掉输入里的孤儿代理', () => eq(truncateText(`a${HIGH}b`, 10), 'a\uFFFDb'));
t('普通截断照旧', () => eq(truncateText('abcdef', 3), 'abc'));

// ---------- truncateTextTail ----------
t('尾部截断不从低代理开头', () => {
  const s = `${EMOJI}abc`;          // 高,低,a,b,c
  eq(truncateTextTail(s, 3), 'abc');
});
t('尾部截断能留下完整 emoji', () => eq(truncateTextTail(`${EMOJI}abc`, 5), `${EMOJI}abc`));
t('尾部截断修孤儿', () => eq(truncateTextTail(`${LOW}abc`, 4), '\uFFFDabc'));

// ---------- 接线静态检查 ----------
const bridge = fs.readFileSync(path.join(process.cwd(), 'src/bridge.js'), 'utf8');
t('bridge 在 api.sessions.prompt 外面收口', () => {
  ok(bridge.includes('MARKER: prompt-surrogate-repair'));
  ok(bridge.includes('repairSurrogates, splitForQQ'));
  ok(bridge.includes('api.sessions.prompt = (args) =>'));
});
t('收口在 api 创建之后（拿得到 api）', () => {
  const apiAt = bridge.indexOf('const api = new NodeApiClient');
  const wrapAt = bridge.indexOf('MARKER: prompt-surrogate-repair');
  ok(apiAt > 0 && wrapAt > apiAt, '收口必须写在 api 创建之后');
});

for (const [name, fn] of cases) {
  try { fn(); pass += 1; } catch (error) { fail += 1; console.log(`✗ ${name}\n   ${error.message}`); }
}
console.log(`孤立代理修复：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
