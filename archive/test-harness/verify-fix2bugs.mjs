// 两个 bug 的修复验证。
//
// Bug 1（印象计时持久化）：验「存了 / 读回一致 / 缺失时给 0 而不是现在」
// Bug 2（黑话）：验补偿扫描的筛选逻辑 + batch-confirm 的拒绝原因
//
// 做法：静态检查 + 把补丁后的筛选逻辑抽出来跑真实数据。
//   node verify-fix2bugs.mjs ./bridge.rehearsal.js
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const target = process.argv[2] || './bridge.rehearsal.js';
const src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

// ── 抽出 saveSocialV2State 的函数体，看它到底存了哪些字段 ────────────────
const saveBody = (() => {
  const i = src.indexOf('function saveSocialV2State()');
  if (i < 0) return '';
  const end = src.indexOf('\n  }', i);
  return src.slice(i, end);
})();

section('Bug 1：印象计时字段真的进 save 了吗');
ok('saveSocialV2State 找到了', saveBody.length > 100);
ok('save 存 lastImpressionRefreshAt', /lastImpressionRefreshAt:\s*Number\(st\.lastImpressionRefreshAt\)/.test(saveBody));
ok('save 存 lastImpressionNudgeAt', /lastImpressionNudgeAt:\s*Number\(st\.lastImpressionNudgeAt\)/.test(saveBody));
ok('存的是数字而不是对象/undefined', !/lastImpressionRefreshAt:\s*st\.lastImpressionRefreshAt/.test(saveBody));

section('Bug 1：load 缺失时给 0（从未刷新），不是 Date.now()');
ok('load 的默认值改成 0',
  /lastImpressionRefreshAt:\s*Number\(val\.lastImpressionRefreshAt\) > 0 \? Number\(val\.lastImpressionRefreshAt\) : 0/.test(src));
ok('不再用 Date.now() 伪造「刚刷新过」',
  !/lastImpressionRefreshAt:\s*Number\(val\.lastImpressionRefreshAt\) > 0 \? Number\(val\.lastImpressionRefreshAt\) : Date\.now\(\)/.test(src));
ok('新建会话也用 0',
  /lastImpressionRefreshAt:\s*0,/.test(src));

section('Bug 1：7 天提醒的判定逻辑（用真实代码路径推演）');
{
  // 复刻补丁后 buildWakePromptV2 里的判定
  const impressionRefreshDays = 7;
  const judge = (lastRefreshAt, impressionCount, now) => {
    const stale = impressionCount > 0
      && (lastRefreshAt === 0 || now - lastRefreshAt > impressionRefreshDays * 86400 * 1000);
    return stale;
  };
  const now = Date.parse('2026-10-20T21:00:00Z');

  ok('有印象 + 从未刷新(0) ⇒ 该提醒', judge(0, 6, now) === true);
  ok('有印象 + 8 天前刷新 ⇒ 该提醒', judge(now - 8 * 86400000, 6, now) === true);
  ok('有印象 + 1 天前刷新 ⇒ 不提醒', judge(now - 1 * 86400000, 6, now) === false);
  ok('没印象 ⇒ 不走这个分支', judge(0, 0, now) === false);

  // 旧行为对照：load 默认 Date.now() 会让「从未刷新」变成「刚刷新」
  const oldJudge = (lastRefreshAt, count, n) => count > 0 && (lastRefreshAt === 0 || n - lastRefreshAt > 7 * 86400000);
  ok('旧行为（默认 now）确实让提醒永远不来', oldJudge(now, 6, now) === false);
}

section('Bug 2：补偿扫描的筛选逻辑');
{
  // 复刻补丁里的筛选
  const select = (entries, thresholdsC) => {
    const maxThreshold = thresholdsC.length ? Math.max(...thresholdsC) : 8;
    return entries.filter((e) => {
      if (!e || e.status !== 'candidate') return false;
      const c = Number(e.count) || 0;
      const done = Number(e.lastInferenceCount) || 0;
      if (c < 1 || done >= c) return false;
      if (c > maxThreshold) return true;
      return thresholdsC.includes(c);
    });
  };

  const T = [2, 4, 8];
  const mk = (content, count, lastInf, status = 'candidate') => ({ content, count, lastInferenceCount: lastInf, status });

  // 实线上那 7 条的真值
  const real = [
    mk('笑飞了', 2, 2),
    mk('魔了', 2, 0),      // ← 卡住的
    mk('彳亍', 2, 2),
    mk('lt', 2, 0),        // ← 卡住的
    mk('wsm', 2, 2),
    mk('dsh', 2, 2),
    mk('中转站', 2, 2)
  ];
  const picked = select(real, T).map((e) => e.content);
  ok('补上「魔了」', picked.includes('魔了'));
  ok('补上「lt」', picked.includes('lt'));
  ok('已研究过的不重复入队', !picked.includes('笑飞了') && !picked.includes('dsh'));
  ok('只补这 2 条', picked.length === 2, `实际 ${JSON.stringify(picked)}`);

  // count=1 的词默认不该被一次全塞进去
  const singles = [mk('a', 1, 0), mk('b', 1, 0), mk('c', 1, 0)];
  ok('count=1 默认不入队（除非阈值含 1）', select(singles, T).length === 0);
  ok('阈值含 1 时才入队', select(singles, [1, 2, 4, 8]).length === 3);

  // 超过最大阈值的也该补
  ok('超过最大阈值的也补', select([mk('hot', 20, 0)], T).length === 1);
  // 非 candidate 不补
  ok('已确认的不补', select([mk('ok', 2, 0, 'confirmed')], T).length === 0);
  // 研究过的（done>=count）不补
  ok('研究过的（done==count）不补', select([mk('done', 2, 2)], T).length === 0);
}

section('Bug 2：batch-confirm 对缺释义的拒绝');
{
  const i = src.indexOf("url.pathname === '/api/slang/batch-confirm'");
  const block = src.slice(i, i + 2500);
  ok('缺 meaning 时仍然拒绝（不放过无释义条目）', /if \(!entry\.meaning \|\| !String\(entry\.meaning\)\.trim\(\)\)/.test(block));
  ok('拒绝原因写明了「确认了也不会进黑话表」', /确认了也不会进黑话表/.test(block));
  ok('拒绝原因里带了可操作提示', /请先等 AI 研究出释义/.test(block));
  ok('拒绝时回传了 count（便于判断是热门词）', /count:\s*Number\(entry\.count\)/.test(block));

  // 确认「没有含义的条目确实不会进黑话表」——这是拒绝它的正当理由
  const learner = fs.readFileSync('./slang-learner.js', 'utf8');
  ok('buildSlangContext 确实要求 meaning',
    /\.filter\(\(e\) => e\.status === SLANG_STATUS\.CONFIRMED && e\.content && e\.meaning\)/.test(learner));
}

section('补偿扫描不会压垮学习会话');
{
  const i = src.indexOf('补偿扫描补入');
  const block = src.slice(i - 1800, i + 400);
  ok('一次最多补 5 条', /pending\.slice\(0, 5\)/.test(block));
  ok('已在研究中的不重复入队', /!slangResearchingIds\.has\(e\.id\)/.test(block));
  ok('受 autoResearch 开关约束', /cfg\.slang\?\.autoResearch !== false/.test(block));
  ok('只补 candidate（不碰已确认/已拒绝）', /e\.status !== SLANG_STATUS\.CANDIDATE/.test(block));
}

section('两个修复都没有引入自动写死的行为');
ok('没有给印象加自动刷新时间', !/lastImpressionRefreshAt\s*=\s*Date\.now\(\)(?![\s\S]{0,50}nudge)/.test(
  src.slice(src.indexOf('function buildWakePromptV2'), src.indexOf('function buildWakeReminderPromptV2'))
    .replace(/st\.lastImpressionNudgeAt = Date\.now\(\)/g, '')
));

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
