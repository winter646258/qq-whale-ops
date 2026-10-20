"""把日记从 Markdown 换成 jsonl（+ mood 字段 + 修时区 bug）。

══ 为什么换 ═══════════════════════════════════════════════════════════════

现格式：`diary/日记.md`，每行 `- [YYYY-MM-DD HH:mm] 正文`。

三个问题：

1) **结构不牢**：正文里的换行被压成空格；但正文若以 `- ` 开头，下一条读取时
   会被误认成新日记，条目计数直接对不上。实测证明：写一条 `- 今天买梨了\n- 但没给她留`
   再写一条普通日记，Markdown 方案会读成 4 条。

2) **时间戳是 UTC**：`new Date().toISOString()` 在 Asia/Shanghai 上差 8 小时。
   实测 22:24 会写成 14:24 —— 她深夜写的日记会显示成下午。
   代码里其实早有正确的 `localClock()`（1151 行，注释就写着"此前用 toISOString
   写进日志的是 UTC，和本地时间差 8 小时"），但日记这块没复用。

3) **没有情绪字段**：这张「人体系统」图里唯一整块空白的是「情绪系统」。
   日记是她唯一能自然记录情绪的地方 —— 最便宜的入口。

══ 换成什么 ═══════════════════════════════════════════════════════════════

`diary/日记.jsonl`，一行一条：

    {"id":"d3f2a1","t":1792420000000,"time":"2026-10-20 22:24",
     "day":"2026-10-20","mood":"有点累","text":"那只梨没回来"}

- `mood` **可选**，且**不设枚举** —— 让她随便写，系统不分类、不统计情绪分布。
  一旦写成固定几档，她就会开始"贴标签"而不是"记事"。
- `t` 是机器用的时间戳，`time`/`day` 是给人看的本地时间。
- 坏行跳过不抛错（一条坏行不该让整本日记读不出来）。
- 旧的 `日记.md` 保留为只读，可迁移可回看。

回滚：
  cp src/bridge.js.bak-diaryjsonl-<stamp> src/bridge.js
  cp src/mcp-snowluma-safe.js.bak-diaryjsonl-<stamp> src/mcp-snowluma-safe.js
  systemctl restart qq-bridge && systemctl restart qq-dsh
  （日记数据：diary/日记.jsonl 可删；旧的 .md 一直在）
"""
import os
import shutil
import time

BRIDGE = os.environ.get('QQ_BRIDGE_SRC') or '/opt/qq-bridge/src/bridge.js'
MCP = os.environ.get('QQ_BRIDGE_MCP') or '/opt/qq-bridge/src/mcp-snowluma-safe.js'
MARKER = 'MARKER: diary-jsonl'

src = open(BRIDGE, encoding='utf-8', newline='').read()
if MARKER in src:
    print('[skip] bridge 已打过')
    raise SystemExit(0)


def sub_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f'[x] 锚点「{label}」匹配 {n} 次（预期 1）')
        raise SystemExit(1)
    return text.replace(old, new, 1)


# ── 1. import 模块 ────────────────────────────────────────────────────────
src = sub_once(
    src,
    "import { resolvePriceTable } from './model-prices.js';",
    "// MARKER: diary-jsonl\n"
    "// 日记改 jsonl：Markdown 的「正文里出现 - 开头就破坏结构」是真隐患，\n"
    "// 而且旧实现的时间戳是 UTC（差 8 小时）。纯逻辑在 diary-store.js，带单测。\n"
    "import {\n"
    "  DIARY_JSONL, DIARY_LEGACY_MD, MAX_ENTRIES as DIARY_MAX_ENTRIES,\n"
    "  MAX_TEXT_CHARS as DIARY_MAX_TEXT, MAX_MOOD_CHARS as DIARY_MAX_MOOD,\n"
    "  MAX_BYTES as DIARY_MAX_BYTES,\n"
    "  readDiary, writeDiary, appendDiaryEntry, updateDiaryEntry, removeDiaryEntry,\n"
    "  recentDiary, diaryDays, diaryStats, parseLegacyMarkdown, localStamp\n"
    "} from './diary-store.js';\n"
    "import { resolvePriceTable } from './model-prices.js';",
    'import diary-store'
)

# ── 2. 读：GET 分支改成读 jsonl ───────────────────────────────────────────
src = sub_once(
    src,
    """              if (isDiary) {
                const limit = Math.max(1, Math.min(100, Number(q.get('recent')) || 10));
                let text = '';
                try { text = fs.readFileSync(DIARY_FILE, 'utf8'); } catch {}
                const lines = text.split('\\n').filter((l) => l.trim().startsWith('- '));
                sendJson({ ok: true, key, total: lines.length, recent: lines.slice(-limit), hint: lines.length ? undefined : '日记还是空的，你可以写第一条' });
              } else {""",
    """              if (isDiary) {
                // MARKER: diary-jsonl
                const limit = Math.max(1, Math.min(100, Number(q.get('recent')) || 10));
                let entries = [];
                try { entries = readDiary(DIARY_FILE); }
                catch (error) {
                  log(`日记读取失败（本次只读不写）：${error?.message ?? error}`);
                  diaryWritable = false;
                  sendJson({ ok: false, error: `日记读取失败：${error?.message ?? error}` }, 500);
                  return;
                }
                const recent = recentDiary(entries, limit);
                const stats = diaryStats(entries);
                sendJson({
                  ok: true,
                  key,
                  total: entries.length,
                  // 给模型看的是可读的行，不是原始 JSON —— 她不需要解析字段名
                  recent: recent.map((e) => `[${e.time || '未知时间'}]${e.mood ? `（${e.mood}）` : ''} ${e.text}`),
                  entries: recent,
                  days: diaryDays(entries).slice(-20),
                  stats,
                  hint: entries.length ? undefined : '日记还是空的，你可以写第一条'
                });
              } else {""",
    'GET 读日记'
)

# ── 3. 写：append / replace 改成 jsonl ────────────────────────────────────
OLD_WRITE = """            // ── 写：日记 ──
            if (isDiary) {
              const text = truncateText(redactKnownTokensOnly(String(body.text ?? '')).trim(), LIM.diary.maxChar);
              if (!text) { sendJson({ ok: false, error: '日记内容不能为空' }, 400); return; }
              if (SENSITIVE_RE.test(text)) { sendJson({ ok: false, error: '内容疑似含敏感信息，已拒绝写入' }, 400); return; }
              const mode = body.mode === 'replace' ? 'replace' : 'append';
              let cur = '';
              try { cur = fs.readFileSync(DIARY_FILE, 'utf8'); } catch { cur = ''; }
              const lines = cur.split('\\n');
              const idxs = [];
              for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith('- ')) idxs.push(i);
              const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
              const line = '- [' + stamp + '] ' + text.replace(/\\n/g, ' ');
              scopeCheck('diary');
              if (mode === 'replace') {
                const oldText = String(body.oldText ?? '').trim();
                if (!oldText) { sendJson({ ok: false, error: 'mode=replace 需要 oldText 指定要改写的那一行' }, 400); return; }
                const hit = idxs.find((i) => lines[i].includes(oldText));
                if (hit === undefined) { sendJson({ ok: false, error: '找不到包含该内容的日记行' }, 404); return; }
                lines[hit] = line;
                const next = lines.join('\\n');
                if (Buffer.byteLength(next) > LIM.diary.maxBytes) { sendJson({ ok: false, error: '日记文件已达上限' }, 400); return; }
                fs.mkdirSync(path.dirname(DIARY_FILE), { recursive: true });
                fs.writeFileSync(DIARY_FILE + '.tmp', next, 'utf8');
                fs.renameSync(DIARY_FILE + '.tmp', DIARY_FILE);
                sendJson({ ok: true, key, mode: 'replace', line, total: idxs.length });
                return;
              }
              if (idxs.length >= LIM.diary.maxEntries) { sendJson({ ok: false, error: '日记条数已达上限（' + LIM.diary.maxEntries + ' 条）' }, 400); return; }
              if (Buffer.byteLength(cur) > LIM.diary.maxBytes) { sendJson({ ok: false, error: '日记文件已达上限' }, 400); return; }
              fs.mkdirSync(path.dirname(DIARY_FILE), { recursive: true });
              const prefix = cur === '' ? '' : (cur.endsWith('\\n') ? '' : '\\n');
              fs.appendFileSync(DIARY_FILE, prefix + line + '\\n', 'utf8');
              sendJson({ ok: true, key, mode: 'append', line, total: idxs.length + 1 });
              return;
            }"""

NEW_WRITE = """            // ── 写：日记（jsonl）──
            if (isDiary) {
              // MARKER: diary-jsonl
              // 读不动时拒绝写：否则内存里的空数组会把整本日记覆盖掉。
              if (!diaryWritable) { sendJson({ ok: false, error: '日记库当前为只读（读取失败过），拒绝写入以免覆盖' }, 503); return; }
              let entries;
              try { entries = readDiary(DIARY_FILE); }
              catch (error) {
                diaryWritable = false;
                log(`日记读取失败，已切只读：${error?.message ?? error}`);
                sendJson({ ok: false, error: `日记读取失败：${error?.message ?? error}` }, 500);
                return;
              }

              const text = redactKnownTokensOnly(String(body.text ?? '')).trim();
              const moodRaw = body.mood !== undefined ? redactKnownTokensOnly(String(body.mood ?? '')).trim() : undefined;
              if (!text && !moodRaw) { sendJson({ ok: false, error: '日记内容不能为空' }, 400); return; }
              if (text && SENSITIVE_RE.test(text)) { sendJson({ ok: false, error: '内容疑似含敏感信息，已拒绝写入' }, 400); return; }
              if (moodRaw && SENSITIVE_RE.test(moodRaw)) { sendJson({ ok: false, error: '心情疑似含敏感信息，已拒绝写入' }, 400); return; }

              const mode = body.mode === 'replace' ? 'replace' : 'append';
              scopeCheck('diary');

              if (mode === 'replace') {
                const oldText = String(body.oldText ?? '').trim();
                const id = String(body.id ?? '').trim();
                if (!oldText && !id) { sendJson({ ok: false, error: 'mode=replace 需要 id 或 oldText 指定要改写的那一条' }, 400); return; }
                const r = updateDiaryEntry(entries, {
                  id,
                  oldText,
                  text: text || undefined,
                  mood: moodRaw !== undefined ? moodRaw : undefined
                });
                if (!r) { sendJson({ ok: false, error: '找不到要改写的那条日记' }, 404); return; }
                const bytes = writeDiary(DIARY_FILE, entries);
                if (bytes > DIARY_MAX_BYTES) { sendJson({ ok: false, error: '日记文件已达上限' }, 400); return; }
                sendJson({
                  ok: true, key, mode: 'replace', changed: r.changed,
                  line: `[${r.entry.time}]${r.entry.mood ? `（${r.entry.mood}）` : ''} ${r.entry.text}`,
                  total: entries.length
                });
                return;
              }

              let entry;
              try {
                entry = appendDiaryEntry(entries, { text, mood: moodRaw });
              } catch (error) {
                sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
                return;
              }
              const bytes = writeDiary(DIARY_FILE, entries);
              if (bytes > DIARY_MAX_BYTES) { sendJson({ ok: false, error: '日记文件已达上限' }, 400); return; }
              log(`[日记] ${key} 写了一条（共 ${entries.length} 条）`);
              sendJson({
                ok: true, key, mode: 'append',
                line: `[${entry.time}]${entry.mood ? `（${entry.mood}）` : ''} ${entry.text}`,
                entry,
                total: entries.length
              });
              return;
            }"""

src = sub_once(src, OLD_WRITE, NEW_WRITE, 'POST 写日记')

# ── 4. 常量：DIARY_FILE 指向 jsonl + 新增 legacy 路径与可写标志 ───────────
src = sub_once(
    src,
    """          const DIARY_FILE = path.join(ROOT, 'diary', '日记.md');
          const ALBUM_DIR = path.join(ROOT, 'album');""",
    """          // MARKER: diary-jsonl
          // 新日记写 jsonl；旧的 日记.md 保留为只读（迁移/回看用）。
          const DIARY_FILE = path.join(ROOT, 'diary', DIARY_JSONL);
          const DIARY_LEGACY = path.join(ROOT, 'diary', DIARY_LEGACY_MD);
          const ALBUM_DIR = path.join(ROOT, 'album');""",
    'DIARY_FILE 常量'
)

src = sub_once(
    src,
    """          const LIM = {
            diary: { maxPerMinute: 3, maxPerHour: 20, maxBytes: 64 * 1024, maxEntries: 500, maxChar: 200 },
            album: { maxPerMinute: 3, maxPerHour: 20, maxEntries: 800 }
          };""",
    """          // MARKER: diary-jsonl
          // 上限放宽：jsonl 比 Markdown 紧凑，2MB / 2000 条够她写很久。
          const LIM = {
            diary: { maxPerMinute: 3, maxPerHour: 20, maxBytes: DIARY_MAX_BYTES, maxEntries: DIARY_MAX_ENTRIES, maxChar: DIARY_MAX_TEXT },
            album: { maxPerMinute: 3, maxPerHour: 20, maxEntries: 800 }
          };
          // 读失败就切只读，避免把「读不动」当「空日记」写回去（与 slang/sticker 同一教训）。
          if (typeof globalThis.__diaryWritable !== 'boolean') globalThis.__diaryWritable = true;""",
    'LIM 与只读标志'
)

# ── 5. 读失败降级用的标志（放在 try 外层，闭包可访问）────────────────────
src = sub_once(
    src,
    """          const scopeTimes = (globalThis.__diaryAlbumTimes ??= new Map());""",
    """          // MARKER: diary-jsonl
          let diaryWritable = globalThis.__diaryWritable !== false;
          const scopeTimes = (globalThis.__diaryAlbumTimes ??= new Map());""",
    'diaryWritable 局部变量'
)

# ── 6. 新增「旧日记迁移」端点（管理员用，幂等）──────────────────────────
src = sub_once(
    src,
    """        // ── 日记 / 相册（diary-album-tools）：作用域严格受限，AI 碰不到其他文件 ─────────""",
    """        // MARKER: diary-jsonl
        // ── 旧 Markdown 日记迁移（仅控制台，幂等）─────────────────────────────
        // 角色调不到（没有 agent token 时走控制台鉴权；带 agent token 会被
        // v2ToolEnabled 的 diary 开关拦，且这个路径不在任何模型工具的描述里）。
        if (req.method === 'POST' && url.pathname === '/api/socialV2/diary/migrate') {
          try {
            const target = path.join(ROOT, 'diary', DIARY_JSONL);
            const legacy = path.join(ROOT, 'diary', DIARY_LEGACY_MD);
            const existing = readDiary(target);
            if (existing.length) {
              sendJson({ ok: true, skipped: true, reason: '目标 jsonl 已有内容，不覆盖', total: existing.length });
              return;
            }
            const parsed = parseLegacyMarkdown(legacy);
            if (!parsed.length) { sendJson({ ok: true, migrated: 0, reason: '旧日记没有可迁移的条目' }); return; }
            // 旧数据没有机器时间戳：给个递增的占位 t，保证排序稳定；time 保留原文。
            const base = Date.now() - parsed.length * 1000;
            for (let i = 0; i < parsed.length; i += 1) {
              parsed[i].t = base + i * 1000;
              if (!parsed[i].id) parsed[i].id = 'd' + (i + 1).toString(16).padStart(5, '0');
            }
            writeDiary(target, parsed);
            log(`日记迁移：从 ${DIARY_LEGACY_MD} 迁入 ${parsed.length} 条（时间戳保留原文，未纠时区）`);
            sendJson({ ok: true, migrated: parsed.length, total: parsed.length });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 日记 / 相册（diary-album-tools）：作用域严格受限，AI 碰不到其他文件 ─────────""",
    '迁移端点'
)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{BRIDGE}.bak-diaryjsonl-{stamp}'
shutil.copy2(BRIDGE, bak)
with open(BRIDGE + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(BRIDGE + '.tmp', BRIDGE)
print(f'[ok] bridge 已打补丁；备份 -> {bak}')

# ══ MCP 侧：qq_diary 加 mood / id 参数 ═══════════════════════════════════
msrc = open(MCP, encoding='utf-8', newline='').read()
if MARKER in msrc:
    print('[skip] mcp 已打过')
    raise SystemExit(0)

OLD_TOOL = """server.tool(
  'qq_diary',
  '你自己的日记（存 diary/日记.md）。只看不传 text；想写就带 text。想写的时候才写，一天几条就够，一两句、具体的小事，别写总结句，也别在聊天里汇报你写了日记。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().optional().describe('要写的内容（不传则查看最近的日记）'),
    mode: z.enum(['append', 'replace']).optional().describe('append=追加一条（默认）；replace=改写某一行，需同时给 oldText'),
    oldText: z.string().optional().describe('mode=replace 时：要改写的那一行里的一段原文'),
    recent: z.number().optional().describe('查看时返回最近几条，默认 10')
  },
  async ({ key, token, text, mode, oldText, recent }) => {
    try {
      if (text) {
        const data = await agentApi('/api/socialV2/diary', {
          method: 'POST',
          body: JSON.stringify({ key, token, text, mode: mode || 'append', oldText }),"""

NEW_TOOL = """server.tool(
  'qq_diary',
  '你自己的日记。只看不传 text；想写就带 text。想写的时候才写，一天几条就够，一两句、具体的小事，别写总结句，也别在聊天里汇报你写了日记。想给某条标一下当时的心情就带 mood（随便几个字，不想标就不标）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    text: z.string().optional().describe('要写的内容（不传则查看最近的日记）'),
    mood: z.string().optional().describe('当时的心情，几个字就够（例：有点累 / 还行 / 挺高兴）。不想标就不传，别硬凑'),
    mode: z.enum(['append', 'replace']).optional().describe('append=追加一条（默认）；replace=改写某一条，用 oldText 或 id 指定'),
    oldText: z.string().optional().describe('mode=replace 时：要改写的那一条里的一段原文'),
    id: z.string().optional().describe('mode=replace 时：那条日记的 id（查看时有）'),
    recent: z.number().optional().describe('查看时返回最近几条，默认 10')
  },
  async ({ key, token, text, mood, mode, oldText, id, recent }) => {
    try {
      if (text || mood) {
        const data = await agentApi('/api/socialV2/diary', {
          method: 'POST',
          body: JSON.stringify({ key, token, text, mood, mode: mode || 'append', oldText, id }),"""

if msrc.count(OLD_TOOL) != 1:
    print(f'[x] mcp qq_diary 锚点匹配 {msrc.count(OLD_TOOL)} 次')
    raise SystemExit(1)
msrc = msrc.replace(OLD_TOOL, NEW_TOOL, 1)

# 描述里提到的路径也要更新。
# 注意：marker 注释必须放在 server.tool( **上方**，不能夹在 'qq_diary' 与描述之间 ——
# 否则「描述里不许出现存储格式」这类检查会误命中注释本身（咱第一次就踩了）。
msrc = msrc.replace(
    "// 作用域严格受限：只能碰 diary/日记.md 与 album/ 两处。\nserver.tool(\n  'qq_diary',",
    "// 作用域严格受限：只能碰 diary/ 与 album/ 两处。\n"
    "// MARKER: diary-jsonl\n"
    "// 日记已改 jsonl 存储；对模型暴露的仍是「写一条 / 看最近几条 / 标心情」，\n"
    "// 存储格式不进工具描述 —— 她不需要知道文件长什么样。\n"
    "server.tool(\n  'qq_diary',",
    1
)
if MARKER not in msrc:
    print('[x] mcp 注释对齐失败（锚点未命中）')
    raise SystemExit(1)

mbak = f'{MCP}.bak-diaryjsonl-{stamp}'
shutil.copy2(MCP, mbak)
with open(MCP + '.tmp', 'wb') as fh:
    fh.write(msrc.encode('utf-8'))
os.replace(MCP + '.tmp', MCP)
print(f'[ok] mcp 已打补丁；备份 -> {mbak}')
print(f'  MARKER: bridge={src.count(MARKER)} mcp={msrc.count(MARKER)}')
print('  下一步：node --check → 迁移旧日记 → systemctl restart')
