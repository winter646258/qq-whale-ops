import { voiceSendRoutes } from './send.js';

// ── 语音库列表：GET /api/socialV2/voices（别名 GET /api/voice/list）────
//
// 原来是 if 链里一条 44 行、挂两个路径的 if。它的鉴权是**双通道**，和别的族不一样，
// 搬的时候逐条对齐：
//   agentCall = 请求带 x-agent-token
//     → voice.enabled 必须开、key 必填、token 得是这个会话的、
//       会话得在当前模式允许范围内、qq_send_voice 工具得没被关
//   操作者（控制台）
//     → 以上全不校验，还能看到真实 dir
//
// **脱敏要点**：AI 通道下 `dir` 字段要置空，且 hint 文案里也绝不能插值 voice.dir
// —— 老代码在这里踩过一次：`dir` 抑制了，但 hint 模板里无条件插了 `voice.dir`，
// 等于从旁边的字段又漏出去一次绝对路径。改动这一段时两处一起看。
//
// `probe=0` 可以跳过逐个文件的转码探测（大库时快很多）。

async function listVoices({ req, url, sendJson }) {
  const ctx = this.ctx;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const voice = ctx.voiceCfg();
  const agentCall = Boolean(req.headers['x-agent-token']);
  // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
  if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
  if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (agentCall && !ctx.agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
  if (agentCall && !ctx.v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
  if (agentCall && !ctx.v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }

  const wantProbe = url.searchParams.get('probe') !== '0';
  const v = ctx.voiceHelpers;
  try {
    const files = v.listAudioFiles(voice.dir);
    const items = [];
    for (const f of files.slice(0, 100)) {
      const entry = { name: v.path.relative(voice.dir, f).split(v.path.sep).join('/') };
      if (wantProbe) {
        const info = await v.inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
        entry.ok = info.ok;
        entry.bytes = info.size;
        entry.detail = info.ok ? v.describeAudio(info) : null;
        entry.seconds = info.duration ?? null;
        if (!info.ok) entry.error = info.error;
      }
      items.push(entry);
    }
    sendJson({
      ok: true,
      key: key || null,
      dir: agentCall ? undefined : voice.dir,
      count: items.length,
      voices: items,
      limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
      // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏。
      hint: items.length
        ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
        : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`),
    });
  } catch (error) {
    sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
  }
}

const inject = [
  'cfg', 'log', 'voiceCfg', 'voiceHelpers', 'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
  // 阶段15：发送通道（send.js）额外要的
  'path', 'appendActivity', 'voiceSendHelpers',
];

const routes = [
  { method: 'GET', path: '/api/socialV2/voices', kind: 'exact', handler: listVoices },
  { method: 'GET', path: '/api/voice/list', kind: 'exact', handler: listVoices },
  // 阶段15：操作者通道的语音发送 + /api/send/voice 别名，见 send.js
  ...voiceSendRoutes,
];

export default { name: 'voice', title: '语音库列表 + 操作者发送', inject, routes };
