// 住处块（homeBrief）回归。
// 两件事必须钉死：① 字数在 300~400 之间（放长了她不会背、只会占上下文）
// ② 群聊一个字都不进 —— 这道闸以前能被 config 里的 scope:'all' 绕过去。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = '/opt/qq-bridge/src';
const { homeBrief, readWorld, DEFAULT_WORLD, seedWorld, placesOf, worldBrief } = await import(`${SRC}/world.js`);

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass += 1; console.log('  ✓', name); } catch (e) { fail += 1; console.log('  ✗', name, '|', e.message); } };

console.log('\n=== 1. 真 world.json 下的形态');
const real = readWorld('/opt/qq-bridge/state', {});
const text = homeBrief(real);
console.log(text);
console.log('长度:', text.length);

ok('长度 300~400', () => { assert.ok(text.length >= 300 && text.length <= 400, `实际 ${text.length}`); });
ok('以【你的住处】开头', () => assert.ok(text.startsWith('【你的住处】')));
ok('含城市与近处尺度', () => { assert.ok(text.includes('南方靠海的小城')); assert.ok(text.includes('骑电动车')); });
ok('含楼层 / 无电梯 / 朝向', () => { assert.ok(text.includes('5 楼')); assert.ok(text.includes('没有电梯')); assert.ok(text.includes('朝东南')); });
ok('含户型与家具（家这个概念本身）', () => { assert.ok(text.includes('一室一厅')); assert.ok(text.includes('大桌横在窗下')); assert.ok(text.includes('床在里间')); });
ok('含窗外', () => assert.ok(text.includes('窗外：') && text.includes('直通堤坝')));
ok('含纪念物', () => assert.ok(text.includes('坐塌') && text.includes('旧木椅')));
ok('含全部 9 个地点', () => {
  for (const p of placesOf(real)) assert.ok(text.includes(p.name), `缺地点 ${p.name}`);
});

console.log('\n=== 2. 不该出现的东西');
ok('不含季节/温度（交给生活线，避免两处打架）', () => {
  assert.ok(!/十八九度|夜里有潮气|秋末/.test(text), '混进了 place.season');
});
ok('不含身体（角色卡已有）', () => assert.ok(!/尾巴|怕静电/.test(text)));
ok('不含爱好清单（角色卡已有）', () => assert.ok(!/爱好：/.test(text)));
ok('不含营生', () => assert.ok(!/营生：/.test(text)));
ok('不含 regiem 段数（对模型无意义）', () => assert.ok(!/\d+\s*段/.test(text), '混进了段数'));
ok('不含「世界会冒事的方向」', () => assert.ok(!/世界会冒事/.test(text)));
ok('不含系统词', () => assert.ok(!/world\.json|注入|系统|字段/.test(text)));
ok('尾部有「不用整段念」这类抑制播报的收束', () => assert.ok(text.includes('不用整段念')));

console.log('\n=== 3. 与 worldBrief 的分工（不是替代品）');
const brief = worldBrief(real);
ok('worldBrief 仍然更全（>700 字）', () => assert.ok(brief.length > 700, `实际 ${brief.length}`));
ok('homeBrief 明显更短', () => assert.ok(text.length < brief.length * 0.5));
ok('两者都提到住处', () => { assert.ok(brief.includes('一室一厅')); assert.ok(text.includes('一室一厅')); });

console.log('\n=== 4. 兜底与鲁棒');
ok('空参数回落默认世界且不抛错', () => {
  const t = homeBrief(null);
  assert.ok(typeof t === 'string' && t.length > 100, `实际 ${t.length}`);
});
ok('坏数据不抛错', () => {
  for (const bad of [{}, { place: null }, { place: { home: null } }, { place: { places: 'x' } }]) {
    const t = homeBrief(bad);
    assert.equal(typeof t, 'string');
  }
});
ok('自定义世界的改动会反映出来', () => {
  const custom = JSON.parse(JSON.stringify(DEFAULT_WORLD));
  custom.place.home.rooms = '两室一厅，阳台朝南';
  const t = homeBrief(custom);
  assert.ok(t.includes('两室一厅'), '改了 world 但住处块没跟上');
});

console.log('\n=== 5. 群聊硬边界（源码层断言，不起服务）');
const bridgeSrc = fs.readFileSync(`${SRC}/bridge.js`, 'utf8');
ok('inWorldScope 里有群聊早返回', () => {
  const i = bridgeSrc.indexOf('function inWorldScope(key) {');
  assert.ok(i > 0, '找不到 inWorldScope');
  const body = bridgeSrc.slice(i, i + 700);
  assert.ok(body.includes("startsWith('group:')"), '群聊判定缺失');
  assert.ok(body.indexOf("startsWith('group:')") < body.indexOf("worldScopeMode() === 'all'"), '群聊判定必须在 scope 分支之前');
  assert.ok(body.includes("return false"), '群聊分支没有 return false');
});
ok('base 拼接里住处块紧跟 roleLine', () => {
  assert.ok(/const base = roleLine \+ worldHomeLine \+ untrustedLine \+/.test(bridgeSrc));
});
ok('会话换新时两处指纹一起清', () => {
  const i = bridgeSrc.indexOf('roleCardInjectSeen.delete(key);');
  const seg = bridgeSrc.slice(i, i + 200);
  assert.ok(seg.includes('worldHomeSeen.delete(key);'));
});
ok('worldHomeLine 默认空串（注入失败不影响提示词）', () => {
  assert.ok(bridgeSrc.includes("let worldHomeLine = '';"));
});
ok('注入包在 try 里，且失败只记日志', () => {
  // 注意：'MARKER: world-home' 有两处（Map 声明处 + 注入块）。要定位的是注入块，
  // 它的特征行是 let worldHomeLine —— 从那里往后切。
  const i = bridgeSrc.indexOf("let worldHomeLine = '';");
  assert.ok(i > 0, '找不到 worldHomeLine 声明');
  const seg = bridgeSrc.slice(i, i + 1400);
  assert.ok(seg.includes('try {'), '注入没包在 try 里');
  assert.ok(seg.includes('catch (error)'), '没有 catch');
  assert.ok(seg.includes('[world-home] 注入失败'), '失败没记日志');
  // 失败时 worldHomeLine 必须保持空串，不能把半截塞进提示词
  assert.ok(!/catch \(error\) \{[\s\S]{0,200}worldHomeLine = /.test(seg), 'catch 里改了 worldHomeLine');
});

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
