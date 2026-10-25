// 日记分档 + 遗忘曲线 的离线断言。
// 纯逻辑，不碰网络、不碰真实日记文件。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LEVELS, DEFAULT_LEVEL, LEVEL_HALF_LIFE_DAYS, FADE_THRESHOLD,
  normalizeLevel, diaryWeight, isFaded, recallDiary, daysSinceLast,
  appendDiaryEntry, updateDiaryEntry, writeDiary, readDiary, diaryStats
} from '../src/diary-store.js';

const DAY = 86400000;
let n = 0;
const ok = (name) => { n += 1; console.log('  ok', n, name); };

// ---- 1. 档位归一 ----
assert.equal(normalizeLevel(undefined), 'normal');
assert.equal(normalizeLevel(''), 'normal');
assert.equal(normalizeLevel('critical'), 'critical');
assert.equal(normalizeLevel('重要'), 'important');
assert.equal(normalizeLevel('非常重要'), 'critical');
assert.equal(normalizeLevel('关键'), 'critical');
assert.equal(normalizeLevel('随便乱写'), DEFAULT_LEVEL);   // 非法值不报错
assert.equal(normalizeLevel(3), 'critical');               // 数字也认
ok('normalizeLevel 容错');

// ---- 2. 权重：半衰期对得上图上的原话 ----
const now = Date.UTC(2026, 9, 24, 12, 0, 0);
const mk = (level, ageDays) => ({ id: 'x', t: now - ageDays * DAY, level, text: 't' });

assert.equal(diaryWeight(mk('critical', 3650), now), 1, 'critical 十年也不淡');
ok('critical 权重恒 1');

// important 半衰期 21 天
assert.ok(Math.abs(diaryWeight(mk('important', 21), now) - 0.5) < 1e-9, 'important 21 天减半');
assert.ok(diaryWeight(mk('important', 21), now) > FADE_THRESHOLD, 'important 三周还浮得出来');
ok('important 21 天减半且未淡');

// normal 半衰期 5 天
assert.ok(Math.abs(diaryWeight(mk('normal', 5), now) - 0.5) < 1e-9, 'normal 5 天减半');
assert.equal(isFaded(mk('normal', 5), now), false, '第 5 天还没淡');
assert.equal(isFaded(mk('normal', 14), now), true, '两周后已淡');
ok('normal 5 天减半、两周淡掉');

// 无时间戳的旧数据给中间值
assert.equal(diaryWeight({ level: 'normal', t: 0, text: 'x' }, now), 0.5);
ok('旧数据无时间戳给中间值');

// ---- 3. recallDiary：两个视图的分工 ----
const entries = [
  mk('critical', 100),    // 很久以前，但不想忘
  mk('important', 25),    // 一个月前，还够分量
  mk('normal', 30),       // 一个月前的普通事 —— 该淡了
  mk('normal', 1), mk('normal', 2), mk('normal', 3)  // 最近三条
].map((e, i) => ({ ...e, id: 'id' + i, time: '', day: '', mood: '' }));

const rec = recallDiary(entries, { now, recent: 3, faded: 4 });
assert.equal(rec.recent.length, 3, '最近 3 条');
assert.deepEqual(rec.recent.map((e) => e.id), ['id3', 'id4', 'id5']);
const fadedIds = rec.faded.map((e) => e.id);
assert.ok(fadedIds.includes('id0'), 'critical 的旧条目必须出现');
assert.ok(fadedIds.includes('id1'), 'important 的旧条目还在');
assert.ok(!fadedIds.includes('id2'), '一个月前的普通条目已经淡掉，不再浮出');
assert.equal(rec.faded[0].id, 'id0', 'critical 排第一');
ok('recallDiary 分档 + 淡化');

// faded=0 时只给最近
const rec0 = recallDiary(entries, { now, recent: 3, faded: 0 });
assert.equal(rec0.faded.length, 0);
ok('faded=0 关闭回想');

// ---- 4. 写入/读回往返：level 只落非默认档 ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-'));
const file = path.join(dir, '日记.jsonl');
const list = [];
const e1 = appendDiaryEntry(list, { text: '普通的一条', now });
const e2 = appendDiaryEntry(list, { text: '不想忘的一条', level: 'critical', mood: '有点暖', now: now + 1 });
const e3 = appendDiaryEntry(list, { text: '重要的一条', level: '重要', now: now + 2 });
assert.equal(e1.level, 'normal');
assert.equal(e2.level, 'critical');
assert.equal(e3.level, 'important');
writeDiary(file, list);

const raw = fs.readFileSync(file, 'utf8');
const lines = raw.trim().split('\n');
assert.equal(lines.length, 3);
assert.ok(!JSON.parse(lines[0]).level, 'normal 不落 level 字段');
assert.equal(JSON.parse(lines[1]).level, 'critical');
assert.equal(JSON.parse(lines[2]).level, 'important');

const back = readDiary(file);
assert.equal(back.length, 3);
assert.deepEqual(back.map((e) => e.level), ['normal', 'critical', 'important']);
assert.equal(back[1].mood, '有点暖');
ok('写入/读回往返，level 与 mood 都对');

// ---- 5. 改档 ----
const r = updateDiaryEntry(back, { id: e1.id, level: 'critical', now: now + 10 });
assert.equal(r.changed, true);
assert.equal(r.entry.level, 'critical');
ok('可把旧条目提档');

const r2 = updateDiaryEntry(back, { id: e2.id, level: 'normal', now: now + 11 });
assert.equal(r2.entry.level, 'normal', '也可以降档');
ok('可降档');

// ---- 6. daysSinceLast ----
assert.equal(daysSinceLast([], now), null);
assert.equal(daysSinceLast([{ t: now - 3 * DAY }], now), 3);
ok('daysSinceLast');

// ---- 7. stats 分档 ----
const st = diaryStats(back, now);
assert.equal(st.count, 3);
// e1 提成 critical、e2 降成 normal，所以三档各一条
assert.equal(st.byLevel.critical, 1);
assert.equal(st.byLevel.important, 1);
assert.equal(st.byLevel.normal, 1);
ok('diaryStats 可算出 byLevel');
console.log('  byLevel =', JSON.stringify(st.byLevel), 'faded =', st.fadedCount, 'gap =', st.daysSinceLast);

fs.rmSync(dir, { recursive: true, force: true });
console.log('\nALL PASS (' + n + ' groups)');