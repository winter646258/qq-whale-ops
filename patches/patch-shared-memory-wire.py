#!/usr/bin/env python3
"""阶段 2：跨会话共享记忆的桥接接线（import + 状态文件 + 三个 HTTP 端点 + 注入）。

## 为什么要这个补丁

`src/shared-memory-store.js` 是纯逻辑（无 IO、单测 23/23）。桥接要负责三件事：

1. **接线**：把 `state/shared-memory.json` 读进来、写出去，带文件指纹防覆盖。
2. **权限**：所有读写都必须先算「当前 key 的读者是谁」，再交给 store 的 canRead。
   key 解析是这条链上唯一可能被绕过的地方，所以 `sharedMemoryReaderFor(key)`
   只认三种形态，其余一律 null（拒绝），不做「猜一个最宽松的」。
3. **注入**：`buildWakePromptV2` 里按当前受众拼一段，严格限长。

## 与已有记忆的分工（不重复造系统）

- `memberImpressions`：会话内短标签，主体是「人」
- `portrait.json`：跨会话判断，主体是「人」
- `日记.jsonl`：主体是「时间」
- **本层**：事件与约定摘要，主体是「这件事发生在哪、能给谁看」

## 权限矩阵（由 store 的 canRead 单点实现，这里只负责算 reader）

| scope          | 主人私聊 | 群 X 会话 |
|----------------|---------|----------|
| shared         | 可读     | 仅 visibleGroups 含 X |
| owner_private  | 可读     | 永不可读 |
| group:X        | 不自动注入 | 仅 X 自己可读 |

「group:X 对主人不自动注入」是刻意的。主人想看某个群的情况，
走 `list` action + 显式点名 `group`，只拿摘要，不拿原始消息。

## 注入容量

`INJECT_MAX_ITEMS=8` / `INJECT_MAX_CHARS=600` 是 store 里的常量，
这里再加一道 `bounded('sharedMemoryMaxChars', 600, 200, 2000)` 允许运维收紧。
两道都过才进 prompt。

## 幂等

每处改动前先查 MARKER，已装则跳过。
"""
import pathlib
import sys

# 允许用 argv[1] 指向隔离副本做验证；默认改线上文件。
TARGET = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/qq-bridge/src/bridge.js')

# ── 1. import ────────────────────────────────────────────────────────
IMPORT_ANCHOR = """import {
  readMood, writeMood, createDefaultMood, describeMood, setMood,
  ventUndercurrent, resolveUndercurrent, setAffinity, setBaseline, moodStats,
  MOOD_FILE as MOOD_STORE_FILE
} from './mood-store.js';"""

IMPORT_NEW = IMPORT_ANCHOR + """
// MARKER: shared-memory
// 跨会话共享记忆：主人私聊能了解她在群里经历的重要事情，同时私聊专属内容
// 不进群、群专属内容不自动进私聊。纯逻辑在 shared-memory-store.js，带单测。
import {
  loadSharedMemory, saveSharedMemory, canRead, addItem, updateItem,
  forgetItem, archiveItem, pruneStore, listItems, formatForPrompt,
  listGroupScopeForOwner, findSimilar, statsOf as sharedMemoryStats,
  ownerReader, groupReader, groupIdOfScope,
  MAX_ITEMS as SHARED_MEMORY_MAX_ITEMS,
  MAX_ARCHIVED as SHARED_MEMORY_MAX_ARCHIVED,
  MAX_TEXT_CHARS as SHARED_MEMORY_MAX_TEXT,
  INJECT_MAX_ITEMS as SHARED_MEMORY_INJECT_MAX_ITEMS,
  INJECT_MAX_CHARS as SHARED_MEMORY_INJECT_MAX_CHARS
} from './shared-memory-store.js';"""

# ── 2. 状态文件常量 ──────────────────────────────────────────────────
FILE_ANCHOR = "const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');"

FILE_NEW = FILE_ANCHOR + """
// MARKER: shared-memory-file
const SHARED_MEMORY_FILE = path.join(STATE_DIR, 'shared-memory.json');"""

# ── 3. reader/读写粘合 + 审计，紧贴 v2ToolEnabled 之前 ───────────────
HELPER_ANCHOR = """  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }"""

HELPER_NEW = """  // MARKER: shared-memory-wire
  // ── 跨会话共享记忆的接线层 ─────────────────────────────────────────
  // 这里只做三件事：算出读者、把文件读进来/写出去、留审计痕迹。
  // 权限判定本身一律交给 store 的 canRead —— 两处各写一套迟早会走偏。
  let sharedMemoryCache = null;

  function loadSharedMemoryState() {
    try {
      const st = loadSharedMemory(SHARED_MEMORY_FILE);
      sharedMemoryCache = st;
      return st;
    } catch (error) {
      // 文件坏了要吵出来（loadSharedMemory 对 JSON 错误是抛的）。
      // 静默当空库写回去，等于把她记得的事一次性抹掉。
      console.error(`[shared-memory] 读取失败，本次不注入也不写入：${error?.message ?? error}`);
      return null;
    }
  }

  function getSharedMemoryState() {
    if (!sharedMemoryCache) sharedMemoryCache = loadSharedMemoryState();
    return sharedMemoryCache;
  }

  function persistSharedMemoryState(store, { action, key, detail } = {}) {
    try {
      saveSharedMemory(SHARED_MEMORY_FILE, store);
      sharedMemoryCache = store;
      appendSharedMemoryAudit({ action, key, detail });
      return true;
    } catch (error) {
      console.error(`[shared-memory] 写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  // 审计日志独立一份，不占 social-v2.json 的空间，也方便主人直接翻。
  const SHARED_MEMORY_AUDIT_FILE = path.join(STATE_DIR, 'shared-memory-audit.jsonl');
  function appendSharedMemoryAudit(entry) {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        action: String(entry?.action ?? ''),
        key: String(entry?.key ?? ''),
        detail: entry?.detail ?? null
      });
      fs.appendFileSync(SHARED_MEMORY_AUDIT_FILE, `${line}\\n`, { mode: 0o600 });
    } catch {
      // 审计失败不该让业务失败
    }
  }

  /**
   * 由会话 key 算出读者。**只认三种形态**，其余返回 null（调用方必须拒绝）。
   * 
   * 这里宁可拒绝也不猜：读者算错了就等于权限判错，而这条链上没有任何
   * 上层兜底。
   */
  function sharedMemoryReaderFor(key) {
    const m = /^(group|private):(\\d+)$/.exec(String(key ?? '').trim());
    if (!m) return null;
    const kind = m[1];
    const id = m[2];
    if (kind === 'group') return groupReader(id);
    // 私聊里只有主人身份能看 owner_private；其他好友一律按群聊口径
    //（只能看点了名给他们看的 shared，看不到 owner_private）。
    if (id === String(cfg.ownerQQ)) return ownerReader();
    return null;
  }

  /**
   * 私聊读者：主人 -> ownerReader，其他好友 -> null（不是群，也不是主人）。
   * 对 null 读者的处理是「只能看 shared 里明确列给他的」，由 listItems 的
   * friendReader 兜住；store 没有 friendReader 之前，非主人私聊直接不给读，
   * 宁紧不松。
   */
  function sharedMemoryReaderOrDeny(key) {
    const reader = sharedMemoryReaderFor(key);
    if (reader) return reader;
    // 非主人私聊：明确拒绝，不给「空数组」这种看起来像「没有记忆」的歧义返回。
    return null;
  }

  /** 当前受众的注入文本，超限返回空串（不截半句进 prompt）。 */
  function buildSharedMemoryLineFor(key) {
    if (cfg.socialV2?.sharedMemory?.enabled === false) return '';
    const reader = sharedMemoryReaderFor(key);
    if (!reader) return '';
    const store = getSharedMemoryState();
    if (!store) return '';
    const maxChars = bounded('sharedMemoryMaxChars', SHARED_MEMORY_INJECT_MAX_CHARS, 200, 2000);
    const text = formatForPrompt(store, {
      reader,
      max: SHARED_MEMORY_INJECT_MAX_ITEMS,
      maxChars
    });
    if (!text) return '';
    return `${text}\\n\\n`;
  }

  /** 会话 key 是否为本群（用来判定 group:X 条目归属）。 */
  function sharedMemoryGroupIdOf(key) {
    const m = /^group:(\\d+)$/.exec(String(key ?? '').trim());
    return m ? m[1] : null;
  }


""" + HELPER_ANCHOR

# ── 4. HTTP 端点：插在 memory-append 之前 ────────────────────────────
ROUTE_ANCHOR = """        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {"""

ROUTE_NEW = """        // MARKER: shared-memory-route
        // 跨会话共享记忆（MCP qq_shared_memory 走这里）。
        // 四个 action：read / remember / forget / list。
        //
        // 鉴权口径与旁边 memory-append 一致：带 x-agent-token 时必须校验
        // 令牌 + 会话在允许范围内 + 工具开关。不带令牌 = 控制台调用。
        if (url.pathname === '/api/socialV2/shared-memory') {
          const body = req.method === 'POST' ? await readBody() : {};
          const q = url.searchParams;
          const rawAction = String(body.action ?? q.get('action') ?? 'read').trim();
          const action = ['read', 'remember', 'forget', 'list'].includes(rawAction) ? rawAction : null;
          if (!action) {
            sendJson({ ok: false, error: 'action 必须是 read / remember / forget / list' }, 400);
            return;
          }
          const key = String(body.key ?? q.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }

          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          if (agentToken && !agentTokenOk(key, agentToken)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (agentToken && !v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (agentToken && !v2ToolEnabled('sharedMemory')) {
            sendJson({ ok: false, error: '工具未启用：qq_shared_memory' }, 403);
            return;
          }

          const reader = sharedMemoryReaderFor(key);
          if (!reader) {
            // 非主人私聊没有读者身份。给一句人话，别让她以为「没有记忆」。
            sendJson({
              ok: false,
              error: '这个会话没有跨会话记忆权限：私聊只对主人开放，群里请在本群会话内使用'
            }, 403);
            return;
          }

          const store = getSharedMemoryState();
          if (!store) {
            sendJson({ ok: false, error: '共享记忆文件读取失败，请让主人检查 state/shared-memory.json' }, 500);
            return;
          }

          const nowMs = Date.now();
          try {
            if (action === 'read') {
              const groupOnly = String(body.group ?? q.get('group') ?? '').trim();
              if (groupOnly) {
                // 显式查阅某个群的群专属摘要：只有主人能点，且只给摘要。
                if (reader.kind !== 'owner') {
                  sendJson({ ok: false, error: '只有主人可以按群查阅' }, 403);
                  return;
                }
                const items = listGroupScopeForOwner(store, groupOnly, { now: nowMs });
                sendJson({
                  ok: true, key, action, group: groupOnly,
                  count: items.length,
                  items: items.map((it) => ({
                    id: it.id, text: it.text, importance: it.importance,
                    pinned: it.pinned, lastMentionAt: it.lastMentionAt
                  }))
                });
                return;
              }
              const items = listItems(store, { reader, now: nowMs });
              sendJson({
                ok: true, key, action,
                reader: reader.kind === 'owner' ? 'owner' : `group:${reader.id}`,
                count: items.length,
                stats: sharedMemoryStats(store, { now: nowMs }),
                items: items.map((it) => ({
                  id: it.id,
                  text: it.text,
                  scope: it.scope,
                  importance: it.importance,
                  pinned: it.pinned,
                  expiresAt: it.expiresAt || null
                }))
              });
              return;
            }

            if (action === 'list') {
              // 和 read 的区别：list 只回清单与统计，不展开正文（给控制台/体检用）。
              sendJson({
                ok: true, key, action,
                stats: sharedMemoryStats(store, { now: nowMs }),
                items: listItems(store, { reader, now: nowMs }).map((it) => ({
                  id: it.id, scope: it.scope, importance: it.importance, pinned: it.pinned
                }))
              });
              return;
            }

            if (action === 'remember') {
              const text = String(body.text ?? '').trim();
              if (!text) { sendJson({ ok: false, error: 'text（要记什么）不能为空' }, 400); return; }
              // scope 不传时按当前会话给一个**最保守**的默认：
              // 群里默认 group:<本群>，私聊默认 owner_private。
              // 想跨群共享必须显式写 shared + visibleGroups。
              const defaultScope = reader.kind === 'owner'
                ? 'owner_private'
                : `group:${reader.id}`;
              const scopeRaw = String(body.scope ?? '').trim() || defaultScope;
              const visibleGroups = Array.isArray(body.visibleGroups) ? body.visibleGroups.map(String) : [];
              // 群里不许自己往 owner_private 里写（那等于绕过注入线的反向通道）。
              if (reader.kind !== 'owner' && /^owner_private$/.test(scopeRaw)) {
                sendJson({ ok: false, error: '群会话不能写 owner_private 层' }, 403);
                return;
              }
              // 群会话写 shared 时，visibleGroups 只能点自己这一群，
              // 不许把一个群的内容顺手公开到别的群去。
              if (reader.kind === 'group') {
                const bad = visibleGroups.filter((g) => String(g) !== String(reader.id));
                if (bad.length) {
                  sendJson({ ok: false, error: `群会话只能把内容共享到本群：${bad.join(',')}` }, 403);
                  return;
                }
                if (/^shared$/.test(scopeRaw) && !visibleGroups.length) visibleGroups.push(reader.id);
              }
              const dup = findSimilar(store, { text, reader, now: nowMs });
              const result = addItem(store, {
                text,
                scope: scopeRaw,
                visibleGroups,
                importance: body.importance,
                sourceRef: body.sourceRef ? String(body.sourceRef) : key,
                expiresAt: body.expiresAtMs ? nowMs + Math.max(60000, Number(body.expiresAtMs) || 0) : undefined,
                pinned: body.pinned === true,
                now: nowMs
              });
              pruneStore(store, { max: SHARED_MEMORY_MAX_ITEMS, maxArchived: SHARED_MEMORY_MAX_ARCHIVED, now: nowMs });
              const saved = persistSharedMemoryState(store, {
                action: 'remember', key, detail: { id: result.item.id, scope: result.item.scope, created: result.created }
              });
              if (!saved) { sendJson({ ok: false, error: '写入失败，详见服务日志' }, 500); return; }
              sendJson({
                ok: true, key, action,
                created: result.created,
                duplicateOf: dup ? dup.id : null,
                item: {
                  id: result.item.id, text: result.item.text, scope: result.item.scope,
                  visibleGroups: result.item.visibleGroups, importance: result.item.importance,
                  pinned: result.item.pinned
                }
              });
              return;
            }

            if (action === 'forget') {
              const id = String(body.id ?? '').trim();
              if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
              const target = (store.items || []).find((it) => it && it.id === id);
              if (!target) { sendJson({ ok: false, error: `没有这条记忆：${id}` }, 404); return; }
              // 能不能忘，取决于「你看不看得到」——看不到的东西不许忘，
              // 否则群会话可以按 id 试探并抹掉别处的条目。
              if (!canRead(target, reader, nowMs)) {
                sendJson({ ok: false, error: '没有这条记忆（或不在你可视范围内）' }, 403);
                return;
              }
              const r = forgetItem(store, id, { now: nowMs });
              if (!r.ok) {
                const why = r.reason === 'pinned'
                  ? '这条是主人钉住的约定，不能忘；要改请用 remember 覆盖或让主人解除'
                  : (r.reason === 'already-forgotten' ? '这条已经忘掉了' : '没有这条记忆');
                sendJson({ ok: false, error: why, reason: r.reason }, 409);
                return;
              }
              persistSharedMemoryState(store, { action: 'forget', key, detail: { id } });
              sendJson({ ok: true, key, action, id, status: r.item.status, recoverable: true });
              return;
            }
          } catch (error) {
            sendJson({ ok: false, error: `共享记忆操作失败：${error?.message ?? error}` }, 500);
            return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/api/socialV2/memory-append') {"""

# ── 5. 注入点 ────────────────────────────────────────────────────────
INJECT_ANCHOR = """    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\\n\\n` : '';"""

INJECT_NEW = """    // MARKER: shared-memory-inject
    // 跨会话共享记忆：按当前受众注入，群聊里永不出现 owner_private。
    // 放在参与度参考之前——先给「她记得的事」，再给「此刻的局面」。
    const sharedMemoryLine = buildSharedMemoryLineFor(key);
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\\n\\n` : '';"""

# 找到真实拼接处，把 sharedMemoryLine 插进去。
# 注意：base 那行是 `+` 字符串拼接，不是模板字符串——早期版本按 ${} 找，一次都没命中。
CONCAT_ANCHOR = '+ wakeLine + memoryLine + scheduleLine +'
CONCAT_NEW = '+ wakeLine + memoryLine + sharedMemoryLine + scheduleLine +'


def apply(text, old, new, marker, label):
    if marker in text:
        print(f'· {label}：已装，跳过')
        return text, False
    n = text.count(old)
    if n != 1:
        print(f'❌ {label}：锚点命中 {n} 次（应为 1）')
        raise SystemExit(1)
    return text.replace(old, new, 1), True


def main():
    text = TARGET.read_text(encoding='utf-8')
    changed = []

    text, c = apply(text, IMPORT_ANCHOR, IMPORT_NEW, 'MARKER: shared-memory\n', 'import')
    changed.append(('import', c))

    text, c = apply(text, FILE_ANCHOR, FILE_NEW, 'MARKER: shared-memory-file', '状态文件常量')
    changed.append(('file', c))

    text, c = apply(text, HELPER_ANCHOR, HELPER_NEW, 'MARKER: shared-memory-wire', '接线层')
    changed.append(('wire', c))

    text, c = apply(text, ROUTE_ANCHOR, ROUTE_NEW, 'MARKER: shared-memory-route', 'HTTP 端点')
    changed.append(('route', c))

    text, c = apply(text, INJECT_ANCHOR, INJECT_NEW, 'MARKER: shared-memory-inject', '注入点')
    changed.append(('inject', c))

    # 拼接序列：**必须成功**，否则 sharedMemoryLine 算了却不进 prompt——
    # 那种「看起来装了其实没生效」比没装更危险，所以这里一旦找不到就直接失败。
    if 'sharedMemoryLine' not in text.split("const base = roleLine")[-1].split('\n')[0]:
        n = text.count(CONCAT_ANCHOR)
        if n != 1:
            print(f'❌ 拼接锚点命中 {n} 次（应为 1）——sharedMemoryLine 没有接进 prompt')
            return 1
        text = text.replace(CONCAT_ANCHOR, CONCAT_NEW, 1)
        print('· 拼接序列已插入 sharedMemoryLine')
    else:
        print('· 拼接序列：已装，跳过')

    # 断言：每个 MARKER 恰好一次
    for m in ['MARKER: shared-memory\n', 'MARKER: shared-memory-file', 'MARKER: shared-memory-wire',
              'MARKER: shared-memory-route', 'MARKER: shared-memory-inject']:
        cnt = text.count(m)
        if cnt != 1:
            print(f'❌ MARKER「{m.strip()}」出现 {cnt} 次（应为 1）')
            return 1

    TARGET.write_text(text, encoding='utf-8')
    print('✅ 共享记忆接线已装：', ', '.join(f'{k}={"改" if v else "跳过"}' for k, v in changed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
