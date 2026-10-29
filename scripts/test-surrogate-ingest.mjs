// 孤立代理（半个 emoji）三处收口 —— 回归用例
// 1) repairSurrogates / truncateText 本身的行为（真 import md-to-plain.js）
// 2) segmentsToText 的出口是否真的过了修复（静态检查 + 行为模拟）
// 3) prompt 收口日志判据必须是「序列化不相等」而不是「长度不相等」
//
// 线上背景：2026-10-29 15 次 `request contains an unpaired Unicode surrogate`。
// 长度判据那个坑就在于 \ud83d → \uFFFD 长度一样，按长度判永远打不出日志。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairSurrogates, truncateText, truncateTextTail } from '../src/md-to-plain.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const bridgeSrc = readFileSync(path.join(here, '..', 'src', 'bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    pass += 1;
    console.log('  ✅ ' + name);
  } else {
    fail += 1;
    console.log('  ❌ ' + name + (extra ? ' → ' + extra : ''));
  }
};

// 半个 emoji：孤立高代理 + 后续非低代理
const HALF = '那我以后改打\ud83d；你上次发言 7 分钟前';
// 完整 emoji：高+低代理对
const FULL = '那我以后改打\ud83e\udd14；你上次发言';

const orphanCount = (s) => {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const nx = s.charCodeAt(i + 1);
      if (nx >= 0xdc00 && nx <= 0xdfff) {
        i += 1;
        continue;
      }
      n += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      const pv = s.charCodeAt(i - 1);
      if (!(pv >= 0xd800 && pv <= 0xdbff)) n += 1;
    }
  }
  return n;
};

console.log('\n[1] repairSurrogates 本身');
ok('孤立高代理换成 U+FFFD', repairSurrogates(HALF).includes('\uFFFD'));
ok('修完不再有孤儿代理', orphanCount(repairSurrogates(HALF)) === 0, '剩 ' + orphanCount(repairSurrogates(HALF)));
ok('完整 emoji 原样保留', repairSurrogates(FULL) === FULL);
ok('修前后长度不变（这就是长度判据失效的原因）', repairSurrogates(HALF).length === HALF.length);
ok('修前后内容不同（所以要用内容比较）', repairSurrogates(HALF) !== HALF);
ok('纯中文不动', repairSurrogates('今天也没抢到票') === '今天也没抢到票');
ok('空值不炸', repairSurrogates(null) === '' && repairSurrogates(undefined) === '');

console.log('\n[2] truncateText 不切断 emoji');
// 'a' + 一个两码元 emoji → 截 2 个字符时不能只留高代理
const t1 = truncateText('a\ud83e\udd14b', 2);
ok('截断点落在代理对中间时前移一位', orphanCount(t1) === 0 && t1 === 'a', JSON.stringify(t1));
ok('截断后长度不超上限', truncateText('中文测试内容', 3).length <= 3);
ok('limit=1 且开头就是代理对时至少留一个完整字', orphanCount(truncateText('\ud83e\udd14abc', 1)) === 0);
ok('原文本有孤儿时先修再截', orphanCount(truncateText(HALF, 6)) === 0, JSON.stringify(truncateText(HALF, 6)));
const t2 = truncateTextTail('a\ud83e\udd14b', 2);
ok('尾部截断不留孤儿', orphanCount(t2) === 0, JSON.stringify(t2));
ok('尾部截断保留的是结尾', t2.endsWith('b'));

console.log('\n[3] bridge 接线（静态检查）');
ok('segmentsToText 出口过了 repairSurrogates', /return repairSurrogates\(out\.join\(''\)\.trim\(\)\);/.test(bridgeSrc));
ok('入站收口有 MARKER', bridgeSrc.includes('MARKER: surrogate-ingest'));
ok('prompt 收口还在', bridgeSrc.includes('MARKER: prompt-surrogate-repair'));
ok(
  'prompt 收口日志判据用序列化比较（不是长度）',
  /JSON\.stringify\(fixed\) !== JSON\.stringify\(args\)/.test(bridgeSrc) &&
    !/JSON\.stringify\(fixed\)\.length !== JSON\.stringify\(args\)\.length/.test(bridgeSrc)
);
ok('图片描述入库走 truncateText', /media\.desc = truncateText\(clean, 400\);/.test(bridgeSrc));
ok('图片标签走 truncateText', /\[图片\] \$\{truncateText\(media\.desc, 80\)\}/.test(bridgeSrc));
ok('自绘图回灌走 truncateText', /\[我发了张图\] \$\{truncateText\(desc, 200\)\}/.test(bridgeSrc));

console.log('\n[4] 端到端模拟：带毒的引用文本走一遍出口');
// 复现线上那条毒的构造方式：引用段拼接
const buildReply = (text) => `[引用 hesder：${text}]`;
const raw = buildReply('那我以后改打\ud83d');
ok('拼接后确实带毒（复现成功）', orphanCount(raw) === 1);
ok('过一遍出口就干净', orphanCount(repairSurrogates(raw)) === 0);
ok('修复后可 JSON 往返（上游能收）', JSON.parse(JSON.stringify(repairSurrogates(raw))) === repairSurrogates(raw));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
