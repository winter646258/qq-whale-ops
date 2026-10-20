// 画像模块单测。用法：node portrait-store.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FACETS, normalizeFacet, loadPortrait, savePortrait, addPortrait, updatePortrait,
  removePortrait, listSubjects, queryPortrait, formatPortraitForPrompt, revealOriginal,
  INJECT_FACETS_PER_SUBJECT, INJECT_MAX_SUBJECTS
} from './portrait-store.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✖ ${label}${extra ? ' — ' + extra : ''}`); }
};
const eq = (label, a, b) => ok(label, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const throws = (label, fn) => {
  try { fn(); ok(label, false, '本应抛错'); } catch { ok(label, true); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

section('面（facet）归一化');
eq('三个面固定', FACETS.join('/'), 'doing/view/bond');
eq('doing', normalizeFacet('doing'), 'doing');
eq('近况 → doing', normalizeFacet('近况'), 'doing');
eq('在做什么 → doing', normalizeFacet('在做什么'), 'doing');
eq('怎么看 → view', normalizeFacet('怎么看'), 'view');
eq('关系 → bond', normalizeFacet('关系'), 'bond');
eq('处得怎么样 → bond', normalizeFacet('处得怎么样'), 'bond');
eq('空 → view', normalizeFacet(''), 'view');
eq('认不出的 → null', normalizeFacet('zzz'), null);

section('记一条');
{
  const store = loadPortrait(path.join(os.tmpdir(), 'no-such-portrait.json'));
  eq('不存在 → 空库', Object.keys(store.subjects).length, 0);

  const it = addPortrait(store, { subject: '主人', facet: 'doing', text: '最近在折腾 QQ 机器人', weight: 3, now: 1792420000000 });
  eq('面', it.facet, 'doing');
  eq('权重', it.weight, 3);
  eq('未改观', it.blurred, false);
  eq('无旧判断', it.originalText, null);
  ok('id 形如 p+5位', /^p[0-9a-f]{5}$/.test(it.id), it.id);
  eq('落到 subjects 下', store.subjects['主人'].length, 1);

  throws('subject 空要报错', () => addPortrait(store, { subject: '  ', facet: 'view', text: 'x' }));
  throws('text 空要报错', () => addPortrait(store, { subject: 'a', facet: 'view', text: '  ' }));
  throws('非法 facet 要报错', () => addPortrait(store, { subject: 'a', facet: 'zzz', text: 'x' }));
  throws('原型污染名要拒绝', () => addPortrait(store, { subject: '__proto__', facet: 'view', text: 'x' }));

  const w = addPortrait(store, { subject: '主人', facet: 'view', text: '嘴上凶其实挺照顾人', weight: 99 });
  eq('权重封顶 9', w.weight, 9);
  const w0 = addPortrait(store, { subject: '主人', facet: 'view', text: '另一条', weight: 0 });
  eq('权重下限 1', w0.weight, 1);
}

section('改观是改写，不是删除');
{
  const store = { version: 1, subjects: {} };
  const it = addPortrait(store, { subject: '主人', facet: 'view', text: '觉得他是个话不多的人' });

  const r1 = updatePortrait(store, it.id, { text: '其实他话挺多的' }, 1000);
  ok('改到了', r1 && r1.changed === true);
  eq('新判断', it.text, '其实他话挺多的');
  eq('旧判断留底', it.originalText, '觉得他是个话不多的人');
  eq('标记已改观', it.blurred, true);
  eq('记了更新时间', it.updatedAt, 1000);

  updatePortrait(store, it.id, { text: '他话真的很多' }, 2000);
  eq('旧底仍是最初那份', it.originalText, '觉得他是个话不多的人');
  eq('当前是最新', it.text, '他话真的很多');

  const r3 = updatePortrait(store, it.id, { text: '他话真的很多' });
  ok('同文不算变更', r3.changed === false);

  updatePortrait(store, it.id, { weight: 7 });
  eq('权重改了', it.weight, 7);
  eq('权重与原文无关', it.originalText, '觉得他是个话不多的人');

  updatePortrait(store, it.id, { facet: 'bond' });
  eq('面可改', it.facet, 'bond');

  throws('非法 facet 要报错', () => updatePortrait(store, it.id, { facet: 'zzz' }));
  eq('改不存在的 → null', updatePortrait(store, 'p99999', { text: 'x' }), null);

  const rev = revealOriginal(store, it.id);
  eq('管理员翻得到原文', rev.originalText, '觉得他是个话不多的人');
  eq('角色看到的是新的', rev.text, '他话真的很多');
}

section('换人 + 删');
{
  const store = { version: 1, subjects: {} };
  const it = addPortrait(store, { subject: '旧名', facet: 'view', text: '某条' });
  updatePortrait(store, it.id, { subject: '新名' });
  eq('旧名下没了', store.subjects['旧名'], undefined);
  eq('新名下有了', store.subjects['新名'].length, 1);
  eq('对象没变', store.subjects['新名'][0].id, it.id);

  eq('删掉', removePortrait(store, it.id), true);
  eq('删完 subjects 也清了', Object.keys(store.subjects).length, 0);
  eq('删不存在 → false', removePortrait(store, 'p99999'), false);
}

section('配额');
{
  const store = { version: 1, subjects: {} };
  for (let i = 0; i < 12; i += 1) addPortrait(store, { subject: '话痨', facet: 'doing', text: `第${i}条` });
  throws('单人到 12 条上限要拦', () => addPortrait(store, { subject: '话痨', facet: 'doing', text: '第13条' }));
}

section('查询');
{
  const store = { version: 1, subjects: {} };
  addPortrait(store, { subject: '主人', facet: 'doing', text: '在折腾机器人', weight: 5 });
  addPortrait(store, { subject: '主人', facet: 'view', text: '嘴硬心软', weight: 8 });
  addPortrait(store, { subject: '老猫', facet: 'bond', text: '老爱怼我', weight: 2 });

  const all = queryPortrait(store, {});
  eq('总人数', all.totalSubjects, 2);
  eq('总条数', all.totalItems, 3);
  eq('按权重排第一是主人', all.subjects[0].subject, '主人');
  eq('人内也按权重排', all.subjects[0].items[0].text, '嘴硬心软');

  const one = queryPortrait(store, { subject: '主人' });
  eq('只看一个人', one.totalItems, 2);

  const viewOnly = queryPortrait(store, { facet: 'view' });
  eq('只看一个面', viewOnly.totalItems, 1);
  eq('面过滤命中', viewOnly.subjects[0].items[0].text, '嘴硬心软');

  throws('非法 facet 查询要报错', () => queryPortrait(store, { facet: 'zzz' }));
  eq('查不存在的人 → 空', queryPortrait(store, { subject: '查无此人' }).totalSubjects, 0);
}

section('注入要分层');
{
  const store = { version: 1, subjects: {} };
  // 造 7 个人，验证只注入前 5 个
  for (let i = 0; i < 7; i += 1) {
    for (let j = 0; j < 5; j += 1) {
      addPortrait(store, { subject: `人${i}`, facet: 'view', text: `人${i}的第${j}条`, weight: 9 - i });
    }
  }
  const text = formatPortraitForPrompt(store);
  console.log('---- 注入样例 ----');
  console.log(text);
  console.log('-------------------');

  ok('带标题', text.includes('【你对他们这些人的长期认识】'));
  const detailLines = text.split('\n').filter((l) => l.startsWith('- '));
  eq(`最多注入 ${INJECT_MAX_SUBJECTS} 个人`, detailLines.length, INJECT_MAX_SUBJECTS);
  ok(`每人最多 ${INJECT_FACETS_PER_SUBJECT} 条明细`, detailLines[0].includes('（还有 2 条）'), detailLines[0]);
  ok('剩下的人只报数量', text.includes('另外还记着 2 个人'));
  ok('没有把 35 条全塞进去', text.split('；').length <= 20);

  const empty = formatPortraitForPrompt({ subjects: {} });
  eq('空画像返回空串（不占上下文）', empty, '');
}

section('落盘');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portrait-test-'));
  const file = path.join(dir, 'portrait.json');
  const store = { version: 1, subjects: {} };
  const it = addPortrait(store, { subject: '主人', facet: 'doing', text: '写代码' });
  updatePortrait(store, it.id, { text: '一直在写代码' });
  savePortrait(file, store);

  const back = loadPortrait(file);
  eq('读回条数', back.subjects['主人'].length, 1);
  eq('旧判断保留', back.subjects['主人'][0].originalText, '写代码');
  eq('改观标记保留', back.subjects['主人'][0].blurred, true);

  if (process.platform !== 'win32') {
    eq('权限 600', (fs.statSync(file).mode & 0o777).toString(8), '600');
  } else {
    ok('Windows 跳过权限位断言', true);
  }

  fs.writeFileSync(file, 'not json', 'utf8');
  throws('损坏要抛错', () => loadPortrait(file));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
