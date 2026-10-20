"""加「日程」+「画像」两个能力（给角色的短期记忆与长期认识）。

来源：用户给的作业规格（《给 DSH 的一份作业：给角色加「日程」和「画像」》）。
规格里那句最要紧的话是「如果只抄功能不抄这三条，做出来会是个数据库，
不是"记得住的人"」——所以本补丁**不写任何自动升降级规则**，只给工具和事实：

  一、记不记、糊不糊、升不升，都归角色自己（系统只给工具、给事实）
  二、模糊是改写，不是删除（旧文进 originalText，角色看不到，管理员翻得到）
  三、注入要分层（今天明天写清楚；本周后面只报数量；更远只报总数）

纯逻辑在 src/schedule-store.js 与 src/portrait-store.js（各带独立单测），
本补丁只负责把它们接进桥接：状态文件、HTTP 端点、唤醒注入、工具开关、qq_get_prompt 清单。

回滚：
  cp src/bridge.js.bak-schedport-<stamp> src/bridge.js
  cp src/mcp-snowluma-safe.js.bak-schedport-<stamp> src/mcp-snowluma-safe.js
  systemctl restart qq-bridge && systemctl restart qq-dsh
  （state/schedule.json、state/portrait.json 可直接删，不影响其它状态）
"""
import os
import shutil
import time

BRIDGE = os.environ.get('QQ_BRIDGE_SRC') or '/opt/qq-bridge/src/bridge.js'
MCP = os.environ.get('QQ_BRIDGE_MCP') or '/opt/qq-bridge/src/mcp-snowluma-safe.js'
MARKER = 'MARKER: schedule-portrait'

src = open(BRIDGE, encoding='utf-8', newline='').read()
if MARKER in src:
    print('[skip] bridge 已打过')
    raise SystemExit(0)


def sub_once(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f'✖ 锚点「{label}」匹配 {n} 次（预期 1）')
        raise SystemExit(1)
    return text.replace(old, new, 1)


# ── 1. import 两个纯逻辑模块 ──────────────────────────────────────────────
src = sub_once(
    src,
    "} from './sticker-lib.js';\n",
    "} from './sticker-lib.js';\n"
    "// MARKER: schedule-portrait\n"
    "// 日程（短期记忆）与画像（长期认识）：纯逻辑在各自模块里，桥接只负责接线。\n"
    "// 规格要求「系统只做两件事：给工具、给事实」—— 这两个模块里刻意没有任何\n"
    "// 「按天数自动糊 / 观察 N 次自动升级」的规则：什么时候糊、什么时候删、\n"
    "// 要不要加固，全部由角色自己调工具决定。\n"
    "import {\n"
    "  loadSchedule, saveSchedule, addEntry as addScheduleEntry,\n"
    "  updateEntry as updateScheduleEntry, removeEntry as removeScheduleEntry,\n"
    "  querySchedule, formatScheduleForPrompt, shouldReviewToday, markReviewed,\n"
    "  revealOriginal as revealScheduleOriginal\n"
    "} from './schedule-store.js';\n"
    "import {\n"
    "  loadPortrait, savePortrait, addPortrait, updatePortrait, removePortrait,\n"
    "  queryPortrait, listSubjects, formatPortraitForPrompt,\n"
    "  revealOriginal as revealPortraitOriginal\n"
    "} from './portrait-store.js';\n",
    'import sticker-lib'
)

# ── 2. 状态文件常量 ───────────────────────────────────────────────────────
src = sub_once(
    src,
    "const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');\n",
    "const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');\n"
    "// 日程与画像单独存文件：不塞进 social-v2.json，避免那个文件继续膨胀\n"
    "// （它已经 360KB，每轮状态读写都受它拖累），也不会因为会话状态损坏而连带丢失。\n"
    "const SCHEDULE_FILE = path.join(STATE_DIR, 'schedule.json');\n"
    "const PORTRAIT_FILE = path.join(STATE_DIR, 'portrait.json');\n",
    'STATE_DIR constants'
)

# ── 3. 配置默认值（深合并，旧 config 缺字段也拿到默认）──────────────────
src = sub_once(
    src,
    "  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，",
    "  // 日程（短期记忆）：每轮注入的分层文本由 schedule-store 生成。\n"
    "  // 与 voice/sticker 同一套路做深合并，避免旧 config.json 缺字段时丢默认。\n"
    "  cfg.socialV2.schedule = {\n"
    "    enabled: true,\n"
    "    // 每天一次结算提醒（4 点前不念，免得半夜唠叨）。只在唤醒时提醒，不强制。\n"
    "    reviewNudgeEnabled: true,\n"
    "    ...(cfg.socialV2?.schedule ?? {})\n"
    "  };\n"
    "  // 画像（长期认识）：跨会话，不按会话隔离（这正是它和 memberImpressions 的区别）。\n"
    "  cfg.socialV2.portrait = {\n"
    "    enabled: true,\n"
    "    ...(cfg.socialV2?.portrait ?? {})\n"
    "  };\n"
    "\n"
    "  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，",
    'config defaults'
)

# ── 4. 工具开关默认值 ─────────────────────────────────────────────────────
src = sub_once(
    src,
    "        collectSticker: true,\n        getSelfImage: true\n      },",
    "        collectSticker: true,\n        getSelfImage: true,\n"
    "        schedule: true,\n"
    "        portrait: true\n      },",
    'tools defaults'
)

# ── 5. 控制台可改的工具开关清单 ───────────────────────────────────────────
src = sub_once(
    src,
    "'collectSticker', 'getSelfImage', 'sendVoice'];",
    "'collectSticker', 'getSelfImage', 'sendVoice', 'schedule', 'portrait', 'diary', 'album'];",
    'toolFlags'
)

# ── 6. qq_get_prompt 的工具清单 ───────────────────────────────────────────
src = sub_once(
    src,
    "            diary: 'qq_diary',\n            album: 'qq_album'\n          };",
    "            diary: 'qq_diary',\n            album: 'qq_album',\n"
    "            // 日程/画像：规格里的两个新能力\n"
    "            schedule: 'qq_schedule',\n"
    "            portrait: 'qq_portrait'\n          };",
    'toolMap'
)

# ── 7. HTTP 端点：日程 + 画像 ─────────────────────────────────────────────
ENDPOINTS = r"""        // ── 日程 / 画像：角色的短期记忆与长期认识 ──────────────────────────
        // 规格三条原则的落点：
        //   一、只给工具和事实：这里没有任何「按天数自动糊/自动删」的代码路径，
        //       糊/删/加固全部由她调用 action=update / remove 决定。
        //   二、模糊是改写：update 改 text 时模块内部把旧文存进 originalText。
        //   三、注入分层：formatScheduleForPrompt / formatPortraitForPrompt 负责。
        if ((req.method === 'GET' || req.method === 'POST') &&
            (url.pathname === '/api/socialV2/schedule' || url.pathname === '/api/socialV2/portrait')) {
          const isSchedule = url.pathname.endsWith('/schedule');
          const toolFlag = isSchedule ? 'schedule' : 'portrait';
          const toolName = isSchedule ? 'qq_schedule' : 'qq_portrait';
          try {
            const q = url.searchParams;
            const body = req.method === 'POST' ? await readBody() : {};
            const key = String(body.key ?? q.get('key') ?? '').trim();
            const agentToken = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
            const action = String(body.action ?? q.get('action') ?? 'query').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled(toolFlag)) { sendJson({ ok: false, error: '工具未启用：' + toolName }, 403); return; }
            if (cfg.socialV2?.[toolFlag]?.enabled === false) { sendJson({ ok: false, error: toolName + ' 已在配置里关闭' }, 403); return; }

            if (isSchedule) {
              const store = scheduleStore();
              if (action === 'add') {
                const entry = addScheduleEntry(store, {
                  key,
                  date: body.date,
                  period: body.period,
                  text: body.text
                });
                saveScheduleSafe(store, '日程');
                sendJson({ ok: true, key, action, entry, promptText: formatScheduleForPrompt(store, { key }) });
                return;
              }
              if (action === 'update') {
                const r = updateScheduleEntry(store, body.id, {
                  text: body.text,
                  date: body.date,
                  period: body.period,
                  strength: body.strength
                });
                if (!r) { sendJson({ ok: false, error: '找不到这条日程（id=' + String(body.id ?? '') + '）' }, 404); return; }
                saveScheduleSafe(store, '日程');
                sendJson({ ok: true, key, action, changed: r.changed, entry: r.entry, promptText: formatScheduleForPrompt(store, { key }) });
                return;
              }
              if (action === 'remove') {
                const okDel = removeScheduleEntry(store, body.id);
                if (!okDel) { sendJson({ ok: false, error: '找不到这条日程（id=' + String(body.id ?? '') + '）' }, 404); return; }
                saveScheduleSafe(store, '日程');
                sendJson({ ok: true, key, action, removed: String(body.id ?? ''), promptText: formatScheduleForPrompt(store, { key }) });
                return;
              }
              if (action === 'review') {
                // 结算完成：只落「今天已结算」这个事实，具体怎么糊/删/加固她自己做过了。
                markReviewed(store, { key });
                saveScheduleSafe(store, '日程');
                sendJson({ ok: true, key, action, reviewed: true });
                return;
              }
              if (action === 'reveal') {
                // 管理员视角：翻出被糊掉前的原文。角色拿不到（不在注入里、也不在工具描述里提）。
                sendJson({ ok: true, key, action, entry: revealScheduleOriginal(store, body.id) });
                return;
              }
              if (action === 'query') {
                const result = querySchedule(store, { key, scope: body.scope ?? q.get('scope') ?? 'today' });
                sendJson({ ok: true, key, action, ...result, promptText: formatScheduleForPrompt(store, { key }) });
                return;
              }
              sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 add/query/update/remove/review）' }, 400);
              return;
            }

            // ── 画像 ──
            const store = portraitStore();
            if (action === 'add') {
              const item = addPortrait(store, {
                subject: body.subject,
                facet: body.facet,
                text: body.text,
                weight: body.weight
              });
              savePortraitSafe(store, '画像');
              sendJson({ ok: true, key, action, item });
              return;
            }
            if (action === 'update') {
              const r = updatePortrait(store, body.id, {
                text: body.text,
                facet: body.facet,
                weight: body.weight,
                subject: body.subject
              });
              if (!r) { sendJson({ ok: false, error: '找不到这条画像（id=' + String(body.id ?? '') + '）' }, 404); return; }
              savePortraitSafe(store, '画像');
              sendJson({ ok: true, key, action, changed: r.changed, subject: r.subject, item: r.item });
              return;
            }
            if (action === 'remove') {
              const okDel = removePortrait(store, body.id);
              if (!okDel) { sendJson({ ok: false, error: '找不到这条画像（id=' + String(body.id ?? '') + '）' }, 404); return; }
              savePortraitSafe(store, '画像');
              sendJson({ ok: true, key, action, removed: String(body.id ?? '') });
              return;
            }
            if (action === 'subjects') {
              sendJson({ ok: true, key, action, subjects: listSubjects(store) });
              return;
            }
            if (action === 'reveal') {
              sendJson({ ok: true, key, action, item: revealPortraitOriginal(store, body.id) });
              return;
            }
            if (action === 'query') {
              const result = queryPortrait(store, { subject: body.subject ?? q.get('subject'), facet: body.facet ?? q.get('facet') });
              sendJson({ ok: true, key, action, ...result, promptText: formatPortraitForPrompt(store) });
              return;
            }
            sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 add/query/update/remove/subjects）' }, 400);
            return;
          } catch (error) {
            const msg = error?.message ?? String(error);
            // 参数问题（认不出的日期/时段、超上限）是 4xx，别让它看起来像服务端炸了。
            const isInput = /认不出|不能为空|只能是|已达上限|已经 \\d+ 条|非法|非法的/.test(msg);
            sendJson({ ok: false, error: msg }, isInput ? 400 : 500);
            return;
          }
        }

        // ── 日记 / 相册（diary-album-tools）：作用域严格受限，AI 碰不到其他文件 ─────────"""

src = sub_once(
    src,
    "        // ── 日记 / 相册（diary-album-tools）：作用域严格受限，AI 碰不到其他文件 ─────────",
    ENDPOINTS,
    'diary album block'
)

# ── 8. 读写辅助（放在 getSocialV2State 附近）──────────────────────────────
HELPERS = r"""  // ── 日程 / 画像的存取（带「读失败就不写」保护）──────────────────────────
  // 与 slang/sticker 同一个教训：读不动时**绝不能当成空库再写回去**，
  // 那会把磁盘上那份数据永久清零。读失败 ⇒ 该次操作直接报错，且禁止回写。
  let scheduleStoreWritable = true;
  let portraitStoreWritable = true;
  let scheduleStoreCache = null;
  let portraitStoreCache = null;

  function scheduleStore() {
    if (!scheduleStoreCache) {
      try {
        scheduleStoreCache = loadSchedule(SCHEDULE_FILE);
        scheduleStoreWritable = true;
      } catch (error) {
        scheduleStoreWritable = false;
        log(`⚠️ 日程库读取失败，本次操作只读不写（修好文件后重启即可恢复）：${error?.message ?? error}`);
        throw new Error(`日程库读取失败：${error?.message ?? error}`);
      }
    }
    return scheduleStoreCache;
  }

  function saveScheduleSafe(store, label) {
    if (!scheduleStoreWritable) throw new Error(`${label}库当前为只读（读取失败过），拒绝写入以免覆盖`);
    try {
      saveSchedule(SCHEDULE_FILE, store);
    } catch (error) {
      log(`保存${label}失败:`, error?.message ?? error);
      throw error;
    }
  }

  function portraitStore() {
    if (!portraitStoreCache) {
      try {
        portraitStoreCache = loadPortrait(PORTRAIT_FILE);
        portraitStoreWritable = true;
      } catch (error) {
        portraitStoreWritable = false;
        log(`⚠️ 画像库读取失败，本次操作只读不写：${error?.message ?? error}`);
        throw new Error(`画像库读取失败：${error?.message ?? error}`);
      }
    }
    return portraitStoreCache;
  }

  function savePortraitSafe(store, label) {
    if (!portraitStoreWritable) throw new Error(`${label}库当前为只读（读取失败过），拒绝写入以免覆盖`);
    try {
      savePortrait(PORTRAIT_FILE, store);
    } catch (error) {
      log(`保存${label}失败:`, error?.message ?? error);
      throw error;
    }
  }

  function getSocialV2State(key) {"""

src = sub_once(src, "  function getSocialV2State(key) {", HELPERS, 'getSocialV2State')

# ── 9. 唤醒注入 ───────────────────────────────────────────────────────────
OLD_BASE = "    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + participationLine + preSleepLine;"
NEW_BASE = r"""    // 日程（短期记忆）：分层注入 —— 今天明天写清楚，本周后面只报数量，更远只报总数。
    // 规格明确说「塞满的话，每轮都在烧上下文，而且角色反而看不进去」，所以这里
    // 只是几行；详细内容她要翻就调 qq_schedule(action=query)。
    let scheduleLine = '';
    let scheduleReviewLine = '';
    if (cfg.socialV2?.schedule?.enabled !== false) {
      try {
        const schedStore = scheduleStore();
        const text = formatScheduleForPrompt(schedStore, { key });
        scheduleLine = text ? text + '\n\n' : '';
        // 结算机制：每天一次，4 点后才念；念过就落盘，当天不再重复。
        // 关键：只提醒，不替她做任何决定 —— 糊/删/加固都由她自己调 qq_schedule 完成。
        if (cfg.socialV2?.schedule?.reviewNudgeEnabled !== false && shouldReviewToday(schedStore, { key })) {
          scheduleReviewLine = '【日程结算】今天还没过一遍日程。翻一下过去几天的（qq_schedule action=query scope=past）：想不清细节的，改成模糊的说法（改 text 会自动把旧文留底）；过去了又不值得留的，删掉；重要的，把 strength 调高。也可以什么都不做——不用汇报。\n\n';
          markReviewed(schedStore, { key });
          saveScheduleSafe(schedStore, '日程');
        }
      } catch (error) {
        // 日程读不出来不能连累整个唤醒流程：少一段注入而已。
        log(`[reserved2] 日程注入跳过 ${key}：${error?.message ?? error}`);
      }
    }
    // 画像（长期认识）：跨会话共享 —— 这正是它和「对群友的印象」（按会话隔离）
    // 的区别。分层注入：核心几个人 + 数量，不把整本相册灌进上下文。
    let portraitLine = '';
    if (cfg.socialV2?.portrait?.enabled !== false) {
      try {
        const ptext = formatPortraitForPrompt(portraitStore());
        portraitLine = ptext ? ptext + '\n\n' : '';
      } catch (error) {
        log(`[reserved2] 画像注入跳过 ${key}：${error?.message ?? error}`);
      }
    }
    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + wakeLine + memoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;"""

src = sub_once(src, OLD_BASE, NEW_BASE, 'base prompt line')

# ── 10. 落盘前统一写一次 --- 不需要：日程/画像各有自己的文件

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{BRIDGE}.bak-schedport-{stamp}'
shutil.copy2(BRIDGE, bak)
# 二进制读写：绝不经过 text mode。Windows 上 text mode 写盘会把 LF 变成 CRLF，
# 而线上文件是纯 LF —— 那样一打补丁整个文件的行尾就全变了（git diff 一片红）。
with open(BRIDGE + '.tmp', 'wb') as fh:
    fh.write(src.encode('utf-8'))
os.replace(BRIDGE + '.tmp', BRIDGE)
print(f'[ok] bridge.js 已打补丁；备份 -> {bak}')

# ══ MCP 侧 ══════════════════════════════════════════════════════════════
msrc = open(MCP, encoding='utf-8', newline='').read()
if MARKER in msrc:
    print('[skip] mcp 已打过')
    raise SystemExit(0)

msrc = msrc.replace(
    "  qq_diary: 'diary',\n  qq_album: 'album',\n};",
    "  qq_diary: 'diary',\n  qq_album: 'album',\n"
    "  // 日程/画像：规格里的两个新能力\n"
    "  qq_schedule: 'schedule',\n"
    "  qq_portrait: 'portrait',\n};",
    1
)
if "qq_schedule: 'schedule'" not in msrc:
    print('✖ mcp 工具开关锚点未命中')
    raise SystemExit(1)

TOOLS = r"""
// ── 日程 / 画像（schedule-portrait）────────────────────────────────────────
// 规格里那句「如果只抄功能不抄这三条，做出来会是个数据库，不是"记得住的人"」
// 决定了这里描述怎么写：不写「观察 N 次升级」，只告诉她有什么工具、什么时候可能有用，
// 判断权全部留给她。
server.tool(
  'qq_schedule',
  '他的日程（短期记忆，管未来几天）。add=记一条（date 可写 今天/明天/这周三/2026-10-21；period 只要 上午/下午/晚上）；query=翻（scope: today/明天/这周/以后/过去/某一天）；update=改（改 text 会自动把旧说法留底、标记为模糊；也可以改日期/时段；strength 1~9 表示你觉得这条多重要）；remove=删（删了就真没了）；review=过完一遍后标一下今天已结算。日程会自动进入你的唤醒提示。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['add', 'query', 'update', 'remove', 'review']).describe('要做的事'),
    id: z.string().optional().describe('update/remove 时的条目 id（query 结果里有）'),
    date: z.string().optional().describe('add/update：今天/明天/后天/这周三/下周一/2026-10-21'),
    period: z.enum(['上午', '下午', '晚上']).optional().describe('add/update：只要这三个时段，别给精确时间'),
    text: z.string().optional().describe('add/update：内容。update 时改它＝把旧说法换成模糊的新说法'),
    strength: z.number().optional().describe('update：1~9，你觉得这条多重要（想加固就调大）'),
    scope: z.string().optional().describe('query：today/明天/这周/以后/过去/全部 或 具体日期')
  },
  async ({ key, token, action, id, date, period, text, strength, scope }) => {
    try {
      if (action === 'query') {
        const q = new URLSearchParams({ key, scope: String(scope || 'today') });
        const data = await agentApi('/api/socialV2/schedule?' + q.toString(), { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/schedule', {
        method: 'POST',
        body: JSON.stringify({ key, token, action, id, date, period, text, strength }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '日程操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

server.tool(
  'qq_portrait',
  '你对某些人的长期认识（画像，跨会话共享——在这里记的，别的群/私聊里也看得到）。不是待办清单，也不是给系统打标签，就是你自己怎么看他这个人。add=记一条（subject=说谁；facet: doing=他平时在做什么 / view=你怎么看他 / bond=你们处得怎么样；weight 1~9 你觉得多重要）；query=翻（可按 subject 或 facet 过滤）；update=改（改 text＝你改口了，旧判断会自动留底）；remove=删；subjects=看都记过谁。画像会自动进入你的唤醒提示。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['add', 'query', 'update', 'remove', 'subjects']).describe('要做的事'),
    id: z.string().optional().describe('update/remove 时的条目 id（query 结果里有）'),
    subject: z.string().optional().describe('说谁（昵称）。add 必填；update 时填它可把这条挪到别人名下'),
    facet: z.enum(['doing', 'view', 'bond']).optional().describe('doing=他平时在做什么 / view=你怎么看他 / bond=处得怎么样'),
    text: z.string().optional().describe('add/update：你的判断。update 时改它＝改口了'),
    weight: z.number().optional().describe('add/update：1~9，这条对你有多重要')
  },
  async ({ key, token, action, id, subject, facet, text, weight }) => {
    try {
      if (action === 'query' || action === 'subjects') {
        const q = new URLSearchParams({ key, action: String(action) });
        if (subject) q.set('subject', subject);
        if (facet) q.set('facet', facet);
        const data = await agentApi('/api/socialV2/portrait?' + q.toString(), { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      }
      const data = await agentApi('/api/socialV2/portrait', {
        method: 'POST',
        body: JSON.stringify({ key, token, action, id, subject, facet, text, weight }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '画像操作失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// MARKER: schedule-portrait
server.connect(new StdioServerTransport());"""

# 锚点用**真正的最后一行**：文件里 server.connect 前面没有 await
# （而且 1252 行还挂着一个孤儿 `await`，是原作者留下的，不动它）。
if msrc.count("\nserver.connect(new StdioServerTransport());") != 1:
    print('[x] mcp 注册锚点未命中')
    raise SystemExit(1)
msrc = msrc.replace("\nserver.connect(new StdioServerTransport());", TOOLS, 1)
if MARKER not in msrc:
    print('[x] mcp 注册锚点未命中')
    raise SystemExit(1)

mbak = f'{MCP}.bak-schedport-{stamp}'
shutil.copy2(MCP, mbak)
with open(MCP + '.tmp', 'wb') as fh:
    fh.write(msrc.encode('utf-8'))
os.replace(MCP + '.tmp', MCP)
print(f'[ok] mcp-snowluma-safe.js 已打补丁；备份 -> {mbak}')

print(f'  MARKER 出现: bridge={src.count(MARKER)} mcp={msrc.count(MARKER)}')
print('  下一步：node --check 两个文件 → systemctl restart qq-bridge && systemctl restart qq-dsh')
