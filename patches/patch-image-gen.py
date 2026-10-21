#!/usr/bin/env python3
"""给云上桥接加「生图」能力，并把权限卡在服务端。

为什么权限要写在服务端而不是 prompt 里
    一张图 $0.01 是小事，画什么才是大事。群里任何人哄她「画个刺激的」，
    她心一软就画了 —— 这种事不能靠她自觉。所以：
      ① 主人私聊（private:<ownerQQ>）→ 放行
      ② 主人在群里 @ 她 / 叫她名字，且该群两分钟内有主人发言 → 放行
      ③ 其余一律 403
    prompt 层只是「不满足就不提这个能力」，真正的闸门在 imageSceneFor。

上游
    windking 中转站的 gpt-image-2（OpenAI 兼容 /v1/images/generations）。
    实测：1024x1024 一张约 40~48 秒，$0.01，返回 b64_json + url。

改动
    bridge.js 8 处、mcp-snowluma-safe.js 2 处，每处断言唯一命中，任一不符整份不写盘。
"""
import pathlib
import sys

BRIDGE = pathlib.Path('/opt/qq-bridge/src/bridge.js')
MCP = pathlib.Path('/opt/qq-bridge/src/mcp-snowluma-safe.js')


def sub(text, old, new, label):
    n = text.count(old)
    if n != 1:
        print(f'❌ [{label}] 期望命中 1 处，实际 {n} 处')
        sys.exit(1)
    print(f'   ✓ {label}')
    return text.replace(old, new)


bridge = BRIDGE.read_text(encoding='utf-8')
mcp = MCP.read_text(encoding='utf-8')

# ── 1. 配置默认值 + 全局 turnContext ──────────────────────────────────────
OLD1 = """  cfg.socialV2.mood = {
    enabled: true,
    ...(cfg.socialV2?.mood ?? {})
  };
"""
NEW1 = """  cfg.socialV2.mood = {
    enabled: true,
    ...(cfg.socialV2?.mood ?? {})
  };
  // 生图：整个桥接里唯一「一调用就花真钱」的能力（一张约 $0.01）。
  // 所以默认开着但服务端有闸门（见 imageSceneFor），不是谁喊都能画。
  cfg.socialV2.image = {
    enabled: true,
    baseUrl: 'https://ai.windking.shop/v1',
    model: 'gpt-image-2',
    size: '1024x1024',
    timeoutMs: 180000,
    ...(cfg.socialV2?.image ?? {})
  };

  // 当前这一轮是谁在说话。生图端口靠它判断「这个请求是不是来自正在进行的对话」——
  // 一个已经结束的回合里，不该还能借道调用花钱的工具。
  let turnContext = null;
"""
bridge = sub(bridge, OLD1, NEW1, '配置默认值 + turnContext')

# ── 2. deliverPromptNow 记录本轮上下文 ────────────────────────────────────
OLD2 = """  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
"""
NEW2 = """  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // 「这一轮是谁在说话」——生图闸门要用（见 imageSceneFor）。
    // 不恢复旧值：本来同一时刻只有一个回合在跑，覆盖比栈更诚实。
    turnContext = { key, reason: String(opts.wakeReason || ''), at: Date.now() };
"""
bridge = sub(bridge, OLD2, NEW2, 'deliverPromptNow 记录 turnContext')

# ── 3. 生图函数（插在 saveMoodSafe 之后）──────────────────────────────────
OLD3 = """  function saveMoodSafe(store, label) {
    if (!moodStoreWritable) throw new Error(`${label}库当前为只读（读取失败过），拒绝写入以免覆盖`);
    try {
      writeMood(MOOD_FILE_PATH, store);
    } catch (error) {
      log(`保存${label}失败:`, error?.message ?? error);
      throw error;
    }
  }
"""
NEW3 = OLD3 + """
  /**
   * 生图场景判定 —— 纯函数，不碰 turnContext，所以 prompt 构建阶段也能用。
   *
   * 两种情况能画：
   *   owner-private  主人私聊
   *   owner-group    主人在群里 @ 她 / 叫她名字，且该群两分钟内有主人发言
   *
   * 「两分钟内有主人发言」这一条是防冒名：群友可以改昵称叫「主人」，
   * 但 isOwner 是桥接按 QQ 号判定的，改不了。
   */
  function imageSceneFor(key, reason) {
    const ownerQQ = String(cfg.ownerQQ ?? '');
    if (!ownerQQ) return null;
    if (key === `private:${ownerQQ}`) return 'owner-private';
    if (!key.startsWith('group:')) return null;
    const recent = social.recentMessages.get(key) ?? [];
    const cutoff = Date.now() - 120000;
    const ownerSpoke = recent.some((m) => m && m.isOwner && Number(m.time ?? 0) >= cutoff);
    const r = String(reason || '');
    const byMention = r === 'atMention' || r === 'nameMention' || r === 'question';
    return ownerSpoke && byMention ? 'owner-group' : null;
  }

  /**
   * 路由侧的硬闸门：场景要对，且请求必须来自「正在进行的那个回合」。
   * 两分钟窗口的用处是：回合结束后留一点余量给慢工具调用，但不会被无限期借用。
   */
  function imageAllowedNow(key) {
    const ctx = turnContext;
    if (!ctx || Date.now() - Number(ctx.at || 0) > 120000) {
      return { ok: false, why: '当前没有进行中的对话' };
    }
    if (String(ctx.key) !== String(key)) {
      return { ok: false, why: '这个会话不是当前正在进行的那个' };
    }
    const scene = imageSceneFor(key, String(ctx.reason || ''));
    if (!scene) {
      return { ok: false, why: '只有主人私聊、或主人在群里 @ 你/叫你名字时才能画' };
    }
    return { ok: true, scene };
  }

  /**
   * 真去画。同步落一份本地副本 —— 上游给的 url 是别人站点的，过期就没了，
   * 她要回看或者转发都得有自己的原件。
   */
  async function generateImageNow({ prompt, size }) {
    const imageCfg = cfg.socialV2?.image ?? {};
    const baseUrl = String(imageCfg.baseUrl || 'https://ai.windking.shop/v1').replace(/\\/+$/, '');
    const model = String(imageCfg.model || 'gpt-image-2');
    const wantSize = String(size || imageCfg.size || '1024x1024');
    const apiKey = String(imageCfg.apiKey || '');
    if (!apiKey) throw new Error('没有配置生图 apiKey（cfg.socialV2.image.apiKey）');
    const ctrl = new AbortController();
    const budget = Math.max(30000, Number(imageCfg.timeoutMs) || 180000);
    const timer = setTimeout(() => ctrl.abort(), budget);
    timer.unref?.();
    let resp;
    try {
      resp = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, prompt, n: 1, size: wantSize }),
        signal: ctrl.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`上游 ${Math.round(budget / 1000)} 秒没画完`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const raw = await resp.text();
    if (!resp.ok) throw new Error(`上游 ${resp.status}：${raw.slice(0, 300)}`);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error('上游返回的不是 JSON');
    }
    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!item) throw new Error('上游没有返回图片');
    let savedPath = '';
    try {
      const dir = path.join(STATE_DIR, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(dir, `img-${stamp}.png`);
      if (typeof item.b64_json === 'string' && item.b64_json) {
        fs.writeFileSync(target, Buffer.from(item.b64_json, 'base64'), { mode: 0o600 });
        savedPath = target;
      } else if (typeof item.url === 'string' && item.url) {
        const dl = await fetch(item.url);
        if (dl.ok) {
          fs.writeFileSync(target, Buffer.from(await dl.arrayBuffer()), { mode: 0o600 });
          savedPath = target;
        }
      }
    } catch (error) {
      log(`[reserved2] 生图落盘失败：${error?.message ?? error}`);
    }
    log(`[reserved2] 生图完成：${String(prompt).slice(0, 40)}${savedPath ? ' → ' + savedPath : ''}`);
    return {
      url: typeof item.url === 'string' ? item.url : '',
      path: savedPath,
      revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : '',
      model,
      size: wantSize
    };
  }
"""
bridge = sub(bridge, OLD3, NEW3, '生图函数')

# ── 4. HTTP 路由（插在情绪路由之后）───────────────────────────────────────
OLD4 = """          } catch (error) {
            sendJson({ ok: false, error: '情绪操作失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }
"""
NEW4 = OLD4 + """
        // ── 生图：只有主人能让她画 ──────────────────────────────────────────
        // 权限在服务端：prompt 里不提这个能力只是第一道，真正的闸门是 imageAllowedNow。
        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/image') {
          try {
            const q = url.searchParams;
            const body = req.method === 'POST' ? await readBody() : {};
            const key = String(body.key ?? q.get('key') ?? '').trim();
            const action = String(body.action ?? q.get('action') ?? 'generate').trim();
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (req.headers['x-agent-token'] && !v2ToolEnabled('image')) { sendJson({ ok: false, error: '工具未启用：qq_generate_image' }, 403); return; }
            if (cfg.socialV2?.image?.enabled === false) { sendJson({ ok: false, error: 'qq_generate_image 已在配置里关闭' }, 403); return; }

            const permit = imageAllowedNow(key);
            if (!permit.ok) { sendJson({ ok: false, error: permit.why }, 403); return; }

            if (action === 'status') {
              sendJson({
                ok: true, key, action, scene: permit.scene,
                model: cfg.socialV2?.image?.model ?? 'gpt-image-2',
                size: cfg.socialV2?.image?.size ?? '1024x1024'
              });
              return;
            }
            if (action !== 'generate') {
              sendJson({ ok: false, error: '不认识的 action：' + action + '（可用 generate / status）' }, 400);
              return;
            }
            const prompt = String(body.prompt ?? '').trim();
            if (!prompt) { sendJson({ ok: false, error: 'prompt 不能为空' }, 400); return; }
            if (prompt.length > 2000) { sendJson({ ok: false, error: 'prompt 太长（上限 2000 字）' }, 400); return; }
            log(`[reserved2] 生图请求（${permit.scene}，${key}）：${prompt.slice(0, 60)}`);
            const result = await generateImageNow({ prompt, size: body.size });
            sendJson({ ok: true, key, action, scene: permit.scene, ...result });
          } catch (error) {
            sendJson({ ok: false, error: '生图失败：' + (error?.message ?? error) }, 500);
          }
          return;
        }
"""
bridge = sub(bridge, OLD4, NEW4, '生图路由')

# ── 5. prompt：满足条件才提这个能力 ───────────────────────────────────────
OLD5 = """    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + wakeLine + memoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;
"""
NEW5 = """    // 生图：不满足条件时一个字都不提。不提她就不会调，调了服务端也会拒。
    let imageLine = '';
    if (cfg.socialV2?.image?.enabled !== false) {
      const scene = imageSceneFor(key, reason);
      if (scene === 'owner-private') {
        imageLine = '【画画】主人私聊里想要图就用 qq_generate_image（prompt 写清要什么）。一张约 40 秒、花 $0.01，别连着画。画完会给你 url 和本地路径，发给他就行。\\n\\n';
      } else if (scene === 'owner-group') {
        imageLine = '【画画】刚才主人 @ 了你，如果他是在要图，就用 qq_generate_image（prompt 写清要什么）。一张约 40 秒、$0.01，别连着画。没要图就别主动画。\\n\\n';
      }
    }
    const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + imageLine + wakeLine + memoryLine + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine;
"""
bridge = sub(bridge, OLD5, NEW5, 'prompt 注入 imageLine')

# ── 6. 工具清单 ───────────────────────────────────────────────────────────
OLD6 = """            memoryUpdate: 'qq_memory_update',
"""
NEW6 = """            memoryUpdate: 'qq_memory_update',
            image: 'qq_generate_image',
"""
bridge = sub(bridge, OLD6, NEW6, 'qq_get_prompt 工具清单')

# ── 7. MCP 开关表 ─────────────────────────────────────────────────────────
OLD7 = """  qq_mood: 'mood',
"""
NEW7 = """  qq_mood: 'mood',
  qq_generate_image: 'image',
"""
mcp = sub(mcp, OLD7, NEW7, 'MCP 开关表')

# ── 8. MCP 工具定义 ───────────────────────────────────────────────────────
OLD8 = """// MARKER: schedule-portrait
"""
NEW8 = """server.tool(
  'qq_generate_image',
  '画一张图。只有主人私聊、或主人在群里 @ 你/叫你名字时才能用（其余场景服务端会拒绝，别硬试）。prompt 写清要什么：主体、风格、构图、色调。一张约 40 秒、花 $0.01，别连着画。返回 url（会过期）和本地路径（长期保留）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    prompt: z.string().describe('画面描述：要什么、什么风格、什么构图'),
    size: z.string().optional().describe('尺寸，默认 1024x1024')
  },
  async ({ key, token, prompt, size }) => {
    try {
      const data = await agentApi('/api/socialV2/image', {
        method: 'POST',
        body: JSON.stringify({ key, token, action: 'generate', prompt, size }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: '生图失败：' + (error?.message ?? error) }], isError: true };
    }
  }
);

// MARKER: schedule-portrait
"""
mcp = sub(mcp, OLD8, NEW8, 'MCP 工具定义')

BRIDGE.write_text(bridge, encoding='utf-8')
MCP.write_text(mcp, encoding='utf-8')
print('✅ bridge.js 改 6 处、mcp-snowluma-safe.js 改 2 处，全部命中')
