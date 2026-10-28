// 学习会话「completed 但空文本」：判定表 + 线上接线检查。
import fs from 'node:fs';
import path from 'node:path';
import { learnerOutcome, LEARNER_RETRY_NUDGE } from '../src/learner-retry.js';

let pass = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${extra ? ' —— ' + extra : ''}`);
}
function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// ---- 判定表 ----
const done = learnerOutcome({ kind: 'completed', text: '结论：这个词是「厉害」的谐音' });
eq('有正文 → 交付', done.action, 'resolve');
ok('交付的是 trim 过的正文', done.text === '结论：这个词是「厉害」的谐音');

const doneTrim = learnerOutcome({ kind: 'completed', text: '  两边有空格  ' });
eq('两侧空白被去掉', doneTrim.text, '两边有空格');

eq('只有空白 → 重试', learnerOutcome({ kind: 'completed', text: '   \n\t ' }).action, 'retry');
eq('空字符串 → 重试', learnerOutcome({ kind: 'completed', text: '' }).action, 'retry');
eq('重试过一次还空 → 失败', learnerOutcome({ kind: 'completed', text: '', retried: true }).action, 'reject');
ok('失败原因写明是空回复', String(learnerOutcome({ kind: 'completed', text: '', retried: true }).reason).includes('空回复'));
eq('error 不重试，直接失败', learnerOutcome({ kind: 'error', text: '', retried: false }).action, 'reject');
eq('error 原因原样带出', learnerOutcome({ kind: 'error', text: '' }).reason, 'error');
eq('aborted 不重试', learnerOutcome({ kind: 'aborted', text: '半截话' }).action, 'reject');
eq('没 kind 时 fail-closed', learnerOutcome({}).reason, 'unknown');
eq('没参数也不炸', learnerOutcome().action, 'reject');
ok('重试那句话点明「一个字都没输出」', LEARNER_RETRY_NUDGE.includes('一个字都没输出'));
ok('重试那句要求「不要留空」', LEARNER_RETRY_NUDGE.includes('不要留空'));

// ---- 线上接线 ----
const src = fs.readFileSync(path.join(process.cwd(), 'src', 'bridge.js'), 'utf8');
ok('bridge 引了 learner-retry', src.includes("from './learner-retry.js'"));
ok('带了 MARKER', src.includes('MARKER: learner-empty-retry'));
ok('用判定函数而不是内联 if', src.includes('learnerOutcome({'));
ok('重试只做一次（emptyRetried 标记）', src.includes('waiter.emptyRetried = true'));
ok('重试后不把会话踢出集合', src.includes('!retriedNow && frame.sessionId !=='));
ok('重试失败会 reject 并清掉 waiter', src.includes('学习会话重试失败'));
ok('没正文时不再直接 reject', !src.includes('if (learnerEnded.reason.kind === \'completed\' && learnerEnded.text.trim()) {'));
ok('软上限接在落盘上', src.includes('saveSlang(SLANG_FILE, slangEntries, { max: cap })'));
ok('软上限从配置读', src.includes('resolveSlangCap(cfg.slang?.softCap)'));

console.log(`\n学习会话空回复：${pass} 项通过，${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log('全绿 ✓');