// ── 语音发送（操作者通道 /api/voice/send + 别名 /api/send/voice）─────────────
//
// 原先挂在 main() 的 if 链里（缩进 8），条件是
// `req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')`。
//
// 通道划分（搬家时原样保留，别搞混）：
//   · 操作者通道（CLI / 控制台面板）：由集中闸门的控制台令牌鉴权，这里**不再校验**；
//     socialV2.voice.enabled 只表示「AI 能不能发语音」，不该把手动试发一起关掉。
//   · AI 通道：/api/send/voice 带 agent token 时一律 403，让它改用
//     /api/socialV2/send-voice（带 key + token），避免借用操作者通道绕过会话限制。
//
// 白名单（modeAllowed）+ 语音限流（voiceBudgetCheck/Commit）+ 文件名审计一个都不少。
//
// 语音库列表（/api/socialV2/voices、/api/voice/list）在阶段10 就搬进来了，
// 这个文件是它的另一半；index.js 把两边合成一个 voice 模块。
//
// 契约提醒：send-voice-lib.js 的纯函数（parseTargetKey / 当前音量处理参数）挂在
// voiceSendHelpers 上，不挂在 voiceHelpers —— 后者是 voice/index.js 里的 listVoices
// 在用的那一套（listAudioFiles / inspectAudio / describeAudio / escapeCqText / text）。
// 两套名字很接近，写错会得到 h.parseTargetKey is not a function 这种运行期 500。

async function handle({ req, url, sendJson, readBody }) {
  const { cfg, log, path, appendActivity, voiceCfg } = this.ctx;
  const h = this.ctx.voiceHelpers;
  const v = this.ctx.voiceSendHelpers;

  // AI 借用操作者通道的判断只看 header，不必先读 body。
  const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
  if (url.pathname === '/api/send/voice' && agentToken) {
    sendJson({ ok: false, error: 'AI 请改用 /api/socialV2/send-voice（带 key + token）' }, 403);
    return;
  }

  const body = (await readBody()) ?? {};
  const voice = voiceCfg();
  const key = String(body.target ?? body.key ?? '').trim();
  const parsedTarget = v.parseTargetKey(key);
  if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
  if (!v.modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, v.currentMode())) {
    const a = cfg.allow ?? {};
    sendJson({
      ok: false,
      error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
    }, 403);
    return;
  }
  let resolved;
  try {
    resolved = v.resolveVoicePathForOperator(body.file ?? body.path ?? '');
  } catch (error) {
    sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
    return;
  }
  // 音量参数先校验（写错了当场说，不要等到真发的时候才炸）
  try {
    v.resolveAudioProcessing({
      volume: body.volume ?? voice.defaultVolume,
      normalize: body.normalize === true,
      loudness: body.loudness ?? voice.loudness
    });
  } catch (error) {
    sendJson({ ok: false, error: error.message }, 400);
    return;
  }
  const probe = await h.inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
  if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
  const preview = {
    key,
    file: resolved.path,
    via: resolved.via,
    bytes: probe.size,
    duration: probe.duration,
    codec: probe.codec,
    detail: h.describeAudio(probe),
    warnings: probe.warnings ?? [],
    limits: {
      maxSeconds: voice.maxSeconds,
      maxBytes: voice.maxBytes,
      maxPerMinute: voice.maxPerMinute,
      maxPerHour: voice.maxPerHour
    }
  };
  if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }

  const now = Date.now();
  try {
    v.voiceBudgetCheck('operator:cli', voice);
    const sent = await v.sendVoiceV2(key, resolved.path, {
      guard: false,
      audit: true,
      audio: {
        volume: body.volume ?? voice.defaultVolume,
        normalize: body.normalize === true,
        loudness: body.loudness ?? voice.loudness
      }
    });
    v.voiceBudgetCommit('operator:cli', now);
    log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}，messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    // CLI 默认要落地校验；readback 仅在做「收到的语音」实验时才用。
    const verification = body.verify === false ? null : await v.verifyVoiceMessageSent(sent.messageId);
    let readbackText = null;
    if (body.readback === true && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const rb = await res.json().catch(() => ({}));
        if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
      } catch (error) {
        log(`[voice] 转写回读失败：${error?.message ?? error}`);
      }
    }
    sendJson({
      ok: true,
      ...preview,
      messageId: sent.messageId,
      verified: verification?.confirmed === true,
      readback: readbackText,
      audioProcessing: sent.audioProcessing,
      volume: sent.volume,
      loudness: sent.loudness
    });
  } catch (error) {
    // 透传 statusCode：bridge 的兜底 catch 就是认它，不认的话一律变 500。
    sendJson({ ok: false, error: error?.message ?? String(error) }, Number(error?.statusCode) || 500);
  }
}

export const voiceSendRoutes = [
  { method: 'POST', path: '/api/voice/send', kind: 'exact', handler: handle },
  // 别名，同时是 AI 工具入口（带 agent token 时在 handler 里 403）
  { method: 'POST', path: '/api/send/voice', kind: 'exact', handler: handle },
];
