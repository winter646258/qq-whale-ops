// 日记配图的用例：纯函数 + diary-store 的 art 落盘读回。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ART_DEFAULTS, ART_GUARD, DEFAULT_SCENE, DIARY_ART_STYLES, DIARY_CHARACTER,
  artAllowed, artCfg, artFileName, buildArtPrompt, pickExtras, pickScene, shouldSendArt
} from '../src/diary-art.js';
import { appendDiaryEntry, countArtInDay, readDiary, setDiaryArt, writeDiary } from '../src/diary-store.js';

let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass += 1; };
const eq = (a, b, name) => { assert.equal(a, b, name); pass += 1; };

// ── 画风与人物 ──
ok(DIARY_ART_STYLES.sketchbook.includes('colored pencil'), '素描风提到彩铅');
ok(DIARY_ART_STYLES.sketchbook.includes('graphite'), '素描风提到铅笔线');
ok(ART_GUARD.includes('no text'), '收尾禁止写字');
ok(DIARY_CHARACTER.includes('whale tail'), '人物带鲸鱼尾巴');
ok(DIARY_CHARACTER.includes('blue-white gradient hair'), '人物是蓝白渐变长发');
ok(DIARY_CHARACTER.includes('maid headband'), '人物带女仆发箍');

// ── 场景选择 ──
ok(pickScene({ mood: '挺高兴' }).includes('bowl of rice'), '高兴→抱饭碗');
ok(pickScene({ text: '累到趴桌上' }).includes('notebook'), '累→趴笔记本');
ok(pickScene({ mood: '有点来气' }).includes('pouting'), '生气→鼓脸');
eq(pickScene({}), DEFAULT_SCENE, '空→默认场景');
ok(pickScene({ mood: '没见过的词' }) === DEFAULT_SCENE, '未命中→默认场景');

// ── 道具 ──
ok(pickExtras({ text: '门口的猫一直在叫' }).includes('a cat sleeping beside her'), '正文提到猫加猫');
ok(pickExtras({ text: '下雨了，猫在窗台，半夜还没睡' }).length <= 2, '道具最多两个');
eq(pickExtras({ text: '什么都没有' }).length, 0, '没命中不加道具');

// ── 提示词 ──
const p1 = buildArtPrompt({ artPrompt: '蹲在门口看猫', text: '猫', mood: '还行' });
ok(p1.startsWith('蹲在门口看猫'), '自定义画面排最前');
ok(p1.includes('whale tail'), '拼进人物');
ok(p1.includes('colored pencil'), '拼进画风');
ok(p1.endsWith(ART_GUARD), '最后是禁止写字');
const p2 = buildArtPrompt({ text: '累', mood: '累', maxChars: 200 });
ok(p2.length <= 200, '超长按上限截');
ok(p2.includes('no text'), '截断后仍保留收尾约束');
const p3 = buildArtPrompt({ artPrompt: '  多  空格   ', text: '' });
ok(!p3.startsWith('   '), '首尾空白清掉');

// ── 配置 ──
const c1 = artCfg({ socialV2: { diaryArt: { maxPerDay: 'abc', style: 'nope', size: '999x999', sendToChat: 'somewhere' } } });
eq(c1.maxPerDay, ART_DEFAULTS.maxPerDay, '脏 maxPerDay 回落');
eq(c1.style, ART_DEFAULTS.style, '未知画风回落');
eq(c1.size, ART_DEFAULTS.size, '未知尺寸回落');
eq(c1.sendToChat, ART_DEFAULTS.sendToChat, '未知发送模式回落');
eq(artCfg({ socialV2: { diaryArt: { maxPerDay: 99 } } }).maxPerDay, 10, 'maxPerDay 夹到 10');
eq(artCfg({ socialV2: { diaryArt: { enabled: false } } }).enabled, false, '可关掉');

// ── 一天几张 ──
ok(artAllowed({ entriesToday: 0, cfg: {} }) === true, '0 张时允许');
ok(artAllowed({ entriesToday: 3, cfg: {} }) === false, '到了 3 张就不画');
ok(artAllowed({ entriesToday: 0, cfg: { socialV2: { diaryArt: { enabled: false } } } }) === false, '关掉时不允许');
ok(artAllowed({ entriesToday: 0, cfg: { socialV2: { diaryArt: { maxPerDay: 0 } } } }) === false, 'maxPerDay=0 等于关');

// ── 发不发 ──
ok(shouldSendArt('private', 'private:1124721191') === true, '私聊发');
ok(shouldSendArt('private', 'group:906710082') === false, '群里默认不发');
ok(shouldSendArt('always', 'group:906710082') === true, 'always 群里也发');
ok(shouldSendArt('never', 'private:1124721191') === false, 'never 不发');

// ── 文件名 ──
eq(artFileName({ day: '2026-10-28', id: 'd1a2b' }), '2026-10/2026-10-28-d1a2b.png', '文件名=按月/日子-id');
ok(!artFileName({ day: '2026/10/28 中文', id: 'd/1' }).includes('..'), '文件名不越界');
ok(!artFileName({ day: '', id: '' }).includes('undefined'), '缺字段不写 undefined');

// ── diary-store 落盘读回 ──
const tmp = path.join(os.tmpdir(), `diary-art-test-${process.pid}.jsonl`);
try { fs.unlinkSync(tmp); } catch {}
let entries = [];
const e1 = appendDiaryEntry(entries, { text: '今天画了一张图', mood: '还行', now: 1793200000000 });
const e2 = appendDiaryEntry(entries, { text: '第二条', now: 1793200100000 });
writeDiary(tmp, entries);
eq(readDiary(tmp).length, 2, '两条都写进去了');
eq(countArtInDay(readDiary(tmp), e1.day), 0, '还没配图');

setDiaryArt(entries, { id: e1.id, art: { file: 'art/2026-10-28-d1a2b.png', prompt: 'p', style: 'sketchbook', at: 1 } });
writeDiary(tmp, entries);
const back = readDiary(tmp);
const hit = back.find((e) => e.id === e1.id);
ok(hit && hit.art && hit.art.file === 'art/2026-10-28-d1a2b.png', '配图字段落盘读回');
eq(countArtInDay(back, e1.day), 1, '数到一条配图');
eq(countArtInDay(back, ''), 1, 'day 为空时数全部');

// 空 file 的 art 当没有（不写进文件）
setDiaryArt(entries, { id: e2.id, art: { file: '', prompt: 'x' } });
writeDiary(tmp, entries);
eq(readDiary(tmp).find((e) => e.id === e2.id).art, null, '空文件名不落盘（parseLine 归一成 null）');

// 没给 id 时挂到最后一有正文的那条
setDiaryArt(entries, { art: { file: 'art/x.png', at: 2 } });
writeDiary(tmp, entries);
ok(readDiary(tmp).some((e) => e.art && e.art.file === 'art/x.png'), '没给 id 挂最后一条');

try { fs.unlinkSync(tmp); } catch {}
console.log(`diary-art: ${pass} 项全过`);