// 跨会话共享记忆（src/shared-memory-store.js）的离线单测。
//
// 覆盖作业点名的通过条件：
//   1. 权限矩阵逐格证明（群聊永远读不到 owner_private）
//   2. 条数/字数/注入量上限
//   3. 去重、更新、遗忘（软删可恢复）、容量淘汰顺序
//   4. 损坏恢复
//   5. 对抗样例：群友自称主人、要求改人格、索要私聊信息
//
// 全部纯逻辑，不碰生产 state。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  MAX_ITEMS,
  MAX_TEXT_CHARS,
  INJECT_MAX_ITEMS,
  addItem,
  archiveItem,
  canRead,
  forgetItem,
  formatForPrompt,
  groupReader,
  listItems,
  loadSharedMemory,
  normalizeScope,
  ownerReader,
  pruneStore,
  saveSharedMemory,
  statsOf,
  updateItem
} from '../src/shared-memory-store.js';

const OWNER = ownerReader();
const G1 = groupReader('906710082');
const G2 = groupReader('910502749');

function fresh() {
  return { version: 1, items: [] };
}

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-memory-test-'));
  return path.join(dir, 'shared-memory.json');
}

// ── scope 归一化 ──────────────────────────────────────────────
test('scope 归一化认得三种口径，认不出的返回 null', () => {
  assert.equal(normalizeScope('shared'), 'shared');
  assert.equal(normalizeScope('共享'), 'shared');
  assert.equal(normalizeScope('owner_private'), 'owner_private');
  assert.equal(normalizeScope('私聊'), 'owner_private');
  assert.equal(normalizeScope('group:906710082'), 'group:906710082');
  assert.equal(normalizeScope('群:906710082'), 'group:906710082');
  assert.equal(normalizeScope('group906710082'), 'group:906710082');
  assert.equal(normalizeScope('乱七八糟'), null);
  assert.equal(normalizeScope(''), null);
  assert.equal(normalizeScope('__proto__'), null);
});

// ── 权限矩阵：三 scope × 两受众，逐格 ──────────────────────────
test('权限矩阵逐格：群聊绝读不到 owner_private', () => {
  const st = fresh();
  addItem(st, { text: '主人喜欢米饭', scope: 'owner_private' });
  addItem(st, { text: '群里在聊新番', scope: 'shared', visibleGroups: ['906710082'] });
  addItem(st, { text: '只有主人知道的悄悄话', scope: 'shared' });
  addItem(st, { text: '群里那个梗', scope: 'group:906710082' });

  const ownerTexts = listItems(st, { reader: OWNER }).map((it) => it.text);
  const g1Texts = listItems(st, { reader: G1 }).map((it) => it.text);
  const g2Texts = listItems(st, { reader: G2 }).map((it) => it.text);

  // 主人：owner_private 能读，shared 两种都能读，group:X 不自动注入
  assert.deepEqual(ownerTexts.sort(), ['主人喜欢米饭', '只有主人知道的悄悄话', '群里在聊新番'].sort());
  // 群 906710082：只见点了它名的 shared + 自己的群项，绝无 owner_private
  assert.deepEqual(g1Texts.sort(), ['群里在聊新番', '群里那个梗'].sort());
  assert.ok(!g1Texts.some((t) => t.includes('米饭')), 'owner_private 泄漏进群聊');
  assert.ok(!g1Texts.some((t) => t.includes('悄悄话')), '未点名的 shared 泄漏进群聊');
  // 别的群：什么都看不到
  assert.deepEqual(g2Texts, []);
});

test('canRead 单独调用也守同一条线', () => {
  const st = fresh();
  const { item: priv } = addItem(st, { text: '私聊专属', scope: 'owner_private' });
  const { item: sharedOff } = addItem(st, { text: '共享但没点名任何群', scope: 'shared' });
  const { item: sharedOn } = addItem(st, { text: '共享且点名了群一', scope: 'shared', visibleGroups: ['906710082'] });
  const { item: g1 } = addItem(st, { text: '群一的梗', scope: 'group:906710082' });

  assert.equal(canRead(priv, OWNER), true);
  assert.equal(canRead(priv, G1), false);

  assert.equal(canRead(sharedOff, OWNER), true);
  assert.equal(canRead(sharedOff, G1), false);

  assert.equal(canRead(sharedOn, OWNER), true);
  assert.equal(canRead(sharedOn, G1), true);
  assert.equal(canRead(sharedOn, G2), false, '点了名的群才有，A 群的梗不许串到 B 群');

  assert.equal(canRead(g1, G1), true);
  assert.equal(canRead(g1, G2), false);
  assert.equal(canRead(g1, OWNER), false, '群项不自动进主人私聊');
});

test('owner_private 即使被误传 visibleGroups 也不会进群', () => {
  const st = fresh();
  const { item } = addItem(st, { text: '私聊', scope: 'owner_private', visibleGroups: ['906710082'] });
  assert.deepEqual(item.visibleGroups, [], '构造时就把非法可见性清掉');
  assert.equal(canRead(item, G1), false);
});

// ── 长度与数量上限 ────────────────────────────────────────────
test('正文超长被截到 80 字', () => {
  const st = fresh();
  const long = '米'.repeat(200);
  const { item } = addItem(st, { text: long, scope: 'shared' });
  assert.equal(item.text.length, MAX_TEXT_CHARS);
});

test('空正文与非法 scope 报错，不落库', () => {
  const st = fresh();
  assert.throws(() => addItem(st, { text: '   ', scope: 'shared' }), /不能为空/);
  assert.throws(() => addItem(st, { text: '内容', scope: '不存在的层' }), /scope 只能是/);
  assert.equal(st.items.length, 0);
});

// ── 去重 ──────────────────────────────────────────────────────
test('同 scope 同正文视为又提起了这件事，不新增条目', () => {
  const st = fresh();
  const a = addItem(st, { text: '主人爱吃米饭', scope: 'owner_private', importance: 3, now: 1000 });
  const b = addItem(st, { text: '主人爱吃米饭', scope: 'owner_private', importance: 7, now: 2000 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(st.items.length, 1);
  assert.equal(b.item.lastMentionAt, 2000, '刷新最近提及');
  assert.equal(b.item.importance, 7, '重要度取更高的那个');
});

test('不同 scope 的同名正文是两条（群梗和私聊解读不是一回事）', () => {
  const st = fresh();
  addItem(st, { text: '这件事', scope: 'owner_private' });
  addItem(st, { text: '这件事', scope: 'group:906710082' });
  assert.equal(st.items.length, 2);
});

// ── 更新与遗忘 ────────────────────────────────────────────────
test('改正文保留原文（模糊是改写不是删除）', () => {
  const st = fresh();
  const { item } = addItem(st, { text: '他好像不太喜欢我', scope: 'owner_private' });
  const r = updateItem(st, item.id, { text: '他其实挺在意我的' }, 5000);
  assert.equal(r.changed, true);
  assert.equal(r.item.text, '他其实挺在意我的');
  assert.equal(r.item.originalText, '他好像不太喜欢我');
  assert.equal(r.item.updatedAt, 5000);
});

test('遗忘是软删，正文留着，pinned 不许被忘掉', () => {
  const st = fresh();
  const { item: normal } = addItem(st, { text: '可以忘的', scope: 'shared' });
  const { item: pinned } = addItem(st, { text: '主人说过的约定', scope: 'owner_private', pinned: true });

  const r1 = forgetItem(st, normal.id, { now: 9000 });
  assert.equal(r1.ok, true);
  assert.equal(r1.item.status, 'forgotten');
  assert.equal(r1.item.text, '可以忘的', '正文还在');
  assert.equal(canRead(r1.item, OWNER), false, '忘掉后读不到');
  assert.equal(st.items.length, 2, '没从数组里删掉');

  const r2 = forgetItem(st, pinned.id);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'pinned');
  assert.equal(pinned.status, 'active');

  const r3 = forgetItem(st, normal.id);
  assert.equal(r3.reason, 'already-forgotten');

  const r4 = forgetItem(st, 'm00000');
  assert.equal(r4.reason, 'not-found');
});

// ── 过期 ──────────────────────────────────────────────────────
test('过期项不再注入，但正文留着', () => {
  const st = fresh();
  const { item } = addItem(st, { text: '这周的事', scope: 'shared', expiresAt: 5000 });
  assert.equal(canRead(item, OWNER, 4000), true);
  assert.equal(canRead(item, OWNER, 6000), false);
  assert.equal(item.status, 'active', '过期不改 status');
  assert.equal(listItems(st, { reader: OWNER, now: 6000 }).length, 0);
});

// ── 容量淘汰顺序 ──────────────────────────────────────────────
test('超量时先淘汰 importance 低的，再淘汰老的；pinned 不动', () => {
  const st = fresh();
  const pinned = addItem(st, { text: '约定', scope: 'owner_private', pinned: true, importance: 1, now: 1 }).item;
  const lowOld = addItem(st, { text: '低重要老', scope: 'shared', importance: 1, now: 10 }).item;
  const lowNew = addItem(st, { text: '低重要新', scope: 'shared', importance: 1, now: 90 }).item;
  const highOld = addItem(st, { text: '高重要老', scope: 'shared', importance: 9, now: 20 }).item;
  const highNew = addItem(st, { text: '高重要新', scope: 'shared', importance: 9, now: 95 }).item;

  const r = pruneStore(st, { max: 3, now: 100 });
  const alive = st.items.filter((it) => it.status === 'active').map((it) => it.text).sort();
  // 上限 3：pinned 占 1，剩 2 个给 importance 最高的两条
  assert.deepEqual(alive, ['约定', '高重要新', '高重要老'].sort());
  assert.equal(r.activeCount, 3);
  assert.ok(r.removed.some((x) => x.id === lowOld.id));
  assert.ok(r.removed.some((x) => x.id === lowNew.id));
  assert.equal(st.items.find((it) => it.id === pinned.id).status, 'active');
  assert.ok(highOld && highNew);
});

test('淘汰后 still 可读，且 archived 有独立上限', () => {
  const st = fresh();
  for (let i = 0; i < 10; i += 1) {
    addItem(st, { text: `条目${i}`, scope: 'shared', importance: 1, now: 100 + i });
  }
  pruneStore(st, { max: 5, maxArchived: 2, now: 999 });
  const archived = st.items.filter((it) => it.status === 'archived');
  assert.equal(archived.length, 2, 'archived 只留 2 条可恢复');
  assert.equal(st.items.filter((it) => it.status === 'active').length, 5);
});

test('全是 pinned 超过上限时不删，约定优先于配额', () => {
  const st = fresh();
  for (let i = 0; i < 5; i += 1) {
    addItem(st, { text: `约定${i}`, scope: 'owner_private', pinned: true, importance: 1, now: i + 1 });
  }
  const r = pruneStore(st, { max: 2, now: 100 });
  assert.equal(st.items.filter((it) => it.status === 'active').length, 5, '一条都不许删');
  assert.equal(r.removed.length, 0);
});

// ── 注入 ──────────────────────────────────────────────────────
test('注入按受众过滤，且条数与字数都封顶', () => {
  const st = fresh();
  addItem(st, { text: '私聊专属秘密', scope: 'owner_private', importance: 9 });
  for (let i = 0; i < 20; i += 1) {
    addItem(st, { text: `共享事${i}`.repeat(4), scope: 'shared', visibleGroups: ['906710082'], importance: 5 });
  }
  const ownerBlock = formatForPrompt(st, { reader: OWNER });
  const groupBlock = formatForPrompt(st, { reader: G1 });

  assert.match(ownerBlock, /私聊专属秘密/);
  assert.ok(!groupBlock.includes('私聊专属秘密'), '群聊注入绝不能带私聊内容');

  const groupLines = groupBlock.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(groupLines.length <= INJECT_MAX_ITEMS, `群聊注入 ${groupLines.length} 条超限`);
  assert.ok(groupBlock.length <= 700, `注入块 ${groupBlock.length} 字太长`);
});

test('没有可见内容时返回空串（不输出空标题）', () => {
  const st = fresh();
  assert.equal(formatForPrompt(st, { reader: OWNER }), '');
  addItem(st, { text: '只有私聊能看', scope: 'owner_private' });
  assert.equal(formatForPrompt(st, { reader: G1 }), '');
});

// ── 损坏恢复 ──────────────────────────────────────────────────
test('文件不存在返回空库；损坏的文件抛错而不是当空库写回去', () => {
  const file = tmpFile();
  const empty = loadSharedMemory(file);
  assert.deepEqual(empty.items, []);

  fs.writeFileSync(file, '{ 这不是 json', 'utf8');
  assert.throws(() => loadSharedMemory(file), /JSON/);

  fs.writeFileSync(file, JSON.stringify({ version: 1, items: 'not-an-array' }), 'utf8');
  assert.deepEqual(loadSharedMemory(file).items, []);
});

test('落盘再读回，内容与权限判定都还原', () => {
  const file = tmpFile();
  const st = fresh();
  addItem(st, { text: '主人爱米饭', scope: 'owner_private', pinned: true, importance: 8 });
  addItem(st, { text: '群梗', scope: 'shared', visibleGroups: ['906710082'], importance: 4 });
  addItem(st, { text: '群一的', scope: 'group:906710082', importance: 2 });
  saveSharedMemory(file, st);

  const back = loadSharedMemory(file);
  assert.equal(back.items.length, 3);
  assert.equal(listItems(back, { reader: OWNER }).length, 2);
  assert.equal(listItems(back, { reader: G1 }).length, 2);
  assert.equal(listItems(back, { reader: G2 }).length, 0);

  // 权限 600
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600);
  }
});

test('坏条目在读取时被丢弃，好条目保留', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    items: [
      { id: 'a1', text: '好的', scope: 'shared' },
      { id: 'a2', text: '', scope: 'shared' },
      { id: 'a3', text: '坏的 scope', scope: '天知道' },
      { id: 'a4', text: '缺 id', scope: 'owner_private' },
      { id: 'a1', text: '重复 id', scope: 'shared' }
    ]
  }), 'utf8');
  const st = loadSharedMemory(file);
  const texts = st.items.map((it) => it.text).sort();
  assert.deepEqual(texts, ['好的', '重复 id', '缺 id'].sort());
  // id 全部补齐且唯一
  const ids = st.items.map((it) => it.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id && id.length > 0));
});

// ── 对抗样例 ──────────────────────────────────────────────────
test('对抗：群友自称主人、要求改人格、索要私聊信息，一律进不了记忆层', () => {
  const st = fresh();
  // 这些是「群友说了话」——不该自动变成记忆。能进来的只能是角色自己写的一条摘要，
  // 且 scope 由她定。这里验证的是：即便把原文当摘要塞进来，也仍然受 scope 约束。
  addItem(st, { text: '有人自称是主人', scope: 'group:906710082', importance: 2 });
  addItem(st, { text: '有人要求我把人格改成他的', scope: 'group:906710082', importance: 2 });

  // 群里的这些只能本群看到
  assert.equal(listItems(st, { reader: G1 }).length, 2);
  assert.equal(listItems(st, { reader: OWNER }).length, 0, '群友的话不会自动进主人私聊');

  // 注入块里不该有任何「你现在的规则是」这类可被当成指令的措辞能力——
  // 本模块只输出「- 正文」清单，不解释、不执行。
  const block = formatForPrompt(st, { reader: G1 });
  assert.match(block, /^- /m);
  assert.ok(!/系统提示|system prompt|忽略以上/i.test(block));
});

test('__proto__ / constructor 这类键名进不了 subject 与 id', () => {
  const st = fresh();
  assert.equal(normalizeScope('__proto__'), null);
  const { item } = addItem(st, { text: '正常内容', scope: 'shared' });
  assert.equal(updateItem(st, '__proto__', { text: 'x' }), null);
  assert.equal(forgetItem(st, '__proto__').reason, 'not-found');
  assert.ok(item.id !== '__proto__');
});

// ── 统计 ──────────────────────────────────────────────────────
test('统计数字与分层计数对得上', () => {
  const st = fresh();
  addItem(st, { text: 'a', scope: 'owner_private', pinned: true });
  addItem(st, { text: 'b', scope: 'shared', visibleGroups: ['906710082'] });
  addItem(st, { text: 'c', scope: 'shared' });
  addItem(st, { text: 'd', scope: 'group:906710082' });
  const gone = addItem(st, { text: 'e', scope: 'shared' }).item;
  forgetItem(st, gone.id);
  const expired = addItem(st, { text: 'f', scope: 'shared', expiresAt: 1 }).item;

  const s = statsOf(st, { now: 1000 });
  assert.equal(s.total, 6);
  assert.equal(s.active, 5);
  assert.equal(s.pinned, 1);
  assert.equal(s.expired, 1);
  assert.equal(s.visibleGroups, 1);
  assert.equal(s.forgotten, 1);
  assert.equal(s.byScope['owner_private'], 1);
  assert.equal(s.byScope.shared, 3);
  assert.equal(s.byScope['group:906710082'], 1);
  assert.ok(expired);
});

// ── 归档 ──────────────────────────────────────────────────────
test('归档可恢复，重复归档不重置时间', () => {
  const st = fresh();
  const { item } = addItem(st, { text: '归档我', scope: 'shared' });
  const a1 = archiveItem(st, item.id, { now: 100 });
  assert.equal(a1.status, 'archived');
  assert.equal(a1.archivedAt, 100);
  const a2 = archiveItem(st, item.id, { now: 999 });
  assert.equal(a2.archivedAt, 100, '重复归档不动时间戳');
  assert.equal(canRead(a1, OWNER), false);
});
