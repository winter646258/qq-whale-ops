// 好感度（按会话存储 + 注入 + 提醒）单元测试。
// 跑法：node scripts/test-affinity.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AFFINITY_MIN,
  AFFINITY_MAX,
  AFFINITY_NOTE_MAX_CHARS,
  AFFINITY_NUDGE_AFTER_MS,
  AFFINITY_NUDGE_COOLDOWN_MS,
  normalizeAffinityKey,
  cleanAffinityNote,
  clampAffinityLevel,
  normalizeEntry,
  normalizeAffinityMap,
  getAffinity,
  setAffinity,
  shouldNudgeAffinity,
  formatAffinityLine,
  formatAffinityNudge,
  loadAffinityState,
  saveAffinityState,
  normalizeAffinityState
} from '../src/affinity-store.js';

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
  }
}

// ── normalizeAffinityKey ───────────────────────────────────────
t('normalizeAffinityKey：群号', () => {
  assert.equal(normalizeAffinityKey('group:906710082'), 'group:906710082');
});

t('normalizeAffinityKey：私聊', () => {
  assert.equal(normalizeAffinityKey('private:1124721191'), 'private:1124721191');
});

t('normalizeAffinityKey：去前导零', () => {
  assert.equal(normalizeAffinityKey('private:007'), 'private:7');
});

t('normalizeAffinityKey：非法返回 null', () => {
  assert.equal(normalizeAffinityKey(''), null);
  assert.equal(normalizeAffinityKey(null), null);
  assert.equal(normalizeAffinityKey('qq:123'), null);
  assert.equal(normalizeAffinityKey('group:abc'), null);
  assert.equal(normalizeAffinityKey('group:'), null);
});

t('normalizeAffinityKey：超出安全整数拒绝', () => {
  assert.equal(normalizeAffinityKey('group:99999999999999999999'), null);
});

// ── cleanAffinityNote ──────────────────────────────────────────
t('cleanAffinityNote：压平空白', () => {
  assert.equal(cleanAffinityNote('  a\n\nb  '), 'a b');
});

t('cleanAffinityNote：超长截断', () => {
  const out = cleanAffinityNote('字'.repeat(AFFINITY_NOTE_MAX_CHARS + 50));
  assert.equal(out.length, AFFINITY_NOTE_MAX_CHARS);
});

t('cleanAffinityNote：空值给空串', () => {
  assert.equal(cleanAffinityNote(null), '');
  assert.equal(cleanAffinityNote(undefined), '');
});

// ── clampAffinityLevel ─────────────────────────────────────────
t('clampAffinityLevel：正常值', () => {
  assert.equal(clampAffinityLevel(5), 5);
  assert.equal(clampAffinityLevel('7'), 7);
});

t('clampAffinityLevel：超上限夹住', () => {
  assert.equal(clampAffinityLevel(99), AFFINITY_MAX);
});

t('clampAffinityLevel：低于下限夹住', () => {
  assert.equal(clampAffinityLevel(0), AFFINITY_MIN);
  assert.equal(clampAffinityLevel(-5), AFFINITY_MIN);
});

t('clampAffinityLevel：四舍五入', () => {
  assert.equal(clampAffinityLevel(3.6), 4);
  assert.equal(clampAffinityLevel(3.4), 3);
});

t('clampAffinityLevel：没给返回 null', () => {
  assert.equal(clampAffinityLevel(undefined), null);
  assert.equal(clampAffinityLevel(null), null);
  assert.equal(clampAffinityLevel(''), null);
});

t('clampAffinityLevel：非数字返回 null', () => {
  assert.equal(clampAffinityLevel('abc'), null);
});

// ── normalizeEntry ─────────────────────────────────────────────
t('normalizeEntry：正常条目', () => {
  const e = normalizeEntry({ level: 4, note: '挺好', updatedAt: 1000 });
  assert.deepEqual(e, { level: 4, note: '挺好', updatedAt: 1000 });
});

t('normalizeEntry：只有 note 也算存过', () => {
  const e = normalizeEntry({ note: '还行' });
  assert.equal(e.level, AFFINITY_MIN);
  assert.equal(e.note, '还行');
});

t('normalizeEntry：全空返回 null', () => {
  assert.equal(normalizeEntry({}), null);
  assert.equal(normalizeEntry(null), null);
  assert.equal(normalizeEntry('x'), null);
});

t('normalizeEntry：非法 level 退回下限', () => {
  const e = normalizeEntry({ level: 'abc', note: 'x' });
  assert.equal(e.level, AFFINITY_MIN);
});

// ── normalizeAffinityMap ───────────────────────────────────────
t('normalizeAffinityMap：保留合法键', () => {
  const m = normalizeAffinityMap({
    'private:1': { level: 3, note: 'a' },
    'group:2': { level: 5, note: 'b' }
  });
  assert.equal(Object.keys(m).length, 2);
});

t('normalizeAffinityMap：丢掉非法键', () => {
  const m = normalizeAffinityMap({
    'bad:1': { level: 3 },
    'private:1': { level: 3, note: 'a' }
  });
  assert.deepEqual(Object.keys(m), ['private:1']);
});

t('normalizeAffinityMap：非法输入返回空表', () => {
  assert.deepEqual(normalizeAffinityMap(null), {});
  assert.deepEqual(normalizeAffinityMap('x'), {});
});

// ── getAffinity：关键行为（不回退全局）───────────────────────────
const MAP = {
  'private:1124721191': { level: 4, note: '半夜折腾着给我接生图的那个', updatedAt: 1000 }
};

t('getAffinity：有记录就返回', () => {
  const e = getAffinity(MAP, 'private:1124721191');
  assert.equal(e.level, 4);
  assert.equal(e.note, '半夜折腾着给我接生图的那个');
});

t('getAffinity：没记录返回 null（绝不回退到别人）', () => {
  assert.equal(getAffinity(MAP, 'group:906710082'), null);
  assert.equal(getAffinity(MAP, 'private:999'), null);
});

t('getAffinity：非法 key 返回 null', () => {
  assert.equal(getAffinity(MAP, 'bad'), null);
});

t('getAffinity：不回退全局 —— 这是本次改造的核心', () => {
  // 模拟老数据：文件里有全局 affinity，但没有按会话的
  const oldStyle = { affinities: {} };
  assert.equal(getAffinity(oldStyle.affinities, 'private:1124721191'), null);
});

// ── setAffinity ────────────────────────────────────────────────
t('setAffinity：写入新条目', () => {
  const { map, entry } = setAffinity({}, { key: 'private:1', level: 5, note: '不错', now: 2000 });
  assert.equal(entry.level, 5);
  assert.equal(entry.note, '不错');
  assert.equal(entry.updatedAt, 2000);
  assert.equal(map['private:1'].level, 5);
});

t('setAffinity：只改 level 保留 note', () => {
  const { map } = setAffinity(MAP, { key: 'private:1124721191', level: 7, now: 2000 });
  assert.equal(map['private:1124721191'].level, 7);
  assert.equal(map['private:1124721191'].note, '半夜折腾着给我接生图的那个');
});

t('setAffinity：只改 note 保留 level', () => {
  const { map } = setAffinity(MAP, { key: 'private:1124721191', note: '新评价', now: 2000 });
  assert.equal(map['private:1124721191'].level, 4);
  assert.equal(map['private:1124721191'].note, '新评价');
});

t('setAffinity：不改原表（不可变）', () => {
  const before = JSON.stringify(MAP);
  setAffinity(MAP, { key: 'private:1124721191', level: 9 });
  assert.equal(JSON.stringify(MAP), before);
});

t('setAffinity：超范围抛错', () => {
  assert.throws(() => setAffinity({}, { key: 'private:1', level: 99 }), /好感度只能是/);
  assert.throws(() => setAffinity({}, { key: 'private:1', level: 0 }), /好感度只能是/);
});

t('setAffinity：非数字抛错', () => {
  assert.throws(() => setAffinity({}, { key: 'private:1', level: 'abc' }), /必须是数字/);
});

t('setAffinity：非法 key 抛错', () => {
  assert.throws(() => setAffinity({}, { key: 'bad', level: 5 }), /必须指定会话 key/);
});

t('setAffinity：两个会话互不影响', () => {
  let { map } = setAffinity({}, { key: 'private:1', level: 9, note: 'A', now: 1000 });
  ({ map } = setAffinity(map, { key: 'group:2', level: 2, note: 'B', now: 2000 }));
  assert.equal(map['private:1'].level, 9);
  assert.equal(map['group:2'].level, 2);
});

// ── shouldNudgeAffinity ────────────────────────────────────────
const NOW = 1000 * 60 * 60 * 24 * 100; // 随便一个时刻

t('shouldNudgeAffinity：刚改过不提醒', () => {
  const entry = { level: 4, note: 'x', updatedAt: NOW - 1000 };
  assert.equal(shouldNudgeAffinity({ entry, now: NOW }), false);
});

t('shouldNudgeAffinity：超过 14 天提醒', () => {
  const entry = { level: 4, note: 'x', updatedAt: NOW - AFFINITY_NUDGE_AFTER_MS - 1 };
  assert.equal(shouldNudgeAffinity({ entry, now: NOW }), true);
});

t('shouldNudgeAffinity：没有 note 不提醒', () => {
  const entry = { level: 4, note: '', updatedAt: NOW - AFFINITY_NUDGE_AFTER_MS - 1 };
  assert.equal(shouldNudgeAffinity({ entry, now: NOW }), false);
});

t('shouldNudgeAffinity：没有条目不提醒', () => {
  assert.equal(shouldNudgeAffinity({ entry: null, now: NOW }), false);
});

t('shouldNudgeAffinity：7 天内提醒过就不再提醒', () => {
  const entry = { level: 4, note: 'x', updatedAt: NOW - AFFINITY_NUDGE_AFTER_MS - 1 };
  assert.equal(shouldNudgeAffinity({ entry, lastNudgedAt: NOW - 1000, now: NOW }), false);
});

t('shouldNudgeAffinity：超过 7 天可以再提醒', () => {
  const entry = { level: 4, note: 'x', updatedAt: NOW - AFFINITY_NUDGE_AFTER_MS - 1 };
  assert.equal(shouldNudgeAffinity({ entry, lastNudgedAt: NOW - AFFINITY_NUDGE_COOLDOWN_MS - 1, now: NOW }), true);
});

t('shouldNudgeAffinity：updatedAt 为 0 不提醒', () => {
  const entry = { level: 4, note: 'x', updatedAt: 0 };
  assert.equal(shouldNudgeAffinity({ entry, now: NOW }), false);
});

// ── formatAffinityLine：只给 note 不给数字 ──────────────────────
t('formatAffinityLine：有 note 就注入', () => {
  const out = formatAffinityLine({
    entry: { level: 4, note: '嘴上爱怼，活儿是真干' },
    key: 'private:1124721191',
    ownerQQ: 1124721191
  });
  assert.ok(out.includes('嘴上爱怼，活儿是真干'));
});

t('formatAffinityLine：不出现数字（核心约束）', () => {
  const out = formatAffinityLine({
    entry: { level: 9, note: '挺好' },
    key: 'group:1',
    ownerQQ: 1124721191
  });
  assert.ok(!out.includes('9'), `不该出现数字 9：${out}`);
  assert.ok(!/\d/.test(out), `不该出现任何数字：${out}`);
});

t('formatAffinityLine：主人用「主人」称呼', () => {
  const out = formatAffinityLine({
    entry: { level: 4, note: 'x' },
    key: 'private:1124721191',
    ownerQQ: 1124721191
  });
  assert.ok(out.includes('主人'));
});

t('formatAffinityLine：其他人用「这个人」', () => {
  const out = formatAffinityLine({
    entry: { level: 4, note: 'x' },
    key: 'group:906710082',
    ownerQQ: 1124721191
  });
  assert.ok(out.includes('这个人'));
  assert.ok(!out.includes('主人'));
});

t('formatAffinityLine：没 note 返回空串', () => {
  assert.equal(formatAffinityLine({ entry: { level: 4, note: '' }, key: 'group:1' }), '');
  assert.equal(formatAffinityLine({ entry: null, key: 'group:1' }), '');
});

// ── formatAffinityNudge ────────────────────────────────────────
t('formatAffinityNudge：有提示语且指向 qq_mood', () => {
  const out = formatAffinityNudge({
    entry: { level: 4, note: 'x' },
    key: 'private:1124721191',
    ownerQQ: 1124721191
  });
  assert.ok(out.includes('qq_mood'));
  assert.ok(out.includes('主人'));
});

t('formatAffinityNudge：没有条目返回空串', () => {
  assert.equal(formatAffinityNudge({ entry: null, key: 'group:1' }), '');
});

// ── IO ────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'affinity-test-'));

t('loadAffinityState：文件不存在给空表', () => {
  const st = loadAffinityState(path.join(TMP, 'nope.json'));
  assert.deepEqual(st.affinities, {});
  assert.deepEqual(st.nudgeAt, {});
});

t('saveAffinityState + loadAffinityState：往返', () => {
  const file = path.join(TMP, 'a.json');
  const { map } = setAffinity({}, { key: 'private:1', level: 6, note: '还行', now: 1234 });
  saveAffinityState(file, { affinities: map, nudgeAt: { 'private:1': 5678 } });
  const st = loadAffinityState(file);
  assert.equal(st.affinities['private:1'].level, 6);
  assert.equal(st.affinities['private:1'].note, '还行');
  assert.equal(st.nudgeAt['private:1'], 5678);
});

t('saveAffinityState：权限 600（非 Windows）', () => {
  const file = path.join(TMP, 'perm.json');
  saveAffinityState(file, { affinities: { 'private:1': { level: 3, note: 'x', updatedAt: 1 } } });
  assert.ok(fs.existsSync(file));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

t('saveAffinityState：不留 tmp 文件', () => {
  const file = path.join(TMP, 'notmp.json');
  saveAffinityState(file, { affinities: {} });
  assert.ok(!fs.existsSync(file + '.tmp'));
});

t('loadAffinityState：损坏文件抛错（不静默清空）', () => {
  const file = path.join(TMP, 'broken.json');
  fs.writeFileSync(file, '{坏掉的 json');
  assert.throws(() => loadAffinityState(file));
});

t('normalizeAffinityState：丢掉坏数据保留好的', () => {
  const st = normalizeAffinityState({
    affinities: {
      'private:1': { level: 5, note: 'ok' },
      'bad:2': { level: 3 },
      'group:3': {} // 空壳应丢
    },
    nudgeAt: { 'private:1': 100, bad: 200, 'group:3': 'x' }
  });
  assert.deepEqual(Object.keys(st.affinities), ['private:1']);
  assert.deepEqual(Object.keys(st.nudgeAt), ['private:1']);
});

t('normalizeAffinityState：非法输入给空结构', () => {
  const st = normalizeAffinityState(null);
  assert.deepEqual(st.affinities, {});
  assert.equal(st.version, 1);
});

// ── 完整场景：迁移 ─────────────────────────────────────────────
t('场景：从全局单值迁移到主人私聊一份，其他会话不受影响', () => {
  // 老文件里全局 affinity 是 level 4 + 主人专属 note
  const legacyGlobal = {
    level: 4,
    note: '半夜折腾着给我接生图、捏mc小人的那个，嘴上爱怼，活儿是真干',
    updatedAt: 1792680886640
  };
  // 迁移：搬进 private:1124721191
  const { map } = setAffinity({}, {
    key: 'private:1124721191',
    level: legacyGlobal.level,
    note: legacyGlobal.note,
    now: legacyGlobal.updatedAt
  });
  // 主人私聊能读到
  assert.equal(getAffinity(map, 'private:1124721191').level, 4);
  // 群里读不到（不会对着群友说主人的话）
  assert.equal(getAffinity(map, 'group:906710082'), null);
  assert.equal(getAffinity(map, 'group:910502749'), null);
  // 好友私聊也读不到
  assert.equal(getAffinity(map, 'private:3414115838'), null);
});

console.log(`\n好感度测试：${pass} PASS / ${fail} FAIL（共 ${pass + fail}）`);
if (fail) {
  for (const f of failures) {
    console.log(`\n✗ ${f.name}\n  ${f.error?.message ?? f.error}`);
  }
  process.exit(1);
}
