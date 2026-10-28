import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const m = await import(path.join(here, '../src/session-rotate.js'));
const { ROTATE_DEFAULTS, rotateCfg, localDayOf, rotateWindow, kindOfKey, shouldRotate, rotateLine, pruneRotateDays } = m;

let n = 0;
function ok(name, fn) { fn(); n += 1; console.log(`  ok ${n} - ${name}`); }

const at = (h, min) => new Date(2026, 9, 29, h, min, 0, 0).getTime(); // 10-29 本地

ok('默认是开的', () => assert.equal(rotateCfg({}).enabled, true));
ok('脏配置回落默认', () => {
  const c = rotateCfg({ socialV2: { sessionRotate: { hour: null, minute: '', windowMinutes: 0, minIdleMinutes: undefined } } });
  assert.equal(c.hour, ROTATE_DEFAULTS.hour);
  assert.equal(c.minute, ROTATE_DEFAULTS.minute);
  assert.equal(c.windowMinutes, 1); // 夹到下限
  assert.equal(c.minIdleMinutes, ROTATE_DEFAULTS.minIdleMinutes);
});
ok('小时越界会被夹', () => {
  assert.equal(rotateCfg({ socialV2: { sessionRotate: { hour: 99 } } }).hour, 23);
  assert.equal(rotateCfg({ socialV2: { sessionRotate: { hour: -5 } } }).hour, 0);
});
ok('可以显式关掉', () => assert.equal(rotateCfg({ socialV2: { sessionRotate: { enabled: false } } }).enabled, false));
ok('kinds 只认 private/group', () => {
  const c = rotateCfg({ socialV2: { sessionRotate: { kinds: ['private', 'weird', 'group'] } } });
  assert.deepEqual(c.kinds, ['private', 'group']);
});
ok('kinds 给空数组回落默认', () => {
  assert.deepEqual(rotateCfg({ socialV2: { sessionRotate: { kinds: [] } } }).kinds, ROTATE_DEFAULTS.kinds);
});

ok('localDayOf 用本地日期', () => assert.equal(localDayOf(at(4, 10)), '2026-10-29'));
ok('kindOfKey', () => {
  assert.equal(kindOfKey('private:1'), 'private');
  assert.equal(kindOfKey('group:2'), 'group');
  assert.equal(kindOfKey('other:3'), 'other');
});

ok('窗口内 due', () => assert.equal(rotateWindow(at(4, 30), rotateCfg({})).due, true));
ok('窗口前不 due', () => assert.equal(rotateWindow(at(3, 59), rotateCfg({})).due, false));
ok('窗口后不 due', () => assert.equal(rotateWindow(at(6, 30), rotateCfg({})).due, false));
ok('窗口边界：起点算、终点算', () => {
  const c = rotateCfg({});
  assert.equal(rotateWindow(at(4, 10), c).due, true);
  assert.equal(rotateWindow(at(5, 40), c).due, true);
  assert.equal(rotateWindow(at(5, 41), c).due, false);
});

ok('该换：窗口内 + 闲置 + 今天没换过', () => {
  const v = shouldRotate('private:1', { now: at(4, 30), cfg: rotateCfg({}), lastDay: null, busy: false, lastActivityAt: at(2, 0) });
  assert.deepEqual(v, { rotate: true, why: 'ok' });
});
ok('关掉就不换', () => {
  const v = shouldRotate('private:1', { now: at(4, 30), cfg: rotateCfg({ socialV2: { sessionRotate: { enabled: false } } }), lastDay: null, busy: false, lastActivityAt: 0 });
  assert.equal(v.why, 'disabled');
});
ok('今天换过就不再换', () => {
  const v = shouldRotate('private:1', { now: at(4, 30), cfg: rotateCfg({}), lastDay: '2026-10-29', busy: false, lastActivityAt: 0 });
  assert.equal(v.why, 'already');
});
ok('窗口外不换（错过就当天不换，绝不在聊天中换）', () => {
  const v = shouldRotate('private:1', { now: at(9, 0), cfg: rotateCfg({}), lastDay: null, busy: false, lastActivityAt: 0 });
  assert.equal(v.why, 'outside-window');
});
ok('正在跑回合不换', () => {
  const v = shouldRotate('group:2', { now: at(4, 30), cfg: rotateCfg({}), lastDay: null, busy: true, lastActivityAt: 0 });
  assert.equal(v.why, 'busy');
});
ok('刚说过话不换', () => {
  const v = shouldRotate('group:2', { now: at(4, 30), cfg: rotateCfg({}), lastDay: null, busy: false, lastActivityAt: at(4, 25) });
  assert.equal(v.why, 'recent-activity');
});
ok('闲置刚好超过阈值就换', () => {
  const v = shouldRotate('group:2', { now: at(4, 30), cfg: rotateCfg({}), lastDay: null, busy: false, lastActivityAt: at(4, 19) });
  assert.equal(v.rotate, true);
});
ok('kind 不在名单里不换', () => {
  const v = shouldRotate('group:2', { now: at(4, 30), cfg: rotateCfg({ socialV2: { sessionRotate: { kinds: ['private'] } } }), lastDay: null, busy: false, lastActivityAt: 0 });
  assert.equal(v.why, 'kind');
});
ok('不认识的 key 不换', () => {
  const v = shouldRotate('weird:1', { now: at(4, 30), cfg: rotateCfg({}), lastDay: null, busy: false, lastActivityAt: 0 });
  assert.equal(v.why, 'kind');
});
ok('没有活动记录也照换（新会话不该被永久跳过）', () => {
  const v = shouldRotate('private:1', { now: at(4, 30), cfg: rotateCfg({}), lastDay: null, busy: false, lastActivityAt: 0 });
  assert.equal(v.rotate, true);
});

ok('日志一行说清「归档不是删除」', () => {
  const line = rotateLine('group:2', 'session-9aa461e8-9c8b');
  assert.ok(line.includes('group:2'));
  assert.ok(line.includes('已归档'));
  assert.ok(line.includes('记忆'));
});
ok('没有旧会话时日志不炸', () => assert.ok(rotateLine('private:1', '').includes('无')));

ok('记账只留最近 7 天', () => {
  const days = {};
  for (let i = 1; i <= 12; i += 1) days[`2026-10-${String(i).padStart(2, '0')}`] = { keys: ['a'], at: i };
  const out = pruneRotateDays(days, '2026-10-29', 7);
  assert.equal(Object.keys(out).length, 8); // 7 天 + 今天占位
  assert.ok(out['2026-10-29']);
  assert.ok(!out['2026-10-01']);
});

// 接线静态检查
const bridgeSrc = fs.readFileSync(path.join(here, '../src/bridge.js'), 'utf8');
ok('bridge 引了 session-rotate', () => assert.ok(bridgeSrc.includes("from './session-rotate.js'")));
ok('有 tick 与状态文件', () => {
  assert.ok(bridgeSrc.includes('MARKER: session-rotate-runtime'));
  assert.ok(bridgeSrc.includes("path.join(STATE_DIR, 'session-rotate.json')"));
  assert.ok(bridgeSrc.includes('async function sessionRotateTick()'));
});
ok('换会话时清了角色卡指纹（否则新会话没角色卡）', () => {
  const i = bridgeSrc.indexOf('async function rotateOneSession(key)');
  const seg = bridgeSrc.slice(i, i + 1400);
  assert.ok(seg.includes('roleCardInjectSeen.delete(key)'));
  assert.ok(seg.includes('archiveSession'));
});
ok('换会话不动社交状态（不删 recentMessages）', () => {
  const i = bridgeSrc.indexOf('async function rotateOneSession(key)');
  const seg = bridgeSrc.slice(i, i + 1400);
  assert.ok(!seg.includes('social.recentMessages.delete'));
  assert.ok(!seg.includes('socialV2.conversations.delete'));
});
ok('定时器挂在 boot 里且 unref', () => {
  assert.ok(bridgeSrc.includes('MARKER: session-rotate-boot'));
  const i = bridgeSrc.indexOf('MARKER: session-rotate-boot');
  const seg = bridgeSrc.slice(i, i + 900);
  assert.ok(seg.includes('setInterval'));
  assert.ok(seg.includes('unref'));
});

console.log(`\n会话换新：${n} 项全过`);
