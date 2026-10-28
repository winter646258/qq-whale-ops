// 日记两项（草稿 + 傍晚催）的用例：纯逻辑 + 接线静态检查
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DIARY_DRAFT_DEFAULTS,
  draftCfg,
  normalizeDraft,
  isDraftFresh,
  draftLine,
  eveningDue,
  localDayOf,
} from '../src/diary-daily.js';

let pass = 0;
let fail = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);
const ok = (v, msg) => assert.ok(v, msg);
const eq = (a, b, msg) => assert.deepEqual(a, b, msg);

const T = new Date('2026-10-28T23:25:00+08:00').getTime();
const at = (h, m = 0, day = 28) => new Date(`2026-10-${String(day).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).getTime();

// ---------- 配置 ----------
t('草稿默认值', () => {
  const c = draftCfg(null);
  eq(c.keepHours, 20);
  eq(c.textChars, 200);
  eq(c.eveningHour, 23);
  eq(c.eveningMinute, 20);
});

t('配置脏值回落（null 不变 0）', () => {
  const c = draftCfg({ socialV2: { diaryDaily: { draftKeepHours: null, eveningHour: '', eveningMinute: 0 } } });
  eq(c.keepHours, 20);
  eq(c.eveningHour, 23);
  eq(c.eveningMinute, 0);
});

// ---------- 归一 ----------
t('normalizeDraft 压空白并截断', () => {
  const d = normalizeDraft({ text: '  今天  修好了生图  ', mood: ' 挺高兴 ' });
  eq(d.text, '今天 修好了生图');
  eq(d.mood, '挺高兴');
});

t('normalizeDraft 空文本返回 null', () => {
  eq(normalizeDraft({ text: '   ' }), null);
  eq(normalizeDraft(null), null);
  eq(normalizeDraft('字符串'), null);
});

t('normalizeDraft 超长文本加省略号', () => {
  const d = normalizeDraft({ text: '字'.repeat(300) });
  ok(d.text.length <= 200);
  ok(d.text.endsWith('…'));
});

t('normalizeDraft 保留 day 与 at', () => {
  const d = normalizeDraft({ text: 'x', day: '2026-10-28', at: T });
  eq(d.day, '2026-10-28');
  eq(d.at, T);
});

// ---------- 新鲜度 ----------
t('当天的草稿是新鲜的', () => {
  // 只跨 10 分钟：跨过零点就换天了，草稿本来就该跟当天绑在一起。
  ok(isDraftFresh({ text: 'x', day: '2026-10-28', at: T }, { now: T + 10 * 60000 }));
});

t('昨天的草稿不算新鲜', () => {
  eq(isDraftFresh({ text: 'x', day: '2026-10-27', at: T - 86400000 }, { now: T }), false);
});

t('超过 keepHours 不算新鲜', () => {
  eq(isDraftFresh({ text: 'x', day: '2026-10-28', at: T - 21 * 3600000 }, { now: T }), false);
});

t('没正文不算新鲜', () => {
  eq(isDraftFresh({ text: '', at: T }, { now: T }), false);
  eq(isDraftFresh(null, { now: T }), false);
});

// ---------- 注入文本 ----------
t('草稿注入带括号心情与落笔提示', () => {
  const line = draftLine({ text: '海边那张图终于出图了', mood: '松了口气', day: '2026-10-28', at: T }, { now: T });
  ok(line.includes('【今天的日记草稿（松了口气）】'));
  ok(line.includes('海边那张图终于出图了'));
  ok(line.includes('qq_diary'));
  ok(line.includes('不用照抄'));
});

t('过期草稿不注入', () => {
  eq(draftLine({ text: 'x', day: '2026-10-27', at: T - 86400000 }, { now: T }), '');
});

t('没心情词就不带括号', () => {
  const line = draftLine({ text: 'x', day: '2026-10-28', at: T }, { now: T });
  ok(line.includes('【今天的日记草稿】'));
});

// ---------- 傍晚窗口 ----------
t('23:25 在窗口内', () => { ok(eveningDue(at(23, 25))); });
t('23:19 还没到', () => { eq(eveningDue(at(23, 19)), false); });
t('23:55 出窗口（30 分钟窗）', () => { eq(eveningDue(at(23, 55)), false); });
t('22:30 太早', () => { eq(eveningDue(at(22, 30)), false); });
t('窗口可调', () => {
  const c = { ...draftCfg(null), eveningHour: 22, eveningMinute: 0, eveningWindowMin: 60 };
  ok(eveningDue(at(22, 30), c));
  eq(eveningDue(at(23, 30), c), false);
});

// ---------- 接线静态检查 ----------
const bridge = fs.readFileSync(path.join(process.cwd(), 'src/bridge.js'), 'utf8');
const settle = fs.readFileSync(path.join(process.cwd(), 'src/settle.js'), 'utf8');
t('bridge 导入草稿与傍晚函数', () => {
  ok(bridge.includes('normalizeDraft as normalizeDiaryDraft'));
  ok(bridge.includes('eveningDue'));
  ok(bridge.includes('draftCfg'));
});
t('bridge 有草稿写入与注入', () => {
  ok(bridge.includes('MARKER: diary-draft-write'));
  ok(bridge.includes('diaryDailyLine + diaryDraftHint'));
  ok(bridge.includes('buildDiaryDraftLineFor'));
});
t('bridge 起了傍晚定时器', () => {
  ok(bridge.includes('傍晚催写定时器已排上'));
  ok(bridge.includes('diaryEveningTick'));
});
t('傍晚只催私聊、只催今天说过话的', () => {
  ok(bridge.includes("if (!String(key).startsWith('private:')) continue;"));
  ok(bridge.includes('talkedToday'));
});
t('settle 要草稿并解析', () => {
  ok(settle.includes('日记草稿（diary）'));
  ok(settle.includes('resolvedThreads, dates, diary'));
  ok(settle.includes('"diary":{"text":"…","mood":"…"}'));
});

for (const [name, fn] of cases) {
  try { fn(); pass += 1; } catch (error) { fail += 1; console.log(`✗ ${name}\n   ${error.message}`); }
}
console.log(`日记草稿：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
