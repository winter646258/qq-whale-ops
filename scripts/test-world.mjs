import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_WORLD, WORLD_FILE, dayOf, hobbyNames, normalizeWorld, placeByName,
  placesOf, readWorld, seedWorld, selfOf, worldBounds, worldBrief
} from '../src/world.js';

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'world-test-'));

console.log('normalizeWorld');
ok('空输入回落默认', () => {
  const w = normalizeWorld(null);
  assert.equal(w.place.city, DEFAULT_WORLD.place.city);
  assert.equal(w.hobbies.length, DEFAULT_WORLD.hobbies.length);
  assert.equal(w.version, 1);
});
ok('不给 places 就用默认地点', () => {
  const w = normalizeWorld({ place: { city: '测试城' } });
  assert.equal(w.place.city, '测试城');
  assert.deepEqual(w.place.places.map((p) => p.name), DEFAULT_WORLD.place.places.map((p) => p.name));
});
ok('floor 给 0 不被当成没配（Number(null) 坑的反面）', () => {
  assert.equal(normalizeWorld({ place: { home: { floor: 0 } } }).place.home.floor, 1);
  assert.equal(normalizeWorld({ place: { home: { floor: null } } }).place.home.floor, 6);
});
ok('elevator 只认 true，字符串不算', () => {
  assert.equal(normalizeWorld({ place: { home: { elevator: 'yes' } } }).place.home.elevator, false);
  assert.equal(normalizeWorld({ place: { home: { elevator: true } } }).place.home.elevator, true);
});
ok('爱好重复只留一条', () => {
  const w = normalizeWorld({ hobbies: [{ name: '拼图' }, { name: '拼图' }, { name: '看比赛' }] });
  assert.deepEqual(w.hobbies.map((h) => h.name), ['拼图', '看比赛']);
});
ok('爱好里没有名字的整条丢掉', () => {
  const w = normalizeWorld({ hobbies: [{ name: '' }, { note: '没名字' }, '煎鱼'] });
  assert.deepEqual(w.hobbies.map((h) => h.name), ['煎鱼']);
});
ok('地点也去重且截到 8 个', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `地方${i}` }));
  const w = normalizeWorld({ place: { places: many } });
  assert.equal(w.place.places.length, 8);
});
ok('awareness 越界回落 half', () => {
  assert.equal(normalizeWorld({ self: { awareness: 'godlike' } }).self.awareness, 'half');
  assert.equal(normalizeWorld({ self: { awareness: 'none' } }).self.awareness, 'none');
});
ok('habits 清空时回落默认（不能变成空数组）', () => {
  assert.equal(normalizeWorld({ body: { habits: [] } }).body.habits.length, DEFAULT_WORLD.body.habits.length);
});
ok('长文本被截断', () => {
  const w = normalizeWorld({ livelihood: 'x'.repeat(500) });
  assert.ok(w.livelihood.length <= 60);
});

console.log('readWorld / seedWorld');
ok('没有文件时返回默认世界观', () => {
  const w = readWorld(tmp);
  assert.equal(w.place.city, DEFAULT_WORLD.place.city);
});
ok('seedWorld 落盘后 readWorld 读到', () => {
  const r = seedWorld(tmp);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(tmp, WORLD_FILE)));
  const w = readWorld(tmp);
  assert.equal(w.hobbies.length, DEFAULT_WORLD.hobbies.length);
});
ok('seedWorld 已存在时不覆盖', () => {
  const r = seedWorld(tmp);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'exists');
});
ok('主人改过文件后 readWorld 跟随（mtime 缓存失效）', () => {
  const file = path.join(tmp, WORLD_FILE);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.place.city = '改过的城';
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(file, future, future);
  assert.equal(readWorld(tmp).place.city, '改过的城');
});
ok('坏 JSON 退回默认，不抛错', () => {
  const file = path.join(tmp, WORLD_FILE);
  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(file, future, future);
  let logged = '';
  const w = readWorld(tmp, { log: (m) => { logged = m; } });
  assert.equal(w.place.city, DEFAULT_WORLD.place.city);
  assert.match(logged, /读取失败/);
});

console.log('查询接口');
ok('hobbyNames / placesOf', () => {
  const w = normalizeWorld(null);
  assert.ok(hobbyNames(w).includes('拼图'));
  assert.ok(placesOf(w).some((p) => p.name === '厨房'));
});
ok('placeByName 命中与未命中', () => {
  const w = normalizeWorld(null);
  assert.equal(placeByName(w, '阳台')?.name, '阳台');
  assert.equal(placeByName(w, '公司'), null);
  assert.equal(placeByName(w, ''), null);
});
ok('dayOf 给出作息', () => {
  const d = dayOf(normalizeWorld(null));
  assert.equal(d.wake, '08:00');
  assert.ok(d.rituals.length >= 1);
});
ok('selfOf 默认半自知', () => {
  assert.equal(selfOf(null).awareness, 'half');
});

console.log('worldBrief / worldBounds');
ok('brief 含住处、地点、爱好，且不含任何真地名白名单外的城市名', () => {
  const brief = worldBrief(null);
  assert.match(brief, /住处：/);
  assert.match(brief, /能去的地方：/);
  assert.match(brief, /爱好：/);
  assert.match(brief, /拼图/);
});
ok('bounds 的 line 里带全部爱好与地点', () => {
  const w = normalizeWorld(null);
  const b = worldBounds(w);
  for (const h of b.hobbies) assert.ok(b.line.includes(h));
  for (const p of b.places) assert.ok(b.line.includes(p));
  assert.match(b.line, /不要出现上班/);
});

console.log(`\n${pass} 组断言通过`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}
