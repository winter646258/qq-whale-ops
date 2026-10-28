// 日记本：按月分组、取页、配图路径安全解析、概览。
import assert from 'node:assert/strict';
import path from 'node:path';
import { artUrlFor, bookItems, bookMonths, bookSummary, monthOf, resolveArtFile } from '../src/diary-book.js';

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass += 1; };
const eq = (a, b, n) => { assert.equal(a, b, n); pass += 1; };

// ── 月份 ──
eq(monthOf('2026-10-28'), '2026-10', '取年月');
eq(monthOf('2026-1'), '', '格式不全→空');
eq(monthOf(''), '', '空→空');
eq(monthOf(null), '', 'null→空');

// ── 月清单（新的在前）──
const entries = [
  { id: 'a', t: 1000, day: '2026-09-30', time: '2026-09-30 22:00', text: '九月最后一天', mood: '还行' },
  { id: 'b', t: 2000, day: '2026-10-01', time: '2026-10-01 09:00', text: '十月第一天', art: { file: '2026-10/2026-10-01-b.png', style: 'sketchbook' } },
  { id: 'c', t: 3000, day: '2026-10-28', time: '2026-10-28 20:00', text: '今天', mood: '挺高兴', level: 'important' }
];
eq(JSON.stringify(bookMonths(entries)), JSON.stringify([{ month: '2026-10', count: 2 }, { month: '2026-09', count: 1 }]), '月清单新的在前');

// ── 取页：新的在前、按月筛、限量 ──
const all = bookItems(entries, { limit: 10 });
eq(all.length, 3, '全都取到');
eq(all[0].id, 'c', '新的在前');
const oct = bookItems(entries, { month: '2026-10', limit: 10 });
eq(oct.length, 2, '按月筛');
eq(oct[0].art, null, '没配图 art 为 null');
const withArt = bookItems(entries, { month: '2026-10', limit: 10 }).find((x) => x.id === 'b');
ok(withArt.art && withArt.art.exists === true, '有配图默认认为存在');
ok(withArt.art.url.startsWith('/api/socialV2/diary/art/2026-10/'), '配图地址按月');
eq(bookItems(entries, { limit: 1 }).length, 1, '限量生效');
eq(bookItems(entries, { limit: 0 }).length, 3, 'limit 0 视为没传（走默认 200）');
eq(bookItems(entries, { limit: 99999 }).length, 3, '超上限就全给');
eq(bookItems(entries, { limit: 10, artExists: () => false })[1].art.exists, false, 'artExists 说了算');
eq(bookItems(entries, { limit: 10, artExists: () => false })[1].art.url, '', '文件不在就不给地址');
eq(bookItems([{ day: '2026-10-01', text: '' }], { limit: 10 }).length, 0, '没正文的跳过');

// ── 地址编码 ──
eq(artUrlFor('2026-10/2026-10-01 b.png'), '/api/socialV2/diary/art/2026-10/2026-10-01%20b.png', '空格要编码');
eq(artUrlFor('../etc/passwd'), '', '带 .. 不给地址');
eq(artUrlFor(''), '', '空不给地址');

// ── 路径安全 ──
const root = '/opt/qq-bridge/diary/art';
ok(resolveArtFile(root, '2026-10/2026-10-01-b.png') === path.resolve(root, '2026-10/2026-10-01-b.png'), '正常路径解析');
eq(resolveArtFile(root, '../secret.png'), null, '不许往上跳');
eq(resolveArtFile(root, '2026-10/../../x.png'), null, '中段跳也不许');
eq(resolveArtFile(root, '/etc/passwd.png'), null, '绝对路径不许');
eq(resolveArtFile(root, '2026-10/x.txt'), null, '只要 png');
eq(resolveArtFile(root, ''), null, '空名不许');
eq(resolveArtFile('', 'a.png'), null, '没有根目录不许');
ok(resolveArtFile(root, 'a\u0000b.png') === null, 'NUL 不许');

// ── 概览 ──
const sum = bookSummary(entries);
eq(sum.total, 3, '总条数');
eq(sum.withArt, 1, '有配图条数');
eq(sum.days, 3, '覆盖天数');
eq(sum.firstDay, '2026-09-30', '最早一天');
eq(sum.lastDay, '2026-10-28', '最晚一天');
ok(sum.moods.includes('挺高兴'), '心情清单');
eq(bookSummary([]).total, 0, '空本当 0');

console.log(`diary-book: ${pass} 项全过`);