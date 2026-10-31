// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node src/bridge.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from './preset-prompt.js';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from './role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from './dsh-client.js';
import { extractMemories, scopeForText } from './auto-memory.js';
import { mdToPlain, repairSurrogates, splitForQQ, truncateText, truncateTextTail } from './md-to-plain.js';
// MARKER: untrusted-group
import { GROUP_RULES, inspectUntrusted, sanitizeGroupText, untrustedCfg } from './untrusted.js';

import { createBlipTracker } from './upstream-blip.js'; // MARKER: upstream-blip-import
import { SENSITIVE_RE } from './sensitive.js';
import { looksLikeUnfinished } from './v2-wait.js';
import { compactModelMessage, describeAge } from './qq-model-view.js';
import { safeFetchBuffer, safeFetchRaw, looksLikeImageBuffer } from './safe-fetch.js';
import { normalizeImageForModel } from './media-normalize.js';
// MARKER: video-seg
// 视频抽帧拼图：把视频变成几张带时序的拼图，再走图片那条现成管线。
import { normalizeVideoForModel } from './video-frames.js';
import { createBiliDirect } from './bili-direct.js';
import { WATCH_DEFAULTS, watchBiliVideo } from './bili-watch.js';
import { browseRound, browsePromptLine, readBrowse, writeBrowse } from './bili-browse.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from './send-voice-lib.js';
import { TTS_DEFAULTS as TTS_DEF, readEnvValue as readTtsEnvValue, splitSpeechText as splitTtsText, synthesize as ttsSynthesize, downloadTtsAudio as ttsDownload } from './tts.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from './snowluma-conn.js';
import { hardenDir, manualDirCommand } from './state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from './forward.js';
// MARKER: diary-jsonl
// 日记改 jsonl：Markdown 的「正文里出现 - 开头就破坏结构」是真隐患，
// 而且旧实现的时间戳是 UTC（差 8 小时）。纯逻辑在 diary-store.js，带单测。
import {
  DIARY_JSONL, DIARY_LEGACY_MD, MAX_ENTRIES as DIARY_MAX_ENTRIES,
  MAX_TEXT_CHARS as DIARY_MAX_TEXT, MAX_MOOD_CHARS as DIARY_MAX_MOOD,
  MAX_BYTES as DIARY_MAX_BYTES,
  readDiary, writeDiary, appendDiaryEntry, updateDiaryEntry, removeDiaryEntry,
  recentDiary, recallDiary, diaryDays, diaryStats, parseLegacyMarkdown, localStamp,
  normalizeLevel, daysSinceLast, DEFAULT_LEVEL, LEVEL_LABELS, setDiaryArt, countArtInDay} from './diary-store.js';
import { artCfg, artAllowed, artFileName, buildArtPrompt, shouldSendArt } from './diary-art.js';
import { artUrlFor, bookItems, bookMonths, bookSummary, resolveArtFile } from './diary-book.js';
// MARKER: diary-book-import
// MARKER: diary-art-import
import { resolvePriceTable } from './model-prices.js';
import { createTokenLedger } from './token-ledger.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  detectTeachings,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  promoteSlangEntries,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES,
  resolveSlangCap
} from './slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from './sticker-lib.js';
// MARKER: schedule-portrait
// 日程（短期记忆）与画像（长期认识）：纯逻辑在各自模块里，桥接只负责接线。
// 规格要求「系统只做两件事：给工具、给事实」—— 这两个模块里刻意没有任何
// 「按天数自动糊 / 观察 N 次自动升级」的规则：什么时候糊、什么时候删、
// 要不要加固，全部由角色自己调工具决定。
import {
  loadSchedule, saveSchedule, addEntry as addScheduleEntry,
  updateEntry as updateScheduleEntry, removeEntry as removeScheduleEntry,
  querySchedule, formatScheduleForPrompt, shouldReviewToday, markReviewed,
  revealOriginal as revealScheduleOriginal
} from './schedule-store.js';
import {
  loadPortrait, savePortrait, addPortrait, updatePortrait, removePortrait,
  queryPortrait, listSubjects, formatPortraitForPrompt,
  revealOriginal as revealPortraitOriginal
} from './portrait-store.js';
// 情绪：此刻的心情、长期底色、压着没说的事。纯逻辑在 mood-store.js，带单测。
import {
  readMood, writeMood, createDefaultMood, describeMood, setMood,
  ventUndercurrent, resolveUndercurrent, setBaseline, moodStats, recordMoodSample, settleBaseline,
  MOOD_FILE as MOOD_STORE_FILE
} from './mood-store.js';

// MARKER: diary-daily-import
import { dailyCfg as dailyDiaryCfg, decideDailyDiary, normalizeDraft as normalizeDiaryDraft, isDraftFresh, draftLine as diaryDraftLine, eveningDue, draftCfg } from './diary-daily.js';

// MARKER: slang-research-on-demand-import
import { pickResearchCandidates, quotaFor, researchCfg } from './slang-research.js';
import { LEARNER_RETRY_NUDGE, learnerOutcome } from './learner-retry.js';
// 生图流式读取 + 分段探测：非流式时上游画完之前连接上一个字节都没有，中间层 35~40 秒就把
// 空闲连接掐掉（2026-10-28 18:19 那次 38 秒的 terminated）。纯逻辑在 image-stream.js，带单测。
// MARKER: image-stream-import
import { readImageStream } from './image-stream.js';
// 节奏层：什么时候叫醒她、回复后跳几次、主动间隔。纯逻辑在 pacing.js，带单测。
// MARKER: pacing-import
import { pacingCfg, rhythmOf, skipDecision, urgeDelay } from './pacing.js';
import { prepareQzoneImages } from './qzone-image.js';
// 结算层：回合收工之后另起一个安静的小回合，把情绪和印象写回库里。纯逻辑在 settle.js。
// MARKER: settle-import
import {
  buildSettlePrompt,
  resolveImpressionWho, parseSettleJSON, pickSettleMessages, planSettleWrites, settleCfg, shouldSettle
} from './settle.js';
// MARKER: world-life-import
// 世界层 §3.1/§3.3：她自己的日子（life.json）与心情编年史（mood-days.json）。
// 纯逻辑在 life.js / mood-days.js，各自带单测；bridge 只负责存盘、注入、结算接线。
import {
  buildLifeAsk, lifeCfg, lifeDayFor, lifeLineFor, normalizeLifePlan, setLifeDay, summarizeLifeDay
} from './life.js';
// MARKER: session-rotate-import
import { ROTATE_DEFAULTS, kindOfKey, localDayOf as rotateDayOf, pruneRotateDays, rotateCfg, rotateLine, shouldRotate } from './session-rotate.js';
import { buildContinuityAsk, composeContinuityText, continuityCfg, continuityLine, dayOf, markContinuityUsed, parseContinuityJSON, pickContinuityLines, pruneContinuity } from './continuity.js';
import { archivePath, clampDays, decodeLine, encodeRecord, formatRecall, historyCfg, monthOf, queryArchive, toRecord } from './history-archive.js';
// MARKER: life-timeline-import
// 世界层 §4 生活线：world.json（她的住处/作息/日程模式）+ life-timeline.js（今天每一格）。
// 世界层只当数据库用，不进提示词的只有世界本身；进提示词的是「此刻那一格」。
import { homeBrief, readWorld } from './world.js';
import { riceEchoLine } from './speech-habit.js';
import { attentionOf, ensureDay, lifeMomentLine, readTimeline } from './life-timeline.js';
// MARKER: world-events-import
// 世界会自己往外冒事：按天物化一份事件账本，只给已经发生的。
// 默认 inject:false（影子模式）—— 只生成、只记日志，一个字都不进提示词。
import {
  buildDay as buildWorldEventsDay,
  describeForLog as describeWorldEvents,
  ensureDay as ensureWorldEventsDay,
  eventsCfg as worldEventsCfg,
  eventsLine as worldEventsLine,
  readEvents
} from './world-events.js';
// MARKER: willingness-import
import {
  consumeWillingness,
  describeWillingness,
  evaluateWillingness,
  isForcedReason,
  resolveWillingness,
  WILLINGNESS_DEFAULTS
} from './willingness.js';
import { moodDaysCfg, moodTrendLine, pruneMoodDays, recordMoodDay } from './mood-days.js';
import { buildThreadsAsk, threadsCfg, threadsLine, summarizeThreads, addThreads, dueThreads, markAsked, pruneThreads, resolveThreads } from './threads.js';
import { buildWishesAsk, wishesCfg, wishesLine, summarizeWishes, addWishes, completeWishes, pruneWishes } from './wishes.js';
import { addDates, buildDatesAsk, datesCfg, datesLine, summarizeDates } from './dates.js';
// MARKER: world-c2-topics-import
import {
  TOPICS_DEFAULTS as TOPICS_DEFAULTS_C2,
  topicsCfg,
  dueTopicSlot,
  markTopicSlot,
  addTopics,
  pruneTopics,
  topicsLine,
  summarizeTopics,
  buildTopicAsk,
  parseTopicJSON,
  localDayOf as topicsDayOf
} from './topics.js';
// MARKER: selfie-import
import { selfieCfg, buildSelfiePrompt, selfieQuota } from './selfie.js';
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
} from './shared-memory-store.js';

// MARKER: share-signal
// 主动报告：她自己在群里判断「这件事值得跟主人说一句」，再由桥接按冷却与退避
// 决定什么时候真的说。判断逻辑在 share-signal-store.js，纯逻辑带单测。
import {
  loadShareState, saveShareState, addSignal, settleDeliveries, pruneState,
  canDeliver, markDelivered, lastDelivery, noteOwnerReply as noteShareOwnerReply,
  setPolicy as setSharePolicy, statsOf as shareStatsOf, normalizePolicy as normalizeSharePolicy,
  effectiveIntervalMs, isGroupKey,
  UNANSWERED_THRESHOLD, MAX_SIGNALS as SHARE_MAX_SIGNALS,
  HARD_MIN_INTERVAL_MS as SHARE_HARD_MIN_INTERVAL_MS,
  HARD_MAX_PER_DAY as SHARE_HARD_MAX_PER_DAY
} from './share-signal-store.js';

// MARKER: group-digest
// 群聊近况（D：主人问起才给）+ 睡眠整合（每天 4 点后她第一次醒来时回顾）。
// 纯逻辑在 group-digest-store.js，这里只负责取数据、拼句子、记账。
import {
  asksAboutGroups,
  pickGroupFor,
  formatGroupDigest,
  listGroupCandidates,
  shouldSleepReview,
  markSleepReviewed,
  formatSleepReviewMaterial,
  localDayOf
} from './group-digest-store.js';

// MARKER: affinity
// 好感度：按会话各存一份（不再共用 mood-store 里那个全局单值）。
// 只注入 note 原文不注入数字；只在她长期没动过时提醒，不自动打分。
import {
  getAffinity,
  setAffinity as setAffinityByKey,
  shouldNudgeAffinity,
  formatAffinityLine,
  formatAffinityNudge,
  loadAffinityState,
  saveAffinityState,
  normalizeAffinityKey
} from './affinity-store.js';

// MARKER: image-approval-import
// 生图审批：好友私聊要图先问主人。状态机在 image-approval-store.js（纯逻辑），
// 这里只负责接 QQ 和落盘。
import {
  createApproval as createImageApproval,
  approveApproval as approveImageApproval,
  rejectApproval as rejectImageApproval,
  pickPendingToDecide as pickImageApprovalToDecide,
  listPending as listPendingImageApprovals,
  pendingCount as pendingImageApprovalCount,
  expireStale as expireStaleImageApprovals,
  statsOf as imageApprovalStatsOf,
  loadApprovalState as loadImageApprovalState,
  saveApprovalState as saveImageApprovalState,
  createDefaultState as createDefaultImageApprovalState,
  APPROVAL_TTL_MS as IMAGE_APPROVAL_TTL_MS,
  MAX_PROMPT_CHARS as IMAGE_APPROVAL_MAX_PROMPT
} from './image-approval-store.js';

// MARKER: phone-bridge-import
import { PhoneBridge } from './phone-bridge.js';
import { BiliClient, describeBiliResult, describePhoneOffline } from './site-bili.js';
// MARKER: spotify-import
import { SpotifyClient, SecretBox } from './spotify-client.js';
// MARKER: modules-import
// 功能模块装载器（阶段 1：只建骨架，模块清单还是空的）。
// 装载失败不该连累 24/7 主进程，所以装载处用 try 兜住，失败只降级为「没有模块」。
import { createModuleHost } from './modules/registry.js';
import { defineModules } from './modules/index.js';
import { initSightings, readSightings, recordSightings } from './sticker-sightings.js';
// MARKER: sticker-learn-import
import { buildLearnRemark, buildRecentIndex, learnQuota, pickLearnCandidates, recordLearnAttempt } from './sticker-learn.js';
// MARKER: bili-import

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// TTS 的 key 放在仓库根的 .env（600，不入 git），代码自己读，不依赖 systemd。
const TTS_ENV_PATH = path.resolve('.env');
let ttsEnvText = '';
try { if (fs.existsSync(TTS_ENV_PATH)) ttsEnvText = fs.readFileSync(TTS_ENV_PATH, 'utf8'); } catch { ttsEnvText = ''; }
const STATE_DIR = path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SLANG_RESEARCH_SESSION_FILE = path.join(STATE_DIR, 'slang-research-session.json');  // MARKER: slang-research-session
const SOCIAL_V2_FILE = path.join(STATE_DIR, 'social-v2.json');
// 日程与画像单独存文件：不塞进 social-v2.json，避免那个文件继续膨胀
// （它已经 360KB，每轮状态读写都受它拖累），也不会因为会话状态损坏而连带丢失。
const SCHEDULE_FILE = path.join(STATE_DIR, 'schedule.json');
const PORTRAIT_FILE = path.join(STATE_DIR, 'portrait.json');
const MOOD_FILE_PATH = path.join(STATE_DIR, MOOD_STORE_FILE);
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
// MARKER: shared-memory-file

const SHARE_SIGNAL_FILE = path.join(STATE_DIR, 'share-signal.json');

// MARKER: group-digest-file
// 睡眠回顾的「今天做过没」记账（{ reviewDays: { [key]: 'YYYY-MM-DD' } }）。
const SLEEP_REVIEW_FILE = path.join(STATE_DIR, 'sleep-review.json');
const DIARY_DAILY_FILE = path.join(STATE_DIR, 'diary-daily.json');

// MARKER: affinity-file
const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');  // MARKER: share-signal-file
// MARKER: image-approval-file
const IMAGE_APPROVAL_FILE = path.join(STATE_DIR, 'image-approval.json');

// MARKER: phone-bridge-file
// 浏览器扩展的访问令牌。首次启动自动生成，改这个文件后重启生效。
const PHONE_TOKEN_FILE = path.join(STATE_DIR, 'phone-token');
const SHARED_MEMORY_FILE = path.join(STATE_DIR, 'shared-memory.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（QSH_PLAN.md §2.1：对用户只暴露 `closed-agent` / `simulation`），
 * `chat` / `reserved` / `reserved2` 是历史拼写 —— 必须继续被**接受**（线上桥接持久化的全局值
 * 就是 `reserved2`），但进程内部一律用历史拼写存储与比较：`currentMode === 'reserved2'` 这类
 * 判断遍布发送闸门、定时器与 preset 解析，把规范名直接塞进 `currentMode` 会让它们全部变成假。
 *
 * 旧写法是 `VALID_MODES = ['chat','closed-agent','reserved','reserved2']`，控制台那处还抄了
 * 一份同样的字面量数组。后果是：在 DSH 设置或 `state/mode.json` 里写 `simulation` 会被**静默
 * 忽略**，`currentMode` 保持上一次的值（进程刚起来时是 `chat`，即一代仿真 —— preset 与工具面
 * 都和二代不同，`v2ToolEnabled` 之类的闸门也不生效）。用户以为切到了仿真，实际跑的是另一套，
 * 而且没有任何日志。规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  reserved2: 'reserved2',
  simulation: 'reserved2',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

// 读取 JSON 文件并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
// required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.socialV2` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

/**
 * 原子替换：`fs.renameSync` 覆盖一个「正被别人打开」的目标，在 Windows 上会抛 EPERM
 * （Defender / 编辑器 / 资源管理器预览 / 云同步都可能在这个窗口里碰它）。
 * 实测本机可复现。这里退避重试几次；实在不行才抛，让调用方决定怎么提示。
 */
function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等一小会儿：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

// 原子写 JSON 文件：先写唯一临时文件再 rename，避免进程中断写坏配置，也避免固定临时名被并发/符号链接攻击利用。
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    // 失败时别把随机名临时文件留在 state/ 里当垃圾。
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 原子写文本文件。
function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    // fromFile 只用于让启动日志说清「这是沿用的、不是刚换的」：
    // 令牌在多次重启之间是**稳定**的，旧文案一律写「已自动生成」会让人误以为凭据失效。
    if (existing) return { token: existing, fromFile: true };
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return { token, fromFile: false };
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `src/state-acl.mjs`（与 scripts/harden-state-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'roles'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = roles/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'roles');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 6000（沿用历史值，是每条约 4~6k token 的成本护栏），可用 config.json 的
// role.maxInjectChars 调整（1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 6000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;

// ── 好友列表缓存（用于「好友都能聊、主动只限白名单」的两级准入）──────────────
// 由 SnowLuma 的 get_friend_list 定时刷新（默认 1 分钟）。未就绪时 friendSetReady=false，
// 此时"仅好友"策略一律 fail-closed（不放行任何人），避免启动瞬间误收陌生人消息。
let friendSet = new Set();
// 供 handleIncoming 在「非好友发来消息」时触发一次立刻补拉（刚加好友的窗口期兜底）
let friendRefreshNow = null;
let friendSetReady = false;
let friendSetAt = 0;
const FRIEND_REFRESH_MS = 60 * 1000;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：roles/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'v2', allowCjkSpaces = true) {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'v1' ? stats.v1 : stats.v2;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (GEN1_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含一代仿真专用指令（[SILENT] / 空格分句 / 自动转发…），二代下这些行会被兜底过滤——建议把它们移到带 〔一代〕 标记的小节里');
  }
  // 二代已改用工具数组分条，示例里的中文空格只是普通字符；只有显式关掉
  // 顶层 role.allowCjkSpaces=false 时才会被改写成逗号，这时才值得提醒。
  if (!allowCjkSpaces && /回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（已设 role.allowCjkSpaces=false），建议直接写逗号，或把该节标记为 〔一代〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔一代〕/〔二代〕 标记筛过）
        injectedV1: Math.min(stats.v1, roleInjectMaxChars),
        injectedV2: Math.min(stats.v2, roleInjectMaxChars),
        charsV1: stats.v1,
        charsV2: stats.v2,
        hasModeTags: stats.v1Only > 0 || stats.v2Only > 0,
        truncated: stats.v1 > roleInjectMaxChars || stats.v2 > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedV1: 0, injectedV2: 0, charsV1: 0, charsV2: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 二代仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = roles/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两代仿真各自有独立的预设提示词：一代 qq-chat（空格分条 / [SILENT]），
// 二代 qq-chat-v2（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { v1: 'qq-chat', v2: 'qq-chat-v2' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

function presetSourceYaml(name) {
  return path.join(ROOT, 'dsh', 'agent-presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat-v2，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.v1 ? '一代仿真（reserved）' : '二代仿真（reserved2）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的二代 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上一代」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/socialV2/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上一代（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两代之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// MARKER: panel-model-cache
// DSH 的 session/modelCatalog 实测要 3 秒以上，旧版 3 秒超时必然 fallback，
// 面板的模型下拉因此永远拿不到目录。这里放宽到 8 秒，并缓存 10 分钟：
// 控制台每次刷新都会打 /api/dsh/model，不缓存等于每刷新一次就戳一次 DSH。
const MODEL_CATALOG_TIMEOUT_MS = 8000;
const MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
let modelCatalogCache = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
// 各渠道的档位 id 并不统一：deepseek-official/buddy 是 low/high/max，Loomy 是
// none/low/medium/high/xhigh，Raccoon 是 on/off，trae 是 light/high/extra_high。
// 旧白名单只有 low/high/max，会把 config.json 里合法的渠道档位判成非法、静默回退成
// max，接着让每条消息的 selectModel 都失败。这里放宽成已知档位的并集；真正的合法性
// 由 DSH 的模型目录裁决（非法档位会在 selectModel 报错并写日志），不再由桥接替它猜。
const REASONING_EFFORT_OPTIONS = ['none', 'off', 'on', 'light', 'low', 'medium', 'high', 'xhigh', 'extra_high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 读取角色/模式状态：{"role": "傲娇助手", "mode": "active"|"silent"}
function readRoleState() {
  return readJsonSafe(ROLE_STATE_FILE, { role: null, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  const file = readJsonSafe(p, null, true);
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`配置格式错误：${p}`);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    // 仅好友档位：私聊场景下任何好友都能发起会话（主动找人仍受 allow 白名单限制）。
    // 必须在这里归一化，否则 cfg.friendOnly 恒为 undefined，allowed() 里的判定永不成立。
    friendOnly: file.friendOnly === true,
    // MARKER: spotify-cfg
    // Spotify 只读（搜索/正在播放/歌单/收藏）。loadConfig 是白名单式，未逐项列出的顶层段会被丢弃，
    // 所以必须显式透传，否则 cfg.spotify 恒为 undefined，spotifyClient() 会一直报「还没配置」。
    spotify: file.spotify ?? null,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 价目表覆盖项（可选）。留空即用 src/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    socialV2: {
      enabled: true,
      autoReplyCheckMs: 30000,
      // 群聊专用的「说完话回来检查」间隔（可选）。不配则回退全局。
      autoReplyCheckMsInGroup: null,
      agentPreset: 'qq-chat-v2',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        // MARKER: ghosttool：update 单独开一个开关（默认开，与 memory 一致）
        memoryUpdate: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        getSelfImage: true,
        schedule: true,
        portrait: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 90000,           // 默认沉睡前至少等待/观察 90 秒（后台可调）
        // 原来写 5 分钟：群里 1~2 分钟就有人说话，5 分钟窗口永远等不到，preSleepWaitSatisfied 恒为 false，
        // 模型据此以为「不能睡」，于是反复 wait 到天荒地老。90 秒才有概率满足。
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', '大肥鱼', '鲸鱼'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '想潜水就调 qq_wait_for_messages(timeoutMs=90000) 等一次。等完不管 satisfied 是真是假都可以直接设 sleepUntil 睡'
          + '——satisfied 只表示群里确实安静过一阵，不是睡觉的前置条件。有人说话但你不想接，也可以直接睡，不用继续等。'
          + '潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。'
          + '需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        // 群聊专用唤醒上限（可选）。不配则回退到上面的全局值。
        // 群聊通常更热闹，需要更慢，但私聊不该被拖慢。
        maxWakePerHourInGroup: null,
        maxWakePerQuarterHour: 0,          // 0 = 不限；默认关，只在群聊开
        maxWakePerQuarterHourInGroup: 2,   // 15 分钟最多 2 条，别 8 分钟把整小时额度烧光
        // 高优先级唤醒（private / atMention / question）是否豁免频率上限。
        // 默认 true：额度只服务弱触发，用户明确叫她永远放行。
        exemptHighPriorityFromLimit: true,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 8,
        maxSendPerHour: 60,
        // 群聊专用阈值（可选）。不配则回退到上面的全局值。
        // 腾讯对群聊骚扰判定比私聊严，作者建议群里放慢。
        maxSendPerMinuteInGroup: null,
        maxSendPerHourInGroup: null,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。',
        // 每轮都注入的断句硬规则（不只走 qq_get_prompt）。
        // 2026-10-24 实测：角色卡里那条「断句用半角空格」只有 atMention/nameMention/private
        // 三类唤醒会注入正文，question/probability/replyCheck/bootstrap 只给「请调用 qq_get_prompt」
        // 的指针，所以她 40 条样本里仍是 90% 逗号、5% 空格。
        // recommendedHint 同理——它只出现在 qq_get_prompt 的 recommended.send 里，不进唤醒提示词。
        // 空字符串 = 关闭这段注入。
        styleHint: '分句用半角空格，不用逗号串长句；一条消息控制在两句以内。三句里带一句语气词（嘛/啦/啊/呢/嘿嘿），别每句都挂。说“我认”时换成“我同意”“我喜欢”“这个不错”。不要电报体，该有的虚词和连接词要有。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 8,      // 提示里最多列出的常用表情数
        allowIds: [],              // 非空时只有这些 id 能进提示词（库来自 QQ 收藏夹，sync 会整库覆盖，所以「只留几张」靠白名单不靠删库）
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 2,         // 每分钟最多收藏次数
          maxPerHour: 10,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3,
        // MARKER: proactive-limits-config
        minIntervalMs: 45 * 60 * 1000,
        maxPerHour: 2,
        quietHours: { start: 23, end: 8 },
        capProbability: 0.5
      },
      // MARKER: turn-budget-config —— 回合硬预算默认值
      turnBudget: {
        maxSteps: 40,        // 单回合工具调用次数上限
        maxMs: 600000,       // 单回合时长上限（10 分钟）
        maxSends: 8,         // 单回合发送条数上限
        // 主人私聊专用放宽（见 turnBudgetCfg 的 owner-turn-budget）。
        // 不写 = 跟全局一致；写了就是「主人至少这么多」，只升不降。
        // ownerMaxSends: 20,
        // ownerMaxMs: 1200000
        // 好友私聊（非主人）的每轮条数放宽（见 friend-turn-budget）。
        // 同样只升不降；不写 = 跟全局一致。
        // privateMaxSends: 8,
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      ...(file.socialV2 ?? {})
    }
  };

  // socialV2.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.socialV2.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    getSelfImage: true,
    sendVoice: false,
    ...(cfg.socialV2.tools ?? {})
  };

  // socialV2.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「二代仿真 → 语音库与语音发送」里打开开关即可。
  cfg.socialV2.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 2,
    maxPerHour: 10,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.socialV2?.voice ?? {})
  };

  // MARKER: willingness-default
  // 意愿门：把「掷一次骰子」换成「攒分再说」。默认开，但只作用于群聊。
  // 深度合并而不是整块覆盖：旧 config.json 里没有这段时也要有默认值。
  cfg.socialV2.wake = {
    ...(cfg.socialV2.wake ?? {}),
    willingness: {
      enabled: true,
      auto: true,
      tier: 'normal',
      maxProbability: 0.92,
      minGapAfterReply: 0,
      ...(cfg.socialV2?.wake?.willingness ?? {})
    }
  };

  // socialV2.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.socialV2.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 8,
    allowIds: [],
    // MARKER: sticker-learn-config
    // 自己学会表情：观测到够多次数的图自动收进库。
    // 为什么要有：sightings 早就记了群里哪些图在反复出现，但没有任何东西去用它，
    // 实测一张都没自动收藏过。
    learn: {
      enabled: true,
      minCount: 3,
      maxPerDay: 5,
      minIntervalMs: 3600000,
      maxPerTick: 2,
      retryAfterMs: 6 * 3600 * 1000,
      remarkMaxChars: 20,
      ...((cfg.socialV2?.sticker?.learn) ?? {})
    },
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    },
    ...(cfg.socialV2?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 2,
      maxPerHour: 10,
      maxRemarkChars: 20,
      ...((cfg.socialV2?.sticker?.collect) ?? {})
    }
  };

  // 日程（短期记忆）：每轮注入的分层文本由 schedule-store 生成。
  // 与 voice/sticker 同一套路做深合并，避免旧 config.json 缺字段时丢默认。
  cfg.socialV2.schedule = {
    enabled: true,
    // 每天一次结算提醒（4 点前不念，免得半夜唠叨）。只在唤醒时提醒，不强制。
    reviewNudgeEnabled: true,
    ...(cfg.socialV2?.schedule ?? {})
  };
  // 画像（长期认识）：跨会话，不按会话隔离（这正是它和 memberImpressions 的区别）。
  cfg.socialV2.portrait = {
    enabled: true,
    ...(cfg.socialV2?.portrait ?? {})
  };
  // 情绪（此刻的心情）：也跨会话 —— 心情不按群分，她在哪儿都是同一个人。
  cfg.socialV2.mood = {
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

  // 当前这一轮是谁在说话 —— 挂在 globalThis 上，因为写读两处跨函数作用域。

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // MARKER: vision-cfg
  // 视觉/转写的模型渠道必须独立于 dsh.provider。
  // 2026-10-30 事故：config.json 里明明写了 vision.provider='our-free-model'，
  // 但代码从来没有把这个块读进 cfg（全文件 0 处 `cfg.vision =`），
  // ensureVisionSession 于是落到 `cfg.dsh.provider`。provider-switch 一降级到
  // loomy/trae/raccoon，dots-studio / nvidia 那两个模型就不在该渠道里，
  // selectModel 返回 session/model-unavailable，两条兜底模型同时挂，识图整条链死。
  // 这里把 vision 正式并入 cfg，并把默认渠道钉死在 our-free-model。
  // providerByModel 允许按模型单独指定渠道（模型名本身带斜杠，不能靠切分猜）。
  cfg.vision = {
    enabled: true,
    provider: 'our-free-model',
    providerByModel: {},
    models: [
      'dots-studio/dots-3-note-preview:free',
      'nvidia/nemotron-3.5-super-vl:free'
    ],
    preset: '',
    timeoutMs: 90000,
    cacheTtlMs: 604800000,
    maxImagesPerMessage: 3,
    ...(file.vision ?? {})
  };
  if (!cfg.vision.providerByModel || typeof cfg.vision.providerByModel !== 'object') {
    cfg.vision.providerByModel = {};
  }

  // 人格卡注入上限（字符）。历史硬编码 6000，现在可配：每条约 4~6k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface':
      case 'marketface':
        out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`);
        break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': out.push('[卡片消息]'); break;
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  // MARKER: surrogate-ingest —— 入站文本统一修一遍孤立代理。
  // 毒从哪来：QQ 侧一条消息里的 emoji 被截成半个，粘进 `[引用 …]` 之后一路带下去。
  // 为什么放在这里：这是所有入站文本的唯一出口（正文 / 引用 / 表情摘要 / 卡片都从这里过），
  // 堵在这一层，social-v2 的 unread、recentMessages、提示词都不会带毒。
  // 之前只在 api.sessions.prompt 出口修，修不了已经落进 DSH 会话历史的那份 ——
  // 2026-10-29 09:52 起的 15 次上游拒绝就是历史回放造成的。
  return repairSurrogates(out.join('').trim());
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供一代自动内联、二代按需工具、控制台/日志使用。
  // ── 表情包 CDN 兜底（MARKER: emoji-cdn） ──────────────────────────────────
  //
  // 市场表情 / 收藏表情**不在网关缓存里**：`get_image` 对它们必然 not found。
  // 唯一稳的取法是按 emoji_id 拼 CDN 地址直接抓。以前只认 get_image，
  // 结果所有表情都取不到字节，模型只能看到一句「[表情包:名字]」。
  function sanitizeMediaSummary(value, max = 60) {
    const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max)}…` : s;
  }

  /** 从 `f9-f96bf2…d93c3530d5eb148f55206fb1.gif` 里抠出 32 位 hex 的 emoji_id。 */
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /**
   * emoji_id → CDN 候选地址。
   *
   * **必须校验成十六进制**：emoji_id 来自对方消息段，直接拼进 URL 等于把
   * 「用户可控字符串 → 服务器出站请求」的洞敞开（SSRF / 任意 URL）。
   */
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    // MARKER: emoji-fields
    // emoji_id / emoji_package_id / key 是表情包唯一的兜底定位信息：
    // get_image 取不到时只能靠 emoji_id 拼 CDN，丢了它就彻底取不到字节。
    // 线上是 image 段 + emoji_id（sub_type 可能是 0），部分网关用 mface 段。
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'video') {
      // MARKER: video-media
      // 视频段以前在这里什么都不收，mediaList 里没有它，所以她只能从文本渲染
      // 那边看到一句「[视频]」，连「有视频可看」都不知道，更别说去看。
      // 这里只记元数据 —— 真正取字节和抽帧在 fetchMediaData 里按需做：
      // 视频动辄几十 MB，不能在她没开口时就去下载转码。
      media.push({
        kind: 'video',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // OneBot v11 的 video 段常见字段是 duration（秒）。没有就记 0，
        // 0 在这里的含义是「不知道」，不是「时长为零」。
        durationSec: Number(d.duration ?? d.duration_sec ?? 0) || 0,
        summary: sanitizeMediaSummary(d.summary)
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    } else if (seg.type === 'mface' || seg.type === 'marketface') {
      // MARKER: mface-media
      // QQ 的「收藏表情 / 商城表情」走 mface 段，不是 image 也不是 face。
      // 以前这里没分支 → 整段直接蒸发：mediaList 为空，她连「这里有个表情」都不知道，
      // 只会被告知「没看见」。summary 形如「[表情包:我是吃白饭的大肥鱼]」。
      // kind 统一叫 'sticker'（与 image/face 并列），本地老代码认 'mface' 的地方
      // 用 isStickerKind() 兼容，见下面三处消费点。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary ?? d.text),
        ...emojiFields
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;

  // 「仅好友」档位必须排在白名单之前判定。
  // 若先判白名单，非空白名单会让本档位永远不可达——「好友都能聊」就成了空话。
  // 语义：friendOnly 只放宽**被动收消息**；「主动找谁」由 proactiveAllowed() 用白名单单独把关。
  if (kind === 'private' && cfg.friendOnly === true) {
    // MARKER: friendonly-whitelist-first —— 2026-10-26
    // 旧写法在这里直接 `if (!friendSetReady) return false;`，把**白名单也一起挡了**：
    // 2026-10-26 07:15 那次重启后好友列表刷新卡死（见下方 refreshFriends 的超时兜底），
    // friendSetReady 一直 false，结果 08:46:52 / 10:03:26 主人自己发的两条私聊都被
    // 打成「忽略未授权会话 private:1124721191」丢掉了。
    // 白名单（cfg.allow.private）是**显式配置的授权**，证据强度高于运行时抓到的好友列表：
    // 好友列表只是个动态快照，抓不到不代表这个人不该被理。所以先查白名单。
    const allowListEarly = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
    if (allowListEarly.map(String).includes(s)) return true;
    if (!friendSetReady) return false;      // 好友列表未就绪 ⇒ 非白名单的人一律 fail-closed
    if (friendSet.has(s)) return true;      // 是好友 ⇒ 可以发消息进来
    // 不是好友、也不在白名单：拒绝
    return false;
  }

  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 二代会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalV2Key(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  // MARKER: modules-helper
  // 功能模块装载器句柄。null = 没装载（配置关了，或装载失败）→ 请求回调里整段委派跳过。
  // 放在 main 顶层而不是请求回调里，是为了只建一次、只装载一次。
  let moduleHost = null;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  // MARKER: modules-ctx
  // 功能模块共用的句柄容器。**先建空对象，后面逐步 Object.assign 灌满**：
  // 模块在 setup(ctx) 里拿到的是同一个对象，所以只要句柄在装载前灌好就行。
  // 不在启动早期一次性算出来 —— api 等句柄要到 main() 中段才建得出来。
  const moduleCtx = {};
  acquireLock();
  loadState();

  // fs / path 也交出去：模块自己 import 当然也行，但统一走 ctx 之后，
  // 想换实现（比如换成带沙箱的包装）只有这一个地方要改。
  // ROOT 也在这里交出去：slang 模块读写 config.json 要用 path.join(ROOT, 'config.json')，
  // 它是顶层 const（src/bridge.js:176），不是在 main() 里。
  Object.assign(moduleCtx, { cfg, log, stateDir: STATE_DIR, rootDir: ROOT, fs, path });
  Object.assign(moduleCtx, { truncateText });
  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]

  // MARKER: modules-ctx-slang
  // 黑话库模块（slang）需要的句柄。分三类交付：
  //   1. 顶层 import 的常量/纯函数：SLANG_STATUS、createSlangEntry —— 交引用
  //   2. main() 里会被**整体重新赋值**的变量：slangEntries —— 只交 getter/setter，
  //      模块里绝不能缓存快照，否则清空/批量删之后拿到的是旧数组
  //   3. main() 里 const 容器（Map/Set）与函数声明 —— 交引用或闭包均可，
  Object.assign(moduleCtx, {
    slangHelpers: {
      entries: () => slangEntries,
      push: (entry) => {
        slangEntries.push(entry);
      },
      // MARKER: slang-set-entries —— 模块里 batch-delete / clear / batch-confirm /
      // batch-reject 都靠它整体换数组（见 src/modules/slang/index.js:91/94/114/128）。
      // 上面第 2 类句柄的注释本来就承诺了"只交 getter/setter"，但这个 setter 一直没交，
      // 于是这四个控制台接口线上全是 HTTP 500「h.setEntries is not a function」。
      setEntries: (next) => {
        slangEntries = Array.isArray(next) ? next : [];
      },
      // MARKER: slang-research-pick
      pickResearch: (opts) => slangResearchPick(opts),
      save: () => saveSlangStore(),
      createEntry: (input) => createSlangEntry(input),
      SLANG_STATUS,
      windows: slangWindows,
      cooldowns: slangExtractionCooldowns,
      submitTimes: slangSubmitTimes,
      researchingIds: slangResearchingIds,
      queueTask: (fn) => queueSlangTask(fn),
      runExtraction: (key, opts) => runSlangExtraction(key, opts),
      runResearch: (candidates, opts) => runSlangResearch(candidates, opts),
      invalidateLearnerSession: () => invalidateSlangLearnerSession(),
      // 阶段25：AI 工具面（原 if 链里的 slang/query、slang/submit）
      confirmedList: () => confirmedSlangListV2(),
      buildContext: (entries, max, key) => buildSlangContext(entries, max, key),
      allowSubmit: (key) => allowSlangSubmit(key),
      publicEntry: (e) => publicSlangEntry(e),
      mergeEvidence: (oldList, addList) => mergeEvidence(oldList, addList),
    },
  });

  // MARKER: item7-slang
  // 黑话学习会话的失效判定与重建预算（见 patch-item7.py 头部「为什么」）。
  const SLANG_LEARNER_REBUILD_MAX = 3;                       // 窗口内最多重建几次
  const SLANG_LEARNER_REBUILD_WINDOW_MS = 30 * 60 * 1000;    // 重建预算窗口
  const SLANG_LEARNER_PROVIDER_BACKOFF_MS = 10 * 60 * 1000;  // provider 类失败的退避
  // 2026-10-21：研究 turn 在慢渠道（raccoon）上会超过 120s。超时不是「会话坏了」，
  // 重建只会更慢；改为加大超时 + 研究专用退避，把频率压下来而不动会话。
  const SLANG_EXTRACT_TIMEOUT_MS = 180000;                   // 提取 turn 等待上限（兜底渠道 120s 常在边缘）
  const SLANG_RESEARCH_TIMEOUT_MS = 180000;                  // 研究 turn 等待上限
  // MARKER: slang-light-research —— 兜底渠道上的「轻量研究」参数。
  // 兜底渠道实测一个完整研究 turn 要 12 分钟以上，注定超时；
  // 轻量模式不联网、只凭群友语境推断，单批只挑出现最多的 3 条，超时收到 90s。
  // MARKER: slang-backfill-fast —— 2026-10-26 批量从 3 提到 10、超时 90s 提到 150s。
  // 实测轻量研究一轮 3 条只要 10~25 秒，离 90s 上限远得很，3 条是白等。
  // 1923 条无释义候选按 3 条/轮 × 10 分钟一轮要 107 小时（4.5 天）。
  const SLANG_LIGHT_RESEARCH_TIMEOUT_MS = 150000;
  const SLANG_LIGHT_RESEARCH_BATCH = 10;
  const SLANG_LIGHT_RESEARCH_BACKOFF_MS = 10 * 60 * 1000;
  const SLANG_RESEARCH_TIMEOUT_BACKOFF_MS = 15 * 60 * 1000;  // 研究超时后的退避
  const slangLearnerRebuildAt = [];   // 最近的重建时间戳
  let slangLearnerBlockedUntil = 0;   // 在此之前不再创建/复用学习会话
  let slangLearnerLastFailure = null; // { at, kind, message }
  let slangResearchBlockedUntil = 0;  // 研究专用退避：只压研究频率，不碰会话、不挡提取
  let slangFallbackSkipLoggedAt = 0;  // 兜底跳过研究的日志节流（每小时一次）

  // 把学习会话的失败分类。纯函数，便于单测。
  function classifySlangLearnerError(message) {
    const m = String(message ?? '');
    if (/Illegal API invocation|unapproved channel|请求被拦截|unauthorized|forbidden|401|403|quota|额度|余额不足|积分不足|积分余额|balance|insufficient/i.test(m)) return 'provider';
    if (/not[- ]?found|no such session|404|不存在|已删除|已归档|已失效/i.test(m)) return 'stale';
    if (/超时|timeout/i.test(m)) return 'timeout';
    return 'unknown';
  }

  // 该不该重建、该不该退避。纯函数。
  // 关键取舍：provider 坏掉时重建没有意义 —— 新会话还是那个坏渠道，只会白建会话。
  function decideSlangLearnerAction({ kind, now = Date.now(), rebuildTimes = slangLearnerRebuildAt, blockedUntil = slangLearnerBlockedUntil } = {}) {
    const at = Number(now) || Date.now();
    if (Number(blockedUntil) > at) {
      return { action: 'backoff', rebuild: false, retry: false, waitMs: Number(blockedUntil) - at, reason: 'cooling' };
    }
    if (kind === 'provider') {
      return { action: 'backoff', rebuild: false, retry: false, waitMs: SLANG_LEARNER_PROVIDER_BACKOFF_MS, reason: 'provider' };
    }
    const recent = (Array.isArray(rebuildTimes) ? rebuildTimes : [])
      .filter((t) => at - Number(t) < SLANG_LEARNER_REBUILD_WINDOW_MS);
    if (recent.length >= SLANG_LEARNER_REBUILD_MAX) {
      return { action: 'exhausted', rebuild: false, retry: false, waitMs: 0, reason: 'budget' };
    }
    // 真正的陈旧会话：立刻重建，并允许调用方在同一轮里重试一次。
    if (kind === 'stale') return { action: 'rebuild', rebuild: true, retry: true, waitMs: 0, reason: 'stale' };
    // 超时 / 未知：重建但不重试（重试只是把同一份 prompt 再压一遍）。
    return { action: 'rebuild', rebuild: true, retry: false, waitMs: 0, reason: kind };
  }

  function noteSlangLearnerRebuild(now = Date.now()) {
    slangLearnerRebuildAt.push(now);
    const keep = slangLearnerRebuildAt.filter((t) => now - Number(t) < SLANG_LEARNER_REBUILD_WINDOW_MS);
    slangLearnerRebuildAt.length = 0;
    slangLearnerRebuildAt.push(...keep);
  }

  // 成功一次即认为会话与渠道都活着：清掉退避和重建计数。
  function noteSlangLearnerHealthy() {
    if (slangLearnerBlockedUntil) log('黑话学习会话已恢复，解除退避');
    slangLearnerBlockedUntil = 0;
    slangLearnerRebuildAt.length = 0;
    slangLearnerLastFailure = null;
  }

  // 统一处理一次学习会话失败。返回 true 表示「已重建，调用方可以重试一次」。
  function handleSlangLearnerFailure(scope, error) {
    const message = String(error?.message ?? error ?? '');
    const kind = classifySlangLearnerError(message);
    const decision = decideSlangLearnerAction({ kind });
    slangLearnerLastFailure = { at: Date.now(), kind, message };
    if (decision.rebuild) {
      noteSlangLearnerRebuild();
      invalidateSlangLearnerSession();
      log(`${scope}失败（${kind}，会话已标记失效）: ${message}`);
      return decision.retry === true;
    }
    const minutes = Math.max(1, Math.round(decision.waitMs / 60000));
    if (decision.reason === 'provider') {
      slangLearnerBlockedUntil = Date.now() + decision.waitMs;
      log(`${scope}失败（provider）: ${message} —— 渠道问题，重建会话无用，${minutes} 分钟内不再尝试`);
      return false;
    }
    if (decision.action === 'backoff') {
      log(`${scope}跳过（退避中，还剩约 ${minutes} 分钟）: ${message}`);
      return false;
    }
    slangLearnerBlockedUntil = Date.now() + SLANG_LEARNER_PROVIDER_BACKOFF_MS;
    log(`${scope}失败（${kind}）: ${message} —— ${Math.round(SLANG_LEARNER_REBUILD_WINDOW_MS / 60000)} 分钟内已重建 ${SLANG_LEARNER_REBUILD_MAX} 次，暂停自动研究 ${minutes} 分钟`);
    return false;
  }
  let slangLearnerSessionId = null;
  let slangResearchSessionId = null;  // MARKER: slang-research-session
  let slangTaskChain = Promise.resolve();

  // ── 表情包体系（二代仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  // MARKER: modules-ctx-stickers
  // 表情库：stickerEntries / stickerSyncedAt 会被 syncStickerLibrary 整体换成新数组，
  // 所以只交访问器；三个改动函数是 main() 内的声明，包一层即可保持原闭包。
// MARKER: modules-ctx-ai-extras
  Object.assign(moduleCtx, {
    aiExtrasHelpers: {
      moodStore: () => moodStore(),
      saveMoodSafe: (store, label) => saveMoodSafe(store, label),
      affinityEntryFor: (key) => affinityEntryFor(key),
      recordAffinityForKey: (key, payload) => recordAffinityForKey(key, payload),
      spotifyClient: () => spotifyClient(),
      feedbackTimes: () => feedbackTimes,
      appendFeedbackEntry: (entry) => appendFeedbackEntry(entry),
    },
  });
  Object.assign(moduleCtx, {
    stickerHelpers: {
      entries: () => stickerEntries,
      syncedAt: () => stickerSyncedAt,
      syncStickerLibrary,
      formatStickerList,
      applyStickerNoteV2,
      setStickerRemarkV2,
    },
  });
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护
  // MARKER: modules-ctx-stickers-ai
  // 阶段9：表情库 AI 工具面需要的句柄。
  //   lastForcedAgentStickerSync 是 main() 的 let（10 秒刷新节流要读写），交访问器；
  //   其余是声明在后面的函数/常量，只放在函数体里调用，不立即求值（TDZ）。
  // mediaHelpers 收的是图片体积/像素上限与 mime 嗅探，全部只读。
  Object.defineProperty(moduleCtx, 'mediaHelpers', {
    get: () => ({
      getImageDimensions,
      mimeFromBuffer,
      mimeFromUrl,
      maxMediaBytes: () => MAX_MEDIA_BYTES,
      maxMediaPixels: () => MAX_MEDIA_PIXELS,
    }),
    enumerable: true,
    configurable: true,
  });
  Object.assign(moduleCtx.stickerHelpers, {
    enabled: () => stickerEnabled(),
    getStickerImageData: (id) => getStickerImageData(id),
    lastForcedSync: () => lastForcedAgentStickerSync,
    setLastForcedSync: (value) => { lastForcedAgentStickerSync = value; },
  });

  function stickerEnabled() {
    return cfg.socialV2?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.socialV2?.sticker?.enabled === false) return null;
    const rawTtl = Number(cfg.socialV2?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    const count = Math.min(500, Math.max(1, Number(cfg.socialV2?.sticker?.maxListCount) || 100));
    // MARKER: sticker-http-fallback
    // 先把一次同步的「合并 + 落盘」收成一个函数，WS 与 HTTP 两条路共用，
    // 避免两份逻辑漂移（曾经就是因为只有一份 WS 路径，WS 一抖表情库就时有时无）。
    const applyFetched = (fetched, via) => {
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(fetched)) {
        throw new Error(`fetch_custom_face_detail(${via}) 返回 data 不是数组，已放弃同步`);
      }
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条，通道 ${via}）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false, via };
    };
    try {
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      return applyFetched(response.data, 'ws');
    } catch (wsError) {
      // WS 挂了（重连窗口）不该让表情库整个空掉 —— 同一个网关的 HTTP 口通常还活着。
      try {
        const data = await onebotHttpAction('fetch_custom_face_detail', { count });
        return applyFetched(data, 'http');
      } catch (httpError) {
        log(`[sticker] 同步收藏表情失败（WS: ${wsError?.message ?? wsError}；HTTP: ${httpError?.message ?? httpError}）`);
        return null;
      }
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForV2(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // MARKER: item7-sticker
  // 把「她说的表情」解析成一条表情记录。
  //
  // 为什么需要：qq_send_sticker 只接受 id（emoji_id / md5 / url），但实测她会把**描述**当 id 传：
  // 2026-10-21 01:01:40Z `stickerId:"你这吃白饭的蓝色大肥鱼"` 直接失败，
  // 7 秒后自己改用 qq_list_stickers 查到 mfuns-11 才发出去。
  // 所以补一层「按描述/备注/标签」的兜底：唯一命中直接用；多个命中把候选列给她；一个都没中给 id 样例。
  // 纯函数（entries 进、结果出），便于单测。
  function resolveStickerRef(entries, ref) {
    const list = Array.isArray(entries) ? entries : [];
    const raw = String(ref ?? '').trim().replace(/^[「『“"'《[]+|[」』”"'》\]]+$/g, '').trim();
    if (!raw) return { entry: null, how: 'empty', candidates: [] };
    const exact = findSticker(list, raw);
    if (exact) return { entry: exact, how: 'exact', candidates: [] };
    const q = raw.toLowerCase();
    const scored = [];
    for (const e of list) {
      if (!e) continue;
      const fields = [e.desc, e.localNote, e.usage, ...(Array.isArray(e.tags) ? e.tags : [])]
        .map((x) => String(x ?? '').trim())
        .filter(Boolean);
      let score = 0;
      for (const f of fields) {
        const lf = f.toLowerCase();
        if (!lf) continue;
        if (lf === q) score = Math.max(score, 100);
        else if (lf.includes(q)) score = Math.max(score, 80);
        // 长描述只比开头，避免「你这吃白饭的蓝色大肥鱼」和整段备注永远不相等
        else if (q.length >= 4 && lf.includes(q.slice(0, 4))) score = Math.max(score, 40);
      }
      if (score > 0) scored.push({ entry: e, score });
    }
    scored.sort((a, b) => b.score - a.score || (Number(b.entry.useCount) || 0) - (Number(a.entry.useCount) || 0));
    if (!scored.length) return { entry: null, how: 'none', candidates: [] };
    const first = scored[0];
    const second = scored[1];
    // 只有「描述完全相同、且没有并列」才敢直接用；否则让她自己挑，避免发错图。
    if (first.score >= 100 && first.score > (second?.score ?? 0)) {
      return { entry: first.entry, how: 'desc', candidates: [] };
    }
    if (scored.length === 1) return { entry: first.entry, how: 'desc', candidates: [] };
    return { entry: null, how: 'ambiguous', candidates: scored.slice(0, 5).map((s) => s.entry) };
  }

  // 把候选/样例拼成一句人话，避免她只看到「找不到」三个字。
  function stickerRefError(ref, resolution, entries) {
    const list = Array.isArray(entries) ? entries : [];
    const label = String(ref ?? '').trim() || '(空)';
    if (resolution?.how === 'ambiguous') {
      const lines = (resolution.candidates || []).map((e) => `- ${e.id}：${String(e.localNote || e.desc || '').slice(0, 30)}`);
      return `表情「${label}」匹配到多个，请从下面挑一个 id 重发：\n${lines.join('\n')}`;
    }
    const samples = list.filter((e) => e && e.id).slice(0, 3)
      .map((e) => `${e.id}（${String(e.localNote || e.desc || '').slice(0, 16)}）`);
    return `找不到表情「${label}」。stickerId 必须是 id 而不是描述；先用 qq_list_stickers（可带 query）查到 id 再发。`
      + `现有 id 样例：${samples.join('、') || '（库里没有表情）'}`;
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const pool = synced?.entries ?? stickerEntries;
    const found = resolveStickerRef(pool, stickerId);  // MARKER: item7-sticker
    if (found.entry) return found.entry;
    // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
    const forced = await syncStickerLibrary(true);
    const pool2 = forced?.entries ?? stickerEntries;
    const found2 = resolveStickerRef(pool2, stickerId);
    if (!found2.entry) {
      // 找不到/重名不是服务器内部错误，是调用方的引用写错了（该用 id 不是描述）。
      // 用 400 而不是 500：500 会让人去查日志，400 才指向「换个 id 重发」。
      const error = new Error(stickerRefError(stickerId, found2, pool2));
      error.statusCode = 400;
      throw error;
    }
    return found2.entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  // MARKER: modules-ctx-voice
  // 语音库列表：voiceCfg 是 main() 内的函数（交闭包，避开 TDZ）；
  // voiceHelpers 全是顶层 import 的纯函数，直接交引用。
  Object.assign(moduleCtx, {
    voiceCfg: () => voiceCfg(),
    voiceHelpers: {
      path,
      listAudioFiles: (dir) => listAudioFiles(dir),
      inspectAudio: (file, opts) => inspectAudio(file, opts),
      escapeCqText: (value) => escapeCqText(value),
      text: (value) => text(value),
      describeAudio: (info) => describeAudio(info),
    },
  });
  function voiceCfg() {
    const v = cfg.socialV2?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 2,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 10,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false,
      // TTS：文字 → 语音。这里也要逐项列出来，否则 voiceCfg() 会把它丢掉。
      // key 优先走 .env 的 DASHSCOPE_API_KEY（代码里读），apiKey 只作临时覆盖。
      tts: {
        enabled: v.tts?.enabled !== false,
        model: v.tts?.model || 'qwen3-tts-flash',
        voice: v.tts?.voice || 'Cherry',
        languageType: v.tts?.languageType || 'Chinese',
        maxChars: Number(v.tts?.maxChars) > 0 ? Number(v.tts.maxChars) : 600,
        timeoutMs: Number(v.tts?.timeoutMs) > 0 ? Number(v.tts.timeoutMs) : 30000,
        downloadTimeoutMs: Number(v.tts?.downloadTimeoutMs) > 0 ? Number(v.tts.downloadTimeoutMs) : 30000,
        apiKey: String(v.tts?.apiKey ?? '')
      }
    };
  }




  // MARKER: modules-ctx-voice-send
  // 阶段15：语音发送（操作者通道）用到的 main() 内函数。
  // 它们全部排在 voiceCfg() 之后（resolveVoicePathForOperator@L1998、
  // voiceBudget*@L2017、sendVoiceV2@L2045、verifyVoiceMessageSent@L2160、modeAllowed@L3265），
  // 所以注入块必须摆在 voiceCfg() 收尾之后：对象字面量的值位置会立即求值，
  // 摆前面就撞 TDZ。一律交箭头/闭包，不交快照值。
  Object.assign(moduleCtx, {
    voiceSendHelpers: {
      modeAllowed: (key, kind, id, cfgArg, modeArg) => modeAllowed(key, kind, id, cfgArg, modeArg),
      currentMode: () => currentMode,
      resolveVoicePathForOperator: (input) => resolveVoicePathForOperator(input),
      // TTS：文字 → 库内 wav。发送仍走 sendVoiceForV2，别在这里发。
      ttsSpeak: (text, opts) => ttsSpeakV2(text, opts),
      voiceBudgetCheck: (scopeKey, cfgV) => voiceBudgetCheck(scopeKey, cfgV),
      voiceBudgetCommit: (scopeKey, at) => voiceBudgetCommit(scopeKey, at),
      sendVoiceV2: (key, filePath, opts) => sendVoiceV2(key, filePath, opts),
      verifyVoiceMessageSent: (messageId) => verifyVoiceMessageSent(messageId),
      // send-voice-lib.js 的纯函数：顶层 import 进来的名字不在 moduleCtx 上，必须显式交。
      parseTargetKey: (value) => parseTargetKey(value),
      resolveAudioProcessing: (opts) => resolveAudioProcessing(opts),
    },
    appendActivity: (line) => appendActivity(line),
  });
  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `socialV2.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveVoicePathForV2(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（socialV2.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceV2(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/socialV2/send-voice）与 sendVoiceForV2 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true,
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    // SnowLuma 在容器里，宿主机的绝对路径它 stat 不到（会报 ENOENT），只能内联字节。
    // 20MB 的库内上限 base64 后约 27MB，对本地 HTTP 和 SILK 转码都太重了，设一道闸。
    const voiceSize = fs.statSync(sendPath).size;
    if (voiceSize > 8 * 1024 * 1024) {
      throw new Error(`语音文件过大（${(voiceSize / 1048576).toFixed(1)}MB），base64 内联上限 8MB`);
    }
    const recordSegment = {
      type: 'record',
      data: { file: `base64://${fs.readFileSync(sendPath).toString('base64')}` }
    };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进二代会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSentV2(key, sent, label) {
    const st = getSocialV2State(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.wakeConfig.noActionCount = 0;
    saveSocialV2State();
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  // ── TTS：把一个句子变成语音库里的一条 wav ────────────────────────────────
  //
  // 只做「文字 → 库内文件」。发送、限流、审计、落地校验全部交给
  // sendVoiceForV2 → 所以这里失败的最坏结果是「这条没发成」，绝不会带崩整轮。
  //
  // 文本超过 maxChars（接口硬限 600）时**只取第一段**：一条语音已经 2~3 分钟，
  // 连发好几条语音比这一条长语音更吵，剩下的内容本来就该用文字说。
  async function ttsSpeakV2(text, opts = {}) {
    const vc = voiceCfg();
    const t = vc.tts ?? {};
    const apiKey = String(t.apiKey || process.env.DASHSCOPE_API_KEY || readTtsEnvValue(ttsEnvText, 'DASHSCOPE_API_KEY') || '').trim();
    if (!apiKey) return { ok: false, error: 'TTS 未配置 key（.env 里没有 DASHSCOPE_API_KEY）' };
    const maxChars = Number(t.maxChars) || TTS_DEF.maxChars;
    const segs = splitTtsText(text, maxChars);
    if (!segs.length) return { ok: false, error: '要合成的文本为空' };
    const spoken = segs[0];
    const syn = await ttsSynthesize(spoken, {
      apiKey,
      voice: t.voice || TTS_DEF.voice,
      model: t.model || TTS_DEF.model,
      languageType: t.languageType || TTS_DEF.languageType,
      maxChars,
      timeoutMs: Number(t.timeoutMs) || TTS_DEF.timeoutMs,
    });
    if (!syn.ok) { log(`[tts] 合成失败：${syn.error}`); return syn; }
    const dl = await ttsDownload(syn.url, {
      maxBytes: Number(vc.maxBytes) || TTS_DEF.downloadMaxBytes,
      timeoutMs: Number(t.downloadTimeoutMs) || TTS_DEF.downloadTimeoutMs,
    });
    if (!dl.ok) { log(`[tts] 下载失败：${dl.error}`); return dl; }
    const dir = path.join(vc.dir, 'tts');
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, error: `建 TTS 目录失败：${error?.message ?? error}` };
    }
    const name = `tts-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.wav`;
    const absPath = path.join(dir, name);
    try {
      fs.writeFileSync(absPath, dl.buffer);
    } catch (error) {
      return { ok: false, error: `写 TTS 文件失败：${error?.message ?? error}` };
    }
    log(`[tts] 合成完成 ${name}（${spoken.length} 字 / ${dl.bytes} 字节${segs.length > 1 ? '，原文更长只念了第一段' : ''}）`);
    return {
      ok: true,
      file: `tts/${name}`,
      absPath,
      bytes: dl.bytes,
      characters: syn.characters || spoken.length,
      text: spoken,
      truncated: segs.length > 1,
      totalSegments: segs.length,
    };
  }

  async function sendVoiceForV2(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（socialV2.voice.enabled=false）');
    const resolved = resolveVoicePathForV2(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceV2(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSentV2(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
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
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析，发图片段）。
  async function sendStickerV2(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const pool = synced?.entries ?? stickerEntries;
    const resolution = resolveStickerRef(pool, stickerRef);  // MARKER: item7-sticker
    if (!resolution.entry) throw new Error(stickerRefError(stickerRef, resolution, pool));
    const entry = resolution.entry;
    // 按描述兜底解析成功时留一行日志：既能看出她习惯怎么称呼表情，也方便查「发错图」。
    if (resolution.how !== 'exact') log(`[sticker] 表情引用「${stickerRef}」按${resolution.how === 'desc' ? '描述' : resolution.how}解析到 ${entry.id}`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // MARKER: native-custom-face
    // ── 通道选择：QQ 收藏表情优先走网关的原生表情通道 ──────────────────
    // 原实现一律下载成 base64 走 image 段，对方看到的是「可下载的图片」，
    // 收藏栏里存不进。网关的 send_custom_face 会把段落组装成带 sub_type=1 的
    // image 段（其注释写明「保留表情显示样式」），对方看到的才是「表情」。
    // 限制：该通道只支持 reply_to、不支持 @，所以需要 @ 时回退图片方式。
    const stickerIdForFace = String(entry.id || entry.md5 || '');
    const isQqFace = String(entry.source) === 'qq' && stickerIdForFace !== '';
    const wantAt = atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '';
    const useNativeFace = isQqFace && !wantAt;

    // 非原生通道（以及原生通道失败后的回退）仍需图片字节。
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image = null;
    if (!useNativeFace) {
      try {
        image = await safeFetchBuffer(url);
      } catch (error) {
        throw new Error(`表情 ${entry.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
      }
      segments.push({
        type: 'image',
        data: {
          file: 'base64://' + image.buffer.toString('base64'),
          // QQ 收藏表情回退时补齐与网关同款的「表情」标记
          ...(isQqFace ? { sub_type: 1, summary: '[动画表情]' } : {})
        }
      });
    }
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        // ① 优先用网关原生表情通道：对方看到「表情」，不是可下载的图片。
        if (useNativeFace) {
          const faceParams = kind === 'private'
            ? { emoji_id: stickerIdForFace, user_id: Number(id) }
            : { emoji_id: stickerIdForFace, group_id: Number(id) };
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            faceParams.reply_to = String(replyToMessageId).trim();
          }
          try {
            const faceRes = await bot.request('send_custom_face', faceParams);
            if (faceRes && faceRes.status === 'ok' && faceRes.retcode === 0) {
              log(`[sticker] 发送原生表情 ${key}: ${stickerIdForFace}`);
              sendResolve(faceRes.data);
              return;
            }
            log(`[sticker] send_custom_face 被拒（${faceRes?.wording || faceRes?.retcode || 'unknown'}），回退图片方式`);
          } catch (error) {
            log(`[sticker] send_custom_face 异常（${error?.message ?? error}），回退图片方式`);
          }
          // 回退：补上图片段后继续走原来的 HTTP 通道
          const fallback = await safeFetchBuffer(url);
          segments.push({ type: 'image', data: { file: 'base64://' + fallback.buffer.toString('base64'), sub_type: 1, summary: '[动画表情]' } });
        }
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteV2(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemarkV2(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  async function collectStickerV2(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSocialV2State(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let file = '';
    if (media?.kind === 'image') {
      // 优先取图片字节转 base64，避免 SnowLuma 直接下载聊天图片 URL 失败（带签名/防盗链）。
      // 严禁把消息里的原始 media.url / media.file 直接交给 OneBot 去下载：那会绕过 SSRF/本地文件防护。
      const img = await fetchOneBotImage(media);
      if (img?.buffer) {
        file = 'base64://' + img.buffer.toString('base64');
      } else {
        throw new Error('无法安全获取该图片字节，已拒绝收藏');
      }
    } else if (media?.kind === 'face') {
      const face = await fetchFaceMedia(media);
      if (face?.buffer) file = 'base64://' + face.buffer.toString('base64');
    }
    if (!file) throw new Error('无法获取该表情的图片源');
    assertSendAllowed();
    const addRes = await bot.request('add_custom_face', { file });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.socialV2?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      // MARKER: slang-auto-promote —— 每次落盘前先跑一遍自动晋升：
      // candidate + 有释义 + 出现≥3 次 → CONFIRMED（进注入表）。
      // 放在 save 之前而不是加载之后：新提取的词也能当轮就参与判断。
      try {
        const promo = promoteSlangEntries(slangEntries);
        if (promo.promoted > 0) {
          log(`黑话库自动晋升 ${promo.promoted} 条 → 可进黑话表：${promo.contents.slice(0, 6).join('/')}`
            + (promo.contents.length > 6 ? '…' : ''));
        }
      } catch (promoError) {
        log('黑话自动晋升失败（已忽略，不影响落盘）:', promoError?.message ?? promoError);
      }
      // MARKER: slang-soft-cap-use —— 软上限（默认 1200，config.slang.softCap 可调）。
      const cap = resolveSlangCap(cfg.slang?.softCap);
      const result = saveSlang(SLANG_FILE, slangEntries, { max: cap });
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过软上限 ${cap} 条，已按「已确认 > 有释义 > 证据 > 次数」丢掉 ${result.dropped} 条最弱的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    // MARKER: item7-slang
    // 退避期内不建也不复用：provider 坏掉时每次重建都会在 DSH 里留下一个废会话。
    if (slangLearnerBlockedUntil > Date.now()) {
      const left = Math.ceil((slangLearnerBlockedUntil - Date.now()) / 1000);
      throw new Error(`黑话学习会话退避中（还剩 ${left}s）：${slangLearnerLastFailure?.message ?? '上次失败'}`);
    }
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  // MARKER: slang-research-session
  // 研究会话与提取会话分离。慢渠道上一次研究 turn 可能要十几分钟（实测 12 分钟），
  // 共用会话会把提取的 prompt 排在它后面，导致提取也超时。分开后互不影响：
  // 研究的退避、重建、丢弃都只作用于研究会话。
  async function ensureSlangResearchSession() {
    if (slangLearnerBlockedUntil > Date.now()) {
      const left = Math.ceil((slangLearnerBlockedUntil - Date.now()) / 1000);
      throw new Error(`黑话研究会话退避中（还剩 ${left}s）：${slangLearnerLastFailure?.message ?? '上次失败'}`);
    }
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话研究缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_RESEARCH_SESSION_FILE, null);
    if (saved?.preset !== preset) invalidateSlangResearchSession();
    if (slangResearchSessionId) {
      learnerSessions.add(slangResearchSessionId);
      api.events.follow(slangResearchSessionId);
      return slangResearchSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangResearchSessionId = String(saved.sessionId);
      learnerSessions.add(slangResearchSessionId);
      api.events.follow(slangResearchSessionId);
      await ensureChatModel(slangResearchSessionId);
      return slangResearchSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang research workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang research session.create');
    slangResearchSessionId = value.sessionId;
    learnerSessions.add(slangResearchSessionId);
    api.events.follow(slangResearchSessionId);
    await ensureChatModel(slangResearchSessionId);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_RESEARCH_SESSION_FILE, { sessionId: slangResearchSessionId, preset });
    log(`黑话研究会话已创建：${slangResearchSessionId}`);
    return slangResearchSessionId;
  }


  // MARKER: slang-fallback-guard
  // 兜底渠道（慢）上跑一次黑话研究 turn 实测要 12 分钟以上，注定超过任何合理超时，
  // 只会白烧会话和上游额度，还反过来拖慢提取。只在主渠道做研究；
  // role 由 switch-provider.sh 写进 state/provider-switch.json（primary / fallback）。
  function slangResearchChannelIsFallback() {
    try {
      const st = readJsonSafe(path.join(STATE_DIR, 'provider-switch.json'), null);
      const role = String(st?.role ?? '');
      if (role !== 'fallback') return false;
      // MARKER: fallback-guard-by-latency
      // role 的语义只是「当前不在候选链链首」，不是「正在用临时慢渠道」。
      // 本部署的日常渠道本身就配在链尾（config.json 的 dsh.provider），
      // 于是 role 恒为 fallback，却根本不是慢渠道 —— 按位置判断会把
      // 黑话研究和结算永久关掉（2026-10-28 实测：14:49 结算被这条挡下）。
      // 改成按实测首字延迟判断：只有真的慢到「一次 turn 注定超时」才让路。
      const slowMs = Number(st?.lastSlowAvgMs) || 0;
      const strikes = Number(st?.slowStrikes) || 0;
      const checkedAt = Number(st?.lastSlowCheckAt) || 0;
      const limit = Math.max(1000, Number(cfg.socialV2?.settle?.slowGuardMs) || 12000);
      // 慢信号必须新鲜（slowGuardFreshMs，默认 30 分钟）才算数。
      // 原因：切换脚本走到候选链末尾时只写 chain-exhausted、不再刷新慢信号，
      // 旧的 20515ms 会一直挂着 —— 按旧数字拦，后台任务等于永久关闭。
      // 宁可放过去试一次（结算自带 timeoutMs 兜底），也不要静默罢工。
      const freshMs = Math.max(60000, Number(cfg.socialV2?.settle?.slowGuardFreshMs) || 1800000);
      const fresh = checkedAt > 0 && Date.now() - checkedAt < freshMs;
      if (fresh && strikes >= 1 && slowMs >= limit) return true;
      return false;
    } catch {
      return false;
    }
  }

  function invalidateSlangResearchSession() {
    const oldId = slangResearchSessionId;
    slangResearchSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_RESEARCH_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  // ── 视觉兜底（2026-10-25）──────────────────────────────────────────
  // 主模型（deepseek/deepseek-v4.1-flash）只吃文本，群里一进来图片整条投递就失败：
  //   session/attachment-invalid: Model "..." does not support image input
  // 所以图片进来先看当前模型吃不吃图，不吃就用独立的视觉会话说成文字再塞进 prompt。
  // 结果按图片 sha256 缓存 7 天 —— 群里的表情包/梗图会被反复发，同一份字节只花一次钱。
  //
  // 选型依据（2026-10-25 用 state/images 里三张真实群图实测）：
  //   dots-studio/dots-3-note-preview:free  13~22s 中文 OCR 逐字准、细节多（首选）
  //   nvidia/nemotron-3.5-super-vl:free     11~46s 整体描述好但 OCR 会漏/会猜（备选）
  // 别再写回 deepseek-ai/*、z-ai/*、moonshotai/*、kimi-*、mimo-*：这些当前全走
  // ai.dtyg123.dpdns.org（已 ENOTFOUND），mimo 另外还 Free usage limit reached。
  const VISION_PROMPT = [
    '用中文简要描述这张图，我要拿去在 QQ 群里聊天用，所以实用优先：',
    '1) 画面主体是什么（人物/动物/物件/截图，二次元或梗图要说明是什么梗图类型）；',
    '2) 图里所有可见文字逐字读出来，没有就写「无文字」；',
    '3) 整体情绪或氛围（可爱、暴躁、阴阳怪气、搞笑、治愈等）。',
    '不超过 150 字。不要客套话，不要 markdown，不要「这张图片显示」这种开头。'
  ].join('\n');

  const VISION_CACHE_FILE = path.join(STATE_DIR, 'vision-cache.json');
  const VISION_SESSION_FILE = path.join(STATE_DIR, 'vision-sessions.json');
  const VISION_DEFAULT_MODELS = [
    'dots-studio/dots-3-note-preview:free',
    'nvidia/nemotron-3.5-super-vl:free'
  ];

  let visionCache = { version: 1, entries: {} };
  try {
    const saved = readJsonSafe(VISION_CACHE_FILE, null);
    if (saved && typeof saved === 'object' && saved.entries && typeof saved.entries === 'object') {
      visionCache = { version: 1, entries: saved.entries };
    }
  } catch {}
  const visionSessionIds = new Map(); // model -> sessionId（进程内）

  function isVisionSession(sessionId) {
    for (const id of visionSessionIds.values()) {
      if (id === sessionId) return true;
    }
    return false;
  }

  function visionModelChain() {
    const list = Array.isArray(cfg.vision?.models) ? cfg.vision.models : [];
    const cleaned = list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
    return cleaned.length ? cleaned : VISION_DEFAULT_MODELS;
  }

  function persistVisionCache() {
    try {
      const entries = visionCache.entries ?? {};
      const keys = Object.keys(entries);
      const cap = 800;
      if (keys.length > cap) {
        keys.sort((a, b) => Number(entries[a]?.at ?? 0) - Number(entries[b]?.at ?? 0));
        for (const k of keys.slice(0, keys.length - cap)) delete entries[k];
      }
      atomicWriteJson(VISION_CACHE_FILE, { version: 1, entries });
    } catch (error) {
      log(`[vision] 缓存写入失败：${error?.message ?? error}`);
    }
  }

  /** 取模型目录（带 10 分钟缓存），只用来判断「当前模型吃不吃图」。 */
  async function currentModelCatalog() {
    if (modelCatalogCache && Date.now() - modelCatalogCache.at < MODEL_CATALOG_TTL_MS) {
      return modelCatalogCache.value;
    }
    if (!modelCatalogInFlight) {
      modelCatalogInFlight = withTimeout(fetchModelCatalog(), MODEL_CATALOG_TIMEOUT_MS, 'session/modelCatalog')
        .finally(() => {
          modelCatalogInFlight = null;
        });
    }
    const value = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
    modelCatalogCache = { at: Date.now(), value };
    return value;
  }

  /** 目录里模型描述的格式是「vision + text input · 1024K」或「text input · 128K」。 */
  function modelSupportsVision(provider, model, catalog) {
    try {
      const groups = catalog?.groups ?? [];
      const group = groups.find((g) => String(g?.id ?? '') === String(provider))
        ?? groups.find((g) => (g?.models ?? []).some((m) => String(m?.id) === String(model)));
      const hit = (group?.models ?? []).find((m) => String(m?.id) === String(model));
      const desc = String(hit?.description ?? '');
      if (!desc) return false;
      return /vision|image input|multimodal/i.test(desc);
    } catch {
      return false;
    }
  }

  /**
   * 视觉模型走哪个渠道。
   *
   * 绝不能回落到 cfg.dsh.provider —— 那个值会被 provider-switch 改来改去，
   * 而视觉模型只挂在特定渠道上（dots-studio / nvidia 系在 our-free-model）。
   * 回落就是 2026-10-30 那次「识图又崩了」的直接原因。
   */
  function visionProviderFor(model) {
    const byModel = cfg.vision?.providerByModel ?? {};
    const hit = byModel[String(model ?? '')];
    if (typeof hit === 'string' && hit.trim()) return hit.trim();
    const own = String(cfg.vision?.provider ?? '').trim();
    if (own) return own;
    return 'our-free-model';
  }

  async function ensureVisionSession(model) {
    const known = visionSessionIds.get(model);
    if (known) {
      learnerSessions.add(known);
      api.events.follow(known);
      return known;
    }
    const preset = resolvePresetName(cfg.vision?.preset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('视觉会话缺少已验证的安全 preset，拒绝创建');
    const saved = readJsonSafe(VISION_SESSION_FILE, null);
    const dir = path.join(STATE_DIR, 'vision-agent');
    fs.mkdirSync(dir, { recursive: true });
    let workspaceId = saved && typeof saved === 'object' ? String(saved.__workspaceId ?? '') : '';
    if (!workspaceId) {
      const ws = unwrap(await api.workspace.create({ path: dir }), 'vision workspace.create');
      workspaceId = ws.workspace.workspaceId;
    }
    const value = unwrap(await api.sessions.create({ workspaceId, agentPreset: preset }), 'vision session.create');
    const sessionId = value.sessionId;
    api.events.follow(sessionId);
    unwrap(await api.sessions.selectModel({
      sessionId,
      provider: visionProviderFor(model),
      model
    }), 'vision selectModel');
    learnerSessions.add(sessionId);
    visionSessionIds.set(model, sessionId);
    try {
      atomicWriteJson(VISION_SESSION_FILE, { __workspaceId: workspaceId, __updatedAt: Date.now() });
    } catch {}
    log(`[vision] 视觉会话已创建：${model} -> ${sessionId}`);
    return sessionId;
  }

  /** 等一次视觉 turn。返回 {promise, cancel}，cancel 用于 prompt 没被接受时摘掉等待。 */
  function waitVisionTurn(sessionId, timeoutMs) {
    let timer = null;
    const drop = () => {
      const arr = learnerWaiters.get(sessionId) ?? [];
      const idx = arr.findIndex((w) => w.timer === timer);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) learnerWaiters.delete(sessionId);
      if (timer) clearTimeout(timer);
    };
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        drop();
        reject(new Error(`视觉识别超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push({ resolve, reject, timer });
      learnerWaiters.set(sessionId, arr);
    });
    return { promise, cancel: drop };
  }

  async function runVisionTurn(model, part) {
    const timeoutMs = Math.max(15000, Number(cfg.vision?.timeoutMs ?? 90000));
    let sessionId = await ensureVisionSession(model);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const handle = waitVisionTurn(sessionId, timeoutMs);
      const accepted = await api.sessions.prompt({
        sessionId,
        mode: 'queue',
        content: [
          { type: 'text', text: VISION_PROMPT },
          {
            type: 'image',
            mediaType: String(part?.mediaType || 'image/png'),
            data: String(part?.data ?? ''),
            name: String(part?.name || 'qq-image.png')
          }
        ]
      });
      if (!accepted.result.ok) {
        handle.cancel();
        const why = `${accepted.result.error.code}: ${accepted.result.error.message}`;
        if (attempt === 1 && /not[- ]?found|unavailable|不存在/i.test(why)) {
          visionSessionIds.delete(model);
          sessionId = await ensureVisionSession(model);
          continue;
        }
        throw new Error(why);
      }
      const text = await handle.promise;
      const trimmed = String(text ?? '').trim();
      if (!trimmed) throw new Error('视觉模型返回空文本');
      return trimmed;
    }
    throw new Error('视觉会话重建后仍然失败');
  }

  // MARKER: image-see
  // 看一张图：输入是「会话里的某条消息」或「一个 URL / 本地文件」，输出是中文描述。
  // 为什么要有这个：她的 recentMessages 里图片只有「[图片]」四个字，
  // 聊天记录往前翻全是黑框；她自己画的图更惨 —— 画完只拿到 jobId，从没见过成品。
  async function describeMediaByRef(key, opts = {}) {
    const k = String(key ?? '');
    const st = socialV2.conversations.get(k);
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    let media = null;
    let msg = null;
    const url = String(opts.url ?? '').trim();
    const file = String(opts.file ?? '').trim();
    const ref = String(opts.messageRef ?? '').trim();
    if (url || file) {
      media = { kind: 'image', url: url || undefined, file: file || undefined };
    } else {
      // 没有显式给：取最近一条带图的消息；给了 messageRef 就按 messageId 找。
      for (let i = msgs.length - 1; i >= 0; i -= 1) {
        const m = msgs[i];
        if (!m || !Array.isArray(m.media) || !m.media.length) continue;
        if (ref && String(m.messageId || '') !== ref) continue;
        msg = m;
        media = m.media.find((x) => x && (x.kind === 'image' || x.kind === 'sticker' || x.kind === 'mface')) || m.media[0];
        break;
      }
    }
    if (!media) return { ok: false, why: '翻不到可看的图（这个会话最近没有带图的消息）' };
    const cached = String(media.desc ?? '').trim();
    if (cached && !opts.refresh) return { ok: true, text: cached, cached: true };
    const got = await fetchOneBotImage(media);
    if (!got?.buffer) return { ok: false, why: '取不到这张图的字节（可能已经过期）' };
    const mimeType = String(media.mimeType || got.mimeType || 'image/png');
    const text = await describeImage({
      data: Buffer.from(got.buffer).toString('base64'),
      mediaType: mimeType,
      name: String(media.file || 'qq-image.png')
    });
    const clean = String(text ?? '').trim();
    if (!clean) return { ok: false, why: '视觉模型返回空' };
    media.desc = truncateText(clean, 400);
    // 写回原文，让后面所有轮次都能看见（不是只这一次）
    try {
      if (msg) {
        const label = `[图片] ${truncateText(media.desc, 80)}`;
        if (/^\[图片\]$/.test(String(msg.plain ?? ''))) msg.plain = label;
        if (/^\[图片\]$/.test(String(msg.text ?? ''))) msg.text = label;
        saveSocialV2State();
      }
    } catch { /* 写回失败不影响这次回答 */ }
    return { ok: true, text: clean };
  }

  // 描述一张本地文件（她自己画的图就走这里）。
  async function describeLocalImageFile(filePath) {
    const buf = await fs.promises.readFile(filePath);
    const name = path.basename(String(filePath));
    const mimeType = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : 'image/png';
    return describeImage({ data: buf.toString('base64'), mediaType: mimeType, name });
  }

  // 把她刚画的图回灌进她自己的会话：下一轮她「记得」自己画了什么、长什么样。
  function noteSelfImage(key, desc, filePath) {
    const k = String(key ?? '');
    const st = socialV2.conversations.get(k);
    if (!st) return false;
    const text = `[我发了张图] ${truncateText(desc, 200)}`;
    const item = {
      sender: '我',
      text,
      plain: text,
      isSelf: true,
      isOwner: false,
      media: [{ kind: 'image', file: path.basename(String(filePath ?? '')), desc: String(desc ?? '').slice(0, 400) }],
      hasMedia: true,
      messageId: '',
      time: Date.now()
    };
    if (!Array.isArray(st.recentMessages)) st.recentMessages = [];
    st.recentMessages.push(item);
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (st.recentMessages.length > cap) st.recentMessages.shift();
    try { saveSocialV2State(); } catch { /* 落盘失败不影响 */ }
    return true;
  }

  async function describeImage(part) {
    const data = String(part?.data ?? '');
    if (!data) throw new Error('图片数据为空');
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const ttl = Math.max(0, Number(cfg.vision?.cacheTtlMs ?? 604800000));
    const hit = visionCache.entries?.[hash];
    if (hit && typeof hit.text === 'string' && Date.now() - Number(hit.at ?? 0) < ttl) {
      log(`[vision] 命中缓存 ${hash.slice(0, 8)}（${hit.text.length} 字，${hit.model ?? '?'}）`);
      return hit.text;
    }
    let lastError = null;
    for (const model of visionModelChain()) {
      try {
        const text = await runVisionTurn(model, part);
        visionCache.entries[hash] = { text, at: Date.now(), model };
        persistVisionCache();
        log(`[vision] ${model} 识别成功 ${hash.slice(0, 8)}：${text.slice(0, 40)}`);
        return text;
      } catch (error) {
        lastError = error;
        log(`[vision] ${model} 识别失败（${hash.slice(0, 8)}）：${error?.message ?? error}`);
      }
    }
    throw lastError ?? new Error('没有可用的视觉模型');
  }

  /** 主模型不吃图时，把 image part 换成文字；吃图就原样返回。 */
  // MARKER: vision-helpers
  // 当前模型到底能不能直接看图（判据只有模型目录 description 里的 modality 文案）。
  async function currentModelSeesImages() {
    try {
      const catalog = await currentModelCatalog();
      return modelSupportsVision(String(cfg.dsh?.provider || ''), String(cfg.dsh?.model || ''), catalog);
    } catch (error) {
      log(`[vision] 判定模型视觉能力失败，按「不吃图」处理：${error?.message ?? error}`);
      return false;
    }
  }

  // 把 fetchMediaData / resolveMediaList 产出的图片项批量转成文字。
  // 返回的每一项都**不再带 data**：调用方（MCP 工具）看到没有 data 就只输出 text，
  // 于是不吃图的主模型永远不会收到 image block（那会让整轮直接失败）。
  async function transcribeMediaImages(images) {
    const list = Array.isArray(images) ? images : [];
    const parts = [];
    const slots = [];
    for (const img of list) {
      if (img?.data && (img?.mimeType || img?.mediaType)) {
        const mediaType = String(img.mimeType ?? img.mediaType);
        parts.push({ type: 'image', mediaType, data: String(img.data), name: String(img.name ?? `m${slots.length + 1}`) });
        slots.push(img);
      } else {
        parts.push(null);
        slots.push(img);
      }
    }
    const bridged = await transcodeImagesForTextModel(parts.filter(Boolean));
    const texts = bridged.filter((p) => p?.type === 'text').map((p) => String(p.text ?? ''));
    const out = [];
    let cursor = 0;
    for (const img of list) {
      if (img?.data && (img?.mimeType || img?.mediaType)) {
        const text = texts[cursor++] ?? '（未取到描述）';
        out.push({ ...img, data: undefined, mimeType: undefined, mediaType: undefined, text });
      } else {
        out.push(img);
      }
    }
    return out;
  }

  // 唤醒时把「这条消息带的图」直接代看并写进 prompt。
  // 为什么需要：reserved2 模式下图片**根本不进 prompt**，只在文本里提示「去调 qq_get_message_images」。
  // 她常常想不起来调，主人看到的就是「她没看见图」。这里主动把描述塞给她，省掉那次工具调用。
  async function describeUnreadMediaInline(key) {
    if (cfg.vision?.enabled === false) return '';
    const budget = Math.max(0, Math.min(3, Number(cfg.vision?.maxImagesPerWake ?? 2)));
    if (budget === 0) return '';
    let st;
    try { st = getSocialV2State(key); } catch { return ''; }
    const pool = Array.isArray(st?.unread) ? st.unread : [];
    const hits = pool.filter((m) => Array.isArray(m?.media) && m.media.length > 0).slice(-budget);
    if (!hits.length) return '';
    const lines = [];
    const media = [];
    const pending = [];
    for (const m of hits) {
      if (m.visionText) { lines.push(`【图片内容·消息${m.seq ?? m.messageId ?? ''}】${m.visionText}`); continue; }
      pending.push(m);
      for (const item of m.media) media.push(item);
    }
    if (media.length) {
      try {
        const parts = await resolveMediaList(media);
        const bridged = await transcodeImagesForTextModel(parts);
        const txt = bridged.filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join(' ').trim();
        if (txt) {
          lines.push(txt);
          for (const m of pending) m.visionText = txt;
          try { saveSocialV2State(); } catch {}
        }
      } catch (error) {
        log(`[vision] 唤醒内联代看失败（${key}）：${error?.message ?? error}`);
      }
    }
    if (!lines.length) return '';
    log(`[vision] 唤醒内联代看 ${hits.length} 条消息（${key}）`);
    return `\n\n【图片已代看】当前模型不能直接看图，下面这些图已由视觉模型转成文字，不需要再调用 qq_get_message_images：\n${lines.join('\n')}`;
  }

  async function transcodeImagesForTextModel(parts) {
    const list = Array.isArray(parts) ? parts : [];
    const imgCount = list.filter((p) => p?.type === 'image').length;
    if (imgCount > 0) {
      log(`[vision] 进入转写：${imgCount} 张图，当前模型 ${cfg.dsh?.provider ?? '?'}/${cfg.dsh?.model ?? '?'}，兜底链 ${JSON.stringify(cfg.vision?.models ?? VISION_DEFAULT_MODELS)}`);
    }
    if (cfg.vision?.enabled === false) return list;
    if (!list.some((p) => p?.type === 'image')) return list;
    let supports = false;
    try {
      const catalog = await currentModelCatalog();
      supports = modelSupportsVision(String(cfg.dsh?.provider || ''), String(cfg.dsh?.model || ''), catalog);
    } catch (error) {
      log(`[vision] 取模型目录失败，按「不吃图」处理：${error?.message ?? error}`);
    }
    if (supports) {
      log('[vision] 当前模型本身支持看图，原样投递');
      return list;
    }
    const budget = Math.max(1, Number(cfg.vision?.maxImagesPerMessage ?? 3));
    const picks = [];
    let index = 0;
    for (const p of list) {
      if (p?.type !== 'image') continue;
      index += 1;
      picks.push({ part: p, index });
    }
    const results = await Promise.all(picks.map(async ({ part, index: i }) => {
      if (i > budget) return { index: i, skip: true };
      try {
        return { index: i, text: await describeImage(part) };
      } catch (error) {
        return { index: i, error: String(error?.message ?? error) };
      }
    }));
    const byIndex = new Map(results.map((r) => [r.index, r]));
    const out = [];
    let seen = 0;
    for (const p of list) {
      if (p?.type !== 'image') {
        out.push(p);
        continue;
      }
      seen += 1;
      const r = byIndex.get(seen);
      if (!r || r.skip) {
        out.push({ type: 'text', text: `[图片${seen}（超过单条识别上限 ${budget} 张，这张没看）]` });
      } else if (r.text) {
        out.push({ type: 'text', text: `[图片${seen}的内容] ${r.text}` });
      } else {
        out.push({ type: 'text', text: `[图片${seen}：没认出来（${String(r.error ?? '').slice(0, 60)}）。你看不到这张图，别硬猜里面有什么]` });
      }
    }
    return out;
  }

  async function runSlangExtraction(key, opts = {}) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    // MARKER: slang-taught-wire —— 先吃「有人明确教」的，再跑 LLM 抽取。
    // 放在 min 门槛之前：教一句话不该等凑满 10 条才记，那时候早被刷走了。
    // 教学条目直接 CONFIRMED，下一轮就进黑话表（buildSlangContext 里 taught 排最前）。
    if (messages.length) {
      try {
        const taught = detectTeachings(messages);
        let learned = 0;
        for (const t of taught) {
          const prev = slangEntries.find((e) => e && e.content === t.content);
          // 人工拉黑的不许被教学翻回来（与 promoteSlangEntries 的口径一致）。
          if (prev && prev.status === SLANG_STATUS.REJECTED) continue;
          upsertSlangEntry(slangEntries, t.content, {
            meaning: t.meaning,
            status: SLANG_STATUS.CONFIRMED,
            source: 'taught',
            evidence: [{ key, sender: t.speaker, text: t.text, time: t.time }],
            countIncrement: 3
          });
          learned += 1;
        }
        if (learned > 0) {
          saveSlangStore();
          log(`黑话教学：${key} 直接学到 ${learned} 条（${taught.slice(0, 4).map((t) => t.content).join('/')}${taught.length > 4 ? '…' : ''}）`);
        }
      } catch (error) {
        log('黑话教学解析失败（已忽略）:', error?.message ?? error);
      }
    }
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId, SLANG_EXTRACT_TIMEOUT_MS);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      const skippedBot = Number(slangSkippedBot.get(key)) || 0;
      slangSkippedBot.delete(key);
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`
        + (skippedBot > 0 ? `（窗口里挡掉 ${skippedBot} 条机器人消息）` : ''));
      noteSlangLearnerHealthy();  // MARKER: item7-slang
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
      // MARKER: fix2bugs
      // 补偿扫描：与本次是否提取到候选无关，独立补「从未研究过」的。
      sweepUnresearchedSlang();
    } catch (error) {
      // MARKER: item7-slang
      // 旧逻辑用 `/会话|session/` 猜失效：既误判（「学习会话 turn 未正常完成」也含「会话」），
      // 又漏判（超时文案里没有这两个词）。改成分类 + 一次性重建。
      if (handleSlangLearnerFailure(`黑话提取 (${key})`, error) && !opts.retried) {
        queueSlangTask(() => runSlangExtraction(key, { retried: true }));
      }
    }
  }

  // MARKER: fix2bugs
  // 补偿扫描：把「已达研究阈值、但从未研究过」的候选补进队列。
  //
  // 为什么需要：正常入队只在该条**再次出现**时触发；一条达到阈值后不再出现的词
  // 会永久卡住（实测「魔了」「lt」count=2、lastInferenceCount=0，从没被研究过）。
  // 研究失败（如 21:07/21:12 的「学习会话 turn 未正常完成」）后也一样能靠这里补上。
  //
  // 为什么单独成函数：第一版写在「提取成功」分支里，实测因「未发现候选」而永不触发。
  // 现在由「每次提取后」和「服务启动后」两处调用，不依赖刚好有新词。
  // MARKER: slang-research-quota
  // 研究是全链最贵的一步：一轮研究会话实测 30~45 次 web_search/web_fetch、
  // 180 秒必超时被丢弃。所以研究要过两道闸：词条门槛（count >= researchMinCount）
  // 与每日配额（researchMaxPerDay）。配额记在独立状态文件里，换天自动归零。
  const RESEARCH_QUOTA_FILE = path.join(STATE_DIR, 'slang-research-quota.json');
  function researchDayKey(now = Date.now()) {
    const d = new Date(Number(now));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function readResearchQuota(now = Date.now()) {
    let raw = null;
    try {
      raw = readJsonSafe(RESEARCH_QUOTA_FILE, null, false);
    } catch {
      raw = null;
    }
    return quotaFor(raw, researchDayKey(now), researchCfg(cfg.slang).maxPerDay);
  }
  function writeResearchQuota(quota) {
    try {
      atomicWriteJson(RESEARCH_QUOTA_FILE, { day: quota.day, used: quota.used });
    } catch (error) {
      log(`[黑话研究] 配额落盘失败：${error?.message ?? error}`);
    }
  }
  function slangResearchPick({ ids = [], limit = 0 } = {}) {
    const rc = researchCfg(cfg.slang);
    const quota = readResearchQuota();
    const picked = pickResearchCandidates({
      entries: Array.isArray(slangEntries) ? slangEntries : [],
      statusCandidate: SLANG_STATUS.CANDIDATE,
      ids,
      minCount: rc.minCount,
      limit: limit > 0 ? limit : rc.batch,
      quotaLeft: quota.left
    });
    if (picked.candidates.length) {
      writeResearchQuota({ ...quota, used: quota.used + picked.candidates.length });
      log(`[黑话研究] 按需挑出 ${picked.candidates.length} 条（门槛 ${rc.minCount} 次，今天剩余 ${Math.max(0, quota.left - picked.candidates.length)} 条配额）`);
    }
    return { ...picked, minCount: rc.minCount, quotaLeft: Math.max(0, quota.left - picked.candidates.length) };
  }

  function sweepUnresearchedSlang({ reason = '' } = {}) {
    try {
      if (cfg.slang?.autoResearch === false) return 0;
      if (!Array.isArray(slangEntries) || !slangEntries.length) return 0;
      const thresholdsC = Array.isArray(cfg.slang?.inferenceThresholds)
        ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean)
        : [2, 4, 8];
      const maxThreshold = thresholdsC.length ? Math.max(...thresholdsC) : 8;
      const researchMinCount = researchCfg(cfg.slang).minCount;
      const pending = slangEntries.filter((e) => {
        if (!e || e.status !== SLANG_STATUS.CANDIDATE) return false;
        const c = Number(e.count) || 0;
        const done = Number(e.lastInferenceCount) || 0;
        if (c < 1 || done >= c) return false;
        // MARKER: slang-research-on-demand —— 只研究被真用过 researchMinCount 次的词。
        // 原来门槛是「到过某个阈值（2/4/8）」，等于 count=2 也去联网查，钱花在碎句子上。
        if (c < researchMinCount) return false;
        // 只补「已经到过某个阈值」的，避免把所有 count=1 的词一次性全塞进队列
        if (c > maxThreshold) return true;
        return thresholdsC.includes(c);
      });
      // MARKER: slang-prefer-unlearned —— 2026-10-25 B
      // 实测：1930 条候选一条释义都没有，但补偿扫描却先去重研究了 count 最高的
      // 哈基米/dsh（本来就有释义）。原因就是只按 count 排，不看「学没学到」。
      // 现在先补没有释义的，同档内才按出现次数排。
      pending.sort((a, b) => {
        const am = String(a?.meaning ?? '').trim() ? 1 : 0;
        const bm = String(b?.meaning ?? '').trim() ? 1 : 0;
        if (am !== bm) return am - bm;
        return (Number(b?.count) || 0) - (Number(a?.count) || 0);
      });
      // MARKER: slang-backfill-fast —— 一次最多补 10 条（原 5 条）。
      // 轻量研究不联网，10 条一轮实测 40~60 秒，学习会话扛得住。
      // MARKER: slang-research-quota-use —— 每天有配额，用完就停，不设闸就是无底洞。
      const quota = readResearchQuota();
      if (quota.left <= 0) return 0;
      const batch = pending.slice(0, Math.min(10, quota.left)).filter((e) => !slangResearchingIds.has(e.id));
      if (batch.length) writeResearchQuota({ ...quota, used: quota.used + batch.length });
      if (!batch.length) return 0;
      if (!batch.length) return 0;
      log(`黑话研究：补偿扫描补入 ${batch.length} 条从未研究的候选${reason ? `（${reason}）` : ''}`);
      queueSlangTask(() => runSlangResearch(batch));
      return batch.length;
    } catch (error) {
      log('黑话补偿扫描异常:', error?.message ?? error);
      return 0;
    }
  }

  async function runSlangResearch(candidates, opts = {}) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // MARKER: slang-research-backoff —— 退避期内直接跳过，不建会话也不打日志，避免刷屏。
    if (slangResearchBlockedUntil > Date.now()) return;
    // MARKER: slang-light-research —— 2026-10-25 A+C
    // 旧版兜底渠道直接 return，一个研究 turn 都不跑。实测 provider 长期停在 fallback，
    // 结果 2000 条候选里只有 43 条有释义，「自我迭代」等于空转。
    // 参考 MaiBot 的 bw_learner：黑话释义靠群友语境就能推，不必非联网深挖。
    // 现在兜底渠道走轻量研究（不联网 / 单批 3 条 / 90s），主渠道照旧完整联网研究。
    const lightMode = slangResearchChannelIsFallback();
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    let targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id));
    if (!targets.length) return;
    if (lightMode) {
      targets = [...targets]
        .sort((a, b) => {
          const am = String(a.meaning ?? '').trim() ? 1 : 0;
          const bm = String(b.meaning ?? '').trim() ? 1 : 0;
          if (am !== bm) return am - bm;          // 没释义的先研究
          return (Number(b.count) || 0) - (Number(a.count) || 0);
        })
        .slice(0, SLANG_LIGHT_RESEARCH_BATCH);
    }
    for (const e of targets) slangResearchingIds.add(e.id);
    let sessionId;
    try {
      sessionId = await ensureSlangResearchSession();
    } catch (error) {
      for (const e of targets) slangResearchingIds.delete(e.id);
      log('黑话研究会话创建失败:', error?.message ?? error);
      return;
    }
    const promptText = buildResearchPrompt(targets, { light: lightMode });
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(
        sessionId,
        lightMode ? SLANG_LIGHT_RESEARCH_TIMEOUT_MS : SLANG_RESEARCH_TIMEOUT_MS
      );
      const results = parseResearchJson(output);
      // MARKER: slang-research-honest-log —— 旧版日志打的是 results.length（模型给了几条），
      // 不是真正写进库的条数。18:53 那次明明一条没落地，日志却写「已更新 3 条」，只能靠人去查文件。
      let written = 0;
      let rejected = 0;
      const missed = [];
      for (const r of results) {
        const entry = slangEntries.find((e) => e.content === r.content);
        if (!entry) { missed.push(String(r.content ?? '')); continue; }
        // MARKER: slang-research-noloop —— 2026-10-26
        // 旧逻辑只有 confirmed:true 才写，其余直接 continue（不写、也不推进
        // lastInferenceCount）。实测后果：模型判「嘴硬/躺平/看戏/#sl」是普通词 →
        // 不写 → 计数不推进 → 补偿扫描下一轮又把同一批挑出来 → 97 次研究、
        // 一次都没进库，库 2000 条里 0 条有释义。
        // 现在分三档：
        //   ① confirmed:true            → 写全字段（进注入表）
        //   ② confirmed:false 但有释义  → 释义照样入库（通用词也有价值），
        //                                 状态留 candidate（不占注入位），并推进计数
        //   ③ confirmed:false 且无释义  → 判「没有黑话价值」，标 REJECTED，
        //                                 推进计数 → 永不再研究（这就是黑名单）
        if (r.confirmed !== true && !String(r.meaning ?? '').trim()) {
          entry.status = SLANG_STATUS.REJECTED;
          entry.lastInferenceCount = entry.count;
          entry.updatedAt = new Date().toISOString();
          rejected += 1;
          log(`黑话研究：${r.content} 判为普通词，拉黑不再研究`);
          continue;
        }
        if (r.meaning) entry.meaning = r.meaning;
        if (r.usage) entry.usage = r.usage;
        if (r.example) entry.example = r.example;
        if (r.risk) entry.risk = r.risk;
        if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
        entry.lastInferenceCount = entry.count;
        entry.updatedAt = new Date().toISOString();
        // MARKER: slang-promote-on-confirm —— 2026-10-26
        // 旧代码在这里只写 meaning，从不改 status。实测后果：模型这半天判了
        // 约 248 次 confirmed:true，释义全存进去了，status 却一直是 candidate，
        // 而 buildSlangContext 只认 CONFIRMED —— 学到的东西一次都没进过提示词。
        // 模型明确说「这词是真的」时，状态必须跟上，否则研究白花钱。
        if (r.confirmed === true) {
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.promotedAt = new Date().toISOString();
        }
        written += 1;
        if (r.confirmed !== true) log(`黑话研究：${r.content} 通用词入库（留候选，攒够次数自动晋升）`);
        else log(`黑话研究：${r.content} 已确认，进黑话表`);
      }
      saveSlangStore();
      log(`黑话研究：模型返回 ${results.length} 条，写入 ${written} 条，拉黑 ${rejected} 条`
        + (missed.length ? `，${missed.length} 条没匹配上词条（${missed.slice(0, 3).join('/')}）` : ''));
      slangResearchBlockedUntil = 0;
      noteSlangLearnerHealthy();  // MARKER: item7-slang
    } catch (error) {
      // MARKER: slang-light-research —— A
      // 轻量模式下任何失败都退避 10 分钟，否则每次提取后的补偿扫描都会把同一批
      // 候选重新塞进队列（这正是旧 fallback 分支「每轮都试一次」的毛病）。
      if (lightMode) {
        slangResearchBlockedUntil = Date.now() + SLANG_LIGHT_RESEARCH_BACKOFF_MS;
        log(`黑话轻量研究失败（${error?.message ?? error}）—— ${Math.round(SLANG_LIGHT_RESEARCH_BACKOFF_MS / 60000)} 分钟内暂停研究`);
      }
      // MARKER: item7-slang
      // MARKER: slang-research-backoff —— 超时只压研究频率。研究会话已与提取会话分离，
      // 丢弃研究会话不影响提取。慢渠道上一轮研究 turn 可能十几分钟，超时那一刻它还堵在
      // DSH 的会话队列里，留着它下一轮只会排得更久，所以直接丢掉、下次用新会话。
      if (classifySlangLearnerError(error?.message ?? error) === 'timeout') {
        slangResearchBlockedUntil = Date.now() + SLANG_RESEARCH_TIMEOUT_BACKOFF_MS;
        invalidateSlangResearchSession();
        const mins = Math.round(SLANG_RESEARCH_TIMEOUT_BACKOFF_MS / 60000);
        log(`黑话研究超时（${error?.message ?? error}）—— 已丢弃研究会话（该 turn 仍堵在 DSH 队列里），${mins} 分钟内暂停研究；提取会话独立，不受影响`);
      } else if (handleSlangLearnerFailure('黑话研究', error) && !opts.retried) {
        // 这里排队而不是直接 await：catch 之后 finally 才会把这些 id 从
        // slangResearchingIds 里移除，立刻重跑会被自己的去重挡掉。
        queueSlangTask(() => runSlangResearch(targets, { retried: true }));
      }
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // MARKER: slang-human-only —— 黑话只从「真人」的群消息里学。
  //
  // 为什么：库被「落盘」「兜底默认回复」「一条账一条命」「驳回申请！本猫猫这里
  // 没有这种数值面板喵」这类碎片填满过 2000 条上限。查下来它们不是群友的黑话，
  // 是**别的机器人**（含同类 agent bot，群里就有一个「饭饭鲸-Agent」）在群里
  // 大段叙述自己的运行/开发过程，被提取器当成"陌生词"照单全收。
  // 判断依据用现成的 isKnownBot()（网关的群机器人表，下面是它的缓存），
  // 加上 sender 自带机器人标记的兜底；拿不准时**放行**真人，宁可少学一条，
  // 不要因为她把别的 bot 的话当成群文化。
  //
  // 顺带挡住私聊：私聊里聊的是技术和日常，不是群黑话，key 前缀不是 group: 就进不来。
  function slangFeedAllowed(key, event) {
    const k = String(key ?? '');
    if (!k.startsWith('group:')) return false;
    const uid = event?.user_id ?? event?.userId;
    if (uid == null || String(uid) === '') return false;
    const sender = event?.sender ?? {};
    if (sender.is_robot === true || sender.robot === true || sender.is_bot === true) return false;
    return !isKnownBot(k.slice('group:'.length), uid);
  }

  const slangSkippedBot = new Map(); // key -> 本轮窗口里被挡掉的机器人消息数（只用于日志）

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。一代/二代共用。
  function feedSlangWindow(key, sender, plainContent, event) {
    if (cfg.slang?.enabled === false) return;
    if (!slangFeedAllowed(key, event)) {
      // 只统计，不打每条日志（群里机器人说话很频繁，逐条打会把日志刷满）
      if (key) slangSkippedBot.set(key, (Number(slangSkippedBot.get(key)) || 0) + 1);
      return;
    }
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangListV2() {
    // MARKER: slang-limit-200 —— 与 slang-learner.js 的 buildSlangContext 同步放开。
    // 控制台写配置时也允许到 200（modules/slang/index.js 同改）。
    const max = Math.max(1, Math.min(200, Number(cfg.slang?.injectMax) || 8));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText, key = '') {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 8, key);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.socialV2?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  socialV2.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });

  // MARKER: modules-ctx-state
  // state 是 `let`，运行时会被整体重新赋值（loadState / 保存路径），
  // 直接 Object.assign 会把旧对象冻住 —— 必须交访问器。
  Object.defineProperty(moduleCtx, 'state', { get: () => state, enumerable: true, configurable: true });

  // MARKER: modules-ctx-roles
  // 人格管理整族用到的文件级工具。roleInjectMaxChars 是 `let`（applyRoleInjectLimit
  // 会给它赋新值），所以只交 getter/setter，不能交值。
  Object.assign(moduleCtx, {
    roleHelpers: {
      NAME_MAX: ROLE_NAME_MAX,
      CONTENT_MAX_BYTES: ROLE_CONTENT_MAX_BYTES,
      validateName: validateRoleName,
      validateContent: validateRoleContent,
      fileExists: (name) => fs.existsSync(roleFilePath(name)),
      readContent: readRoleContent,
      writeContent: writeRoleContent,
      renameFile: (from, to) => fs.renameSync(roleFilePath(from), roleFilePath(to)),
      removeFile: (name) => fs.rmSync(roleFilePath(name)),
      warnings: roleWarnings,
      charStats: roleCharStats,
      sectionReport: roleSectionReport,
      applyInjectLimit: applyRoleInjectLimit,
      getInjectMaxChars: () => roleInjectMaxChars,
      setInjectMaxChars: (v) => { roleInjectMaxChars = v; },
    },
  });
  // MARKER: modules-ctx-preset
  // 仿真提示词管理：这些工具函数都是 bridge.js 顶层的纯文件操作，
  // 只有 resolvePresetName 在 main() 内（它依赖 dshPresetIds / dshDefaultPreset
  // 两个会被整体重新赋值的 let），所以用箭头函数现取，别交快照值。
  Object.assign(moduleCtx, {
    presetHelpers: {
      fs,
      path,
      names: PRESET_NAMES,
      backupDir: PRESET_BACKUP_DIR,
      sourceYaml: presetSourceYaml,
      installedYaml: installedPresetYaml,
      readPromptText: readPresetPromptText,
      backupFile: backupPresetFile,
      listBackups: listPresetBackups,
      status: presetStatus,
      atomicWriteText,
      resolveName: (name) => resolvePresetName(name),
      extractPrefix: extractPresetPrefix,
      promptWarnings: presetPromptWarnings,
      promptBlockers: presetPromptBlockers,
      renderPromptYaml: renderPresetPromptYaml,
    },
  });
  // MARKER: modules-ctx-api
  Object.assign(moduleCtx, { api });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
        // MARKER: modules-ctx-ops
        Object.assign(moduleCtx, {
          dshHelpers: {
            effortOptions: REASONING_EFFORT_OPTIONS,
            effortDefault: REASONING_EFFORT_DEFAULT,
            normalizeEffort: normalizeReasoningEffort,
            configFile: path.join(ROOT, 'config.json'),
            readConfigObject,
            atomicWriteJson,
            loadModelCatalog: async () => {
              // 复用同一个在飞请求 + 10 分钟缓存（见 panel-model-cache 注释）。
              // 缓存必须存 **unwrap 之后** 的值：先缓存裸包会让第二个调用方拿到的是
              // { result: ... } 外壳，读 catalog.groups 永远为空 —— 表现就是
              // 「同一个请求里思考强度能取到 DSH 目录，模型下拉却退回本地文件」。
              const now = Date.now();
              if (modelCatalogCache && now - modelCatalogCache.at < MODEL_CATALOG_TTL_MS) {
                return modelCatalogCache.value;
              }
              if (!modelCatalogInFlight) {
                modelCatalogInFlight = withTimeout(fetchModelCatalog(), MODEL_CATALOG_TIMEOUT_MS, 'session/modelCatalog')
                  .finally(() => { modelCatalogInFlight = null; });
              }
              const value = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
              modelCatalogCache = { at: Date.now(), value };
              return value;
            },
            noteCatalogFailure: (error) => {
              const reason = String(error?.message ?? error);
              if (modelCatalogErrorLogged.has(reason)) return;
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            },
            bumpModelSelectionEpoch: () => { modelSelectionEpoch += 1; },
            modeAllowed,
            currentMode: () => currentMode,
            saveState,
            saveSocialV2State,
            releaseLock,
          },
        });
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  // MARKER: turn-budget
  // 回合硬预算。与内容彻底无关的兜底闸门：她已经证明「判断没错但停不下来」
  // （turn 15 在群里配合玩梗，52 分钟 129 次工具调用），所以不能再靠提示词自律。
  const turnBudgetLedger = new Map(); // sessionId -> { startedAt, steps, sends, cancelled, reason }

  // MARKER: upstream-blip-tracker
  // 上游网关抖一下（Cloudflare 回一张 HTML 502/521/522）不该每条都惊动主人。
  // 同一个会话 30 分钟内折叠：第 1 次报、第 2 次静默、第 3 次升级成「它在持续」。
  const upstreamBlips = createBlipTracker();
  const TURN_BUDGET_GRACE_FILE = path.join(STATE_DIR, 'wake-config-grace.json');
  // MARKER: settle-member-impression
  // 「她对某个人的新印象」。从 qq_memory_update 的分支里抽出来 ——
  // 工具通道和结算通道共用同一份口径（每条 40 字、每人最多 10 条、按人记时间），
  // 免得"加"和"改"两条路宽度不同。
  function applyMemberImpression(st, target, text) {
    const who = String(target || '').trim();
    if (!st || !who) return false;
    if (['__proto__', 'constructor', 'prototype'].includes(who)) return false;
    const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!value) return false;
    if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
    const old = st.memberImpressions[who] || {};
    const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
    if (!traits.includes(value)) traits.push(value);
    st.memberImpressions[who] = {
      traits,
      interactionCount: (Number(old.interactionCount) || 0) + 1,
      lastSeenAt: Date.now(),
      // MARKER: impression-per-member —— 按成员记时间，别让「改了一个人」把整会话的计时重置掉。
      refreshedAt: Date.now()
    };
    const entries = Object.entries(st.memberImpressions);
    if (entries.length > 50) {
      entries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
      for (let i = 0; i < entries.length - 50; i += 1) delete st.memberImpressions[entries[i][0]];
    }
    return true;
  }

  // MARKER: history-archive-runtime
  // 消息长寿存档：recentMessages 每会话只留 100 条，超出就被挤掉，她自然「想不起上周」。
  // 按月落进 state/history/YYYY-MM.jsonl，只存检索要用的字段；检索按字面双字词重叠，
  // 不建向量库（available 只剩 450MB，装不下 bge-small 那套）。
  const HISTORY_DIR = path.join(STATE_DIR, 'history');
  let historyDirReady = false;
  function ensureHistoryDir() {
    if (historyDirReady) return true;
    try {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      historyDirReady = true;
      return true;
    } catch (error) {
      log(`[history] 建目录失败：${error?.message ?? error}`);
      return false;
    }
  }
  /** 存档一条。永不抛、永不 await 阻塞主流程（丢一行存档远好过卡住回合）。 */
  function appendArchive(key, msg) {
    const hc = historyCfg(cfg);
    if (!hc.enabled) return;
    const record = toRecord(key, msg, { lineChars: hc.lineChars });
    if (!record) return;
    if (!ensureHistoryDir()) return;
    const file = archivePath(HISTORY_DIR, monthOf(record.t));
    if (!file) return;
    const line = encodeRecord(record);
    if (!line) return;
    fs.appendFile(file, line + '\n', (error) => {
      if (error) log(`[history] 写存档失败：${error?.message ?? error}`);
    });
    void hc;
  }
  /** 读最近 N 天覆盖到的月份文件，逐行解回记录。坏行直接跳过。 */
  function readArchiveRecords(days) {
    const hc = historyCfg(cfg);
    const out = [];
    const now = Date.now();
    const months = new Set();
    for (let i = 0; i <= days; i += 1) months.add(monthOf(now - i * 24 * 3600 * 1000));
    for (const m of months) {
      const file = archivePath(HISTORY_DIR, m);
      if (!file) continue;
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      const from = Math.max(0, lines.length - hc.scanLines);
      for (let i = from; i < lines.length; i += 1) {
        const rec = decodeLine(lines[i]);
        if (rec) out.push(rec);
      }
    }
    return out;
  }
  /** 回忆：找「谁在什么时候说过什么」。默认近 7 天，最多 20 条。 */
  function recallArchive({ text = '', who = '', days, key = '', excludeSelf = false } = {}) {
    const hc = historyCfg(cfg);
    if (!hc.enabled) return { ok: false, count: 0, text: '存档功能没开。' };
    const useDays = clampDays(days, hc);
    const records = readArchiveRecords(useDays);
    const hits = queryArchive(records, {
      text,
      who,
      days: useDays,
      now: Date.now(),
      limit: hc.maxResults,
      keyOnly: key || undefined,
      excludeSelf,
    });
    return {
      ok: true,
      count: hits.length,
      days: useDays,
      text: formatRecall(hits, { text, days: useDays, now: Date.now() }),
      items: hits.map((r) => ({ t: r.t, who: r.who, text: r.text })),
    };
  }

  // MARKER: continuity-runtime
  // 换会话前的交接：把「还挂着的约定 / 正在聊的话题 / 最近要紧的话」压成 300 字以内，
  // 存进 state/continuity.json，新会话第一轮读一次就作废。
  // 动机：每天 04:10 换新会话是为了省 token 与防上下文爆，但她会断片 —— 昨天答应的事、
  // 没聊完的话题全留在旧会话里。星璃那套的做法是「会话负责刚才，记忆负责以前」，
  // 换之前写一张交接条。我们照做，只写三件事，宁短不长。
  const CONTINUITY_FILE = path.join(STATE_DIR, 'continuity.json');
  let continuityRunning = false;

  function readContinuityStore() {
    const raw = readJsonSafe(CONTINUITY_FILE, null);
    const base = raw && typeof raw === 'object' ? raw : {};
    return {
      version: 1,
      updatedAt: Number(base.updatedAt) || 0,
      items: base.items && typeof base.items === 'object' && !Array.isArray(base.items) ? base.items : {},
    };
  }
  function saveContinuityStore(store) {
    try {
      atomicWriteJson(CONTINUITY_FILE, store);
    } catch (error) {
      log(`[continuity] 落盘失败：${error?.message ?? error}`);
    }
  }

  /** 每轮注入：有新鲜的交接就注入一次，注入完立刻作废（一天只提醒一次）。 */
  function continuityHintFor(key) {
    try {
      const cc = continuityCfg(cfg);
      if (!cc.enabled) return '';
      const store = readContinuityStore();
      const text = continuityLine(store.items[key], { now: Date.now(), ttlHours: cc.ttlHours });
      if (!text) return '';
      const now = Date.now();
      saveContinuityStore(pruneContinuity(markContinuityUsed(store, key, now), { now, keepDays: cc.keepDays }));
      log(`[continuity] ${key} 注入交接条（${text.length} 字）`);
      return text;
    } catch (error) {
      log(`[continuity] 注入失败：${error?.message ?? error}`);
      return '';
    }
  }

  /** 换会话前生成交接条。失败一律不挡换会话 —— 宁可断片，也不能把定时任务卡住。 */
  async function generateContinuity(key) {
    const cc = continuityCfg(cfg);
    if (!cc.enabled) return false;
    if (continuityRunning) return false;
    const kind = kindOfKey(key);
    if (kind !== 'private' && kind !== 'group') return false;
    const st = getSocialV2State(key);
    const lines = pickContinuityLines(st?.recentMessages, {
      now: Date.now(),
      hours: cc.hours,
      maxLines: cc.maxLines,
      lineChars: cc.lineChars,
    });
    if (!lines.length) {
      log(`[continuity] ${key} 最近没对话，不做交接`);
      return false;
    }
    continuityRunning = true;
    try {
      const sessionId = await ensureSettleSession();
      const ask = buildContinuityAsk({ key, isGroup: kind === 'group', lines });
      const handle = waitSettleTurn(sessionId, cc.timeoutMs);
      try {
        unwrap(
          await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: ask }] }),
          'continuity prompt',
        );
        const text = await handle.promise;
        const parsed = parseContinuityJSON(text, { fieldChars: cc.fieldChars });
        const body = composeContinuityText(parsed, { chars: cc.chars });
        if (!body) {
          log(`[continuity] ${key} 这轮没什么可交接的`);
          return false;
        }
        const now = Date.now();
        const store = readContinuityStore();
        const next = {
          ...store,
          updatedAt: now,
          items: {
            ...store.items,
            [key]: { text: body, at: now, day: dayOf(now), usedAt: 0 },
          },
        };
        saveContinuityStore(pruneContinuity(next, { now, keepDays: cc.keepDays }));
        log(`[continuity] ${key} 交接已写好（${body.length} 字）`);
        return true;
      } finally {
        handle.cancel();
      }
    } catch (error) {
      log(`[continuity] ${key} 生成失败（不影响换会话）：${error?.message ?? error}`);
      return false;
    } finally {
      continuityRunning = false;
    }
  }

  // MARKER: settle-runtime
  // 结算通道：回合收工 → 隔几十秒 → 一个独立小会话读最近几轮原文 → 写情绪/印象。
  //
  // 为什么不在聊天里做：2026-10-25 铁律 —— 情绪/关系写入放结算，绝不新增聊天中的工具
  // 调用（一次工具调用重发约 24 万 token）。可这条铁律一直没被实现，于是情绪库停在
  // 10-24、印象重写 0 个、`qq_mood` 调用 0 次。这里是把它真做出来。
  // MARKER: world-life-store
  // 两个状态文件都跟 情绪.json 同等待遇：读坏当空、写盘走 atomicWriteJson。
  const LIFE_FILE = path.join(STATE_DIR, 'life.json');
  const MOOD_DAYS_FILE = path.join(STATE_DIR, 'mood-days.json');
  // MARKER: world-b-store
  // 话题与愿望：同样「读坏当空、写盘走 atomicWriteJson」，和 情绪.json 一个待遇。
  const THREADS_FILE = path.join(STATE_DIR, 'threads.json');
  const WISHES_FILE = path.join(STATE_DIR, 'wishes.json');
  function readThreadsStore() {
    const raw = readJsonSafe(THREADS_FILE, null);
    return raw && typeof raw === 'object' && Array.isArray(raw.items)
      ? raw
      : { version: 1, items: [] };
  }
  function saveThreadsStore(store) {
    try {
      atomicWriteJson(THREADS_FILE, store);
    } catch (error) {
      log(`[threads] 落盘失败：${error?.message ?? error}`);
    }
  }
  function readWishesStore() {
    const raw = readJsonSafe(WISHES_FILE, null);
    return raw && typeof raw === 'object' && Array.isArray(raw.items)
      ? raw
      : { version: 1, items: [] };
  }
  function saveWishesStore(store) {
    try {
      atomicWriteJson(WISHES_FILE, store);
    } catch (error) {
      log(`[wishes] 落盘失败：${error?.message ?? error}`);
    }
  }
  // MARKER: world-c-store
  const DATES_FILE = path.join(STATE_DIR, 'dates.json');
  function readDatesStore() {
    const raw = readJsonSafe(DATES_FILE, null);
    return raw && typeof raw === 'object' && Array.isArray(raw.items)
      ? raw
      : { version: 1, items: [] };
  }
  function saveDatesStore(store) {
    try {
      atomicWriteJson(DATES_FILE, store);
    } catch (error) {
      log(`[dates] 落盘失败：${error?.message ?? error}`);
    }
  }
  // MARKER: world-c2-store
  // 谈资：她自己的、不联网的、一天两次。只存标题 + 一句话，
  // 因为注入进每一轮的每个字都要按 token 付钱，而「播报感」也来自长文本。
  const TOPICS_FILE = path.join(STATE_DIR, 'topics.json');
  function readTopicsStore() {
    const raw = readJsonSafe(TOPICS_FILE, null);
    const base = raw && typeof raw === 'object' ? raw : {};
    return {
      version: 1,
      updatedAt: Number(base.updatedAt) || 0,
      items: Array.isArray(base.items) ? base.items : [],
      days: base.days && typeof base.days === 'object' ? base.days : {},
    };
  }
  function saveTopicsStore(store) {
    try {
      atomicWriteJson(TOPICS_FILE, store);
    } catch (error) {
      log(`[谈资] 落盘失败：${error?.message ?? error}`);
    }
  }
  let topicsBusy = false;
  let topicsTimer = null;
  async function generateTopic(slotInfo, tc) {
    const store = readTopicsStore();
    const sessionId = await ensureSettleSession();
    const ask = buildTopicAsk({
      hour: slotInfo.hour,
      recent: summarizeTopics(store, { cfg: tc }),
      cfg: tc,
    });
    const handle = waitSettleTurn(sessionId, 180000);
    try {
      unwrap(
        await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: ask }] }),
        'topic prompt',
      );
      const text = await handle.promise;
      const topic = parseTopicJSON(text);
      if (!topic) {
        log('[谈资] 这轮没parse出 JSON，跳过');
        return false;
      }
      // MARKER: topic-scope-fix —— 2026-10-30
      // 这里原来写的是 `{ ..., key }`，但 generateTopic(slotInfo, tc) 没有 key 形参，
      // 于是每轮都抛 `ReferenceError: key is not defined`，被 catch 吞成
      // 「[谈资] 生成失败：key is not defined」—— 谈资从改 scoped-store 那天起就没生成过。
      // 定时器生成的是「她自己的一天」，没有对应会话，所以挂到主人私聊这个 scope 上，
      // 跟世界层一起只在主人的私聊里出现（群聊和别人的私聊看不见）。
      const merged = addTopics(store, [topic], { now: Date.now(), cfg: tc, key: ownerScopeKey() });
      if (!merged.added) {
        log(`[谈资] 「${topic.title}」重复了，跳过`);
        return false;
      }
      saveTopicsStore(pruneTopics(merged.store, { cfg: tc }));
      log(`[谈资] 挑到一条：${topic.title}`);
      return true;
    } catch (error) {
      log(`[谈资] 生成失败：${error?.message ?? error}`);
      return false;
    } finally {
      handle.cancel();
    }
  }
  async function topicTick() {
    if (topicsBusy) return;
    const tc = topicsCfg(cfg);
    if (!tc.enabled) return;
    const store = readTopicsStore();
    const slotInfo = dueTopicSlot(store, { now: Date.now(), cfg: tc });
    if (!slotInfo) return;
    // 慢渠道时不抢算力：这条路是「锦上添花」，不是必须说的话。
    try {
      if (slangResearchChannelIsFallback()) {
        log('[谈资] 当前在兜底渠道，今天就先不挑');
        markTopicSlotSafely(store, slotInfo, tc);
        return;
      }
    } catch {}
    topicsBusy = true;
    try {
      const ok = await generateTopic(slotInfo, tc);
      if (ok) markTopicSlotSafely(store, slotInfo, tc);
    } finally {
      topicsBusy = false;
    }
  }
  function markTopicSlotSafely(store, slotInfo, tc) {
    try {
      saveTopicsStore(markTopicSlot(pruneTopics(store, { cfg: tc }), { ...slotInfo, now: Date.now() }));
    } catch (error) {
      log(`[谈资] 记账失败：${error?.message ?? error}`);
    }
  }

  // MARKER: life-timeline
  // 生活线注入：世界层 + 今天那一格 → 一句「此刻她在哪、手上在干嘛、什么打断不了」。
  //
  // 为什么要这一层（2026-10-30 实测）：旧 lifeLineFor 只给「今天三条计划」，
  // 于是上午十点和晚上十一点她说的日子一模一样，群里问「在干嘛」永远是那三条之一。
  // 这一层给的是**此刻**，而且是确定的（同一天同一时刻问多少次都一样）。
  //
  // 安全网：任何异常都返回空串，由调用方回落 lifeLineFor —— 宁可少一句，
  // 也不要让她说出自己没在干的事。
  let lifeTimelineWarned = false;
  function worldStore() {
    try {
      return readWorld(STATE_DIR, { log });
    } catch (error) {
      if (!lifeTimelineWarned) {
        lifeTimelineWarned = true;
        log(`[world] 读取失败，用默认世界：${error?.message ?? error}`);
      }
      return null;
    }
  }
  // 此刻的注意力档（occupied / asleep / ''）—— 只读，不写文件、不重排。
  // 拿不到就返回空串，pacing 完全按原来的时间戳逻辑走。
  function lifeAttentionNow(now = Date.now()) {
    try {
      const world = worldStore();
      if (!world) return '';
      const store = readTimeline(STATE_DIR);
      const key = lifeCfg(cfg).switchHour != null
        ? lifeDayFor(now, { switchHour: lifeCfg(cfg).switchHour }).today
        : new Date(now).toISOString().slice(0, 10);
      const day = store?.days?.[key];
      if (!day) return '';
      return attentionOf(day, now);
    } catch {
      return '';
    }
  }

  // MARKER: world-scope
  // 世界层（此刻生活线 + 世界自己冒出来的事）只注入「范围」内。
  //
  // 为什么要有这道闸（2026-10-30 主人明确要求）：
  //   「群聊不要注入世界，只有管理员私聊注入世界」
  // 群里一注入「现在是 17:00，你在堤坝上走」，她就会把自己的私事当谈资讲出来，
  // 既串味又出戏；群里她该只对聊天本身反应。
  //
  // 想去掉这道闸（让所有会话都注入）：config.json 加
  //   "socialV2": { "world": { "scope": "all" } }
  function worldScopeMode() {
    const raw = String((cfg.socialV2 && cfg.socialV2.world && cfg.socialV2.world.scope) || 'owner').trim();
    return raw === 'all' ? 'all' : 'owner';
  }

  function inWorldScope(key) {
    // MARKER: world-scope-hard
    // 群聊是硬边界：不管 scope 配成什么，群里一个字都不进。
    // 之前 scope:'all' 直接 return true，等于把「群里不注入」变成一句默认值而不是约束。
    const scopeKey = String(key || '');
    if (scopeKey.startsWith('group:')) return false;
    if (worldScopeMode() === 'all') return true;
    const qq = String(cfg.ownerQQ ?? '').trim();
    if (!qq) return false;   // 没配 ownerQQ 就一个都不注入：别把私事漏给别人
    return String(key || '') === `private:${qq}`;
  }

  // 她自己那部分「世界」产生的条目（谈资这类，没有具体会话）该挂到哪个 scope 上：
  // 挂主人的私聊，跟着 inWorldScope 一起只在自己的私聊里出现；
  // 没配 ownerQQ 就返回空串（空 = 全局可见，但那种情况本来也不会有世界层）。
  function ownerScopeKey() {
    const qq = String(cfg.ownerQQ ?? '').trim();
    return qq ? `private:${qq}` : '';
  }

  function lifeTimelineFor(now = Date.now(), { force = false, dayKey = '' } = {}) {
    const lc = lifeCfg(cfg);
    const world = worldStore();
    if (!world) return '';
    // 默认「今天」按她的闹钟算（凌晨还没睡那种仍算前一天）；settle 重排明天时要显式传 dayKey。
    const today = dayKey || lifeDayFor(now, { switchHour: lc.switchHour }).today;
    const lifeStore = readLifeStore();
    const plans = Array.isArray(lifeStore?.days?.[today]?.plans) ? lifeStore.days[today].plans : [];
    const { day } = ensureDay(STATE_DIR, world, { dayKey: today, plans, now, log, force });
    return lifeMomentLine(day, now);
  }
  // MARKER: world-events
  // 为什么单开一层，而不是塞进 life-timeline 的 env：
  //   时间线每晚被 settle 以 force:true 重排整天，事件塞进去就会跟着被重抽 ——
  //   「白天发生过什么」不能变。所以事件独立成账本，按天物化、只读不重抽。
  //
  // 三条纪律：
  //   1) 幂等：当天已有账本就原样复用，绝不重抽。
  //   2) 只给已经发生的：eventsSoFar 按 atMin 过滤，未来的事一个字都不给模型看。
  //   3) inject 默认关：先影子跑，确认不播报、不冲突，再手动打开。
  let worldEventsWarned = false;
  function worldEventsSettings() {
    const sv = cfg.socialV2 ?? {};
    return worldEventsCfg(sv.worldEvents ?? sv.events ?? {});
  }

  // 物化今天那一份（幂等）。返回 {day, created} 或 null。
  // 依赖时间线：事件要落在具体某格上（where / slotFrom / slotTo 都来自那格）。
  function worldEventsFor(now = Date.now(), { force = false } = {}) {
    try {
      const we = worldEventsSettings();
      if (!we.enabled) return null;
      const world = worldStore();
      if (!world) return null;
      const lc = lifeCfg(cfg);
      const dayKey = lifeDayFor(now, { switchHour: lc.switchHour }).today;
      const lifeStore = readLifeStore();
      const plans = Array.isArray(lifeStore?.days?.[dayKey]?.plans) ? lifeStore.days[dayKey].plans : [];
      // 先确保那天的时间线在（幂等；没有就排一份），再物化事件。
      const tl = ensureDay(STATE_DIR, world, { dayKey, plans, now, log, force });
      if (!tl?.day) return null;
      const got = ensureWorldEventsDay(STATE_DIR, world, { dayKey, day: tl.day, cfg: we, now, log, force });
      if (got?.created) log(describeWorldEvents(got.day));
      return got?.day ?? null;
    } catch (error) {
      if (!worldEventsWarned) {
        worldEventsWarned = true;
        log(`[world-events] 物化失败，这轮不注入：${error?.message ?? error}`);
      }
      return null;
    }
  }

  // 注入用：只读今天已物化那份，不新建。inject 关着就返回空串。
  function worldEventsNow(now = Date.now()) {
    try {
      const we = worldEventsSettings();
      if (!we.enabled || !we.inject) return '';
      const lc = lifeCfg(cfg);
      const dayKey = lifeDayFor(now, { switchHour: lc.switchHour }).today;
      const store = readEvents(STATE_DIR);
      const rec = store?.days?.[dayKey];
      if (!rec) return '';
      return worldEventsLine(rec, now, we);
    } catch {
      return '';
    }
  }

  // 十分钟一次的幂等检查：只补今天这一份，不重抽历史。
  async function worldEventsTick() {
    worldEventsFor(Date.now());
  }

  function readLifeStore() {
    const raw = readJsonSafe(LIFE_FILE, null);
    return raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object'
      ? raw
      : { version: 1, updatedAt: 0, days: {} };
  }
  function saveLifeStore(store) {
    try {
      atomicWriteJson(LIFE_FILE, store);
    } catch (error) {
      log(`[life] 落盘失败：${error?.message ?? error}`);
    }
  }
  function readMoodDaysStore() {
    const raw = readJsonSafe(MOOD_DAYS_FILE, null);
    return raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object'
      ? raw
      : { version: 1, updatedAt: 0, days: {} };
  }
  function saveMoodDaysStore(store) {
    try {
      atomicWriteJson(MOOD_DAYS_FILE, store);
    } catch (error) {
      log(`[心情日历] 落盘失败：${error?.message ?? error}`);
    }
  }

  // MARKER: diary-draft-boot
  // 傍晚那一档得靠定时器：她 23 点不会自己醒来。
  try {
    const eveningTimer = setInterval(() => { void diaryEveningTick(); }, 10 * 60 * 1000);
    eveningTimer.unref?.();
    log('[日记] 傍晚催写定时器已排上（23:20 起 30 分钟窗口）');
    // MARKER: session-rotate-boot —— 每天换新会话：会话越长每轮越贵，换新最省。
    try {
      const rotateC = rotateCfg(cfg);
      if (rotateC.enabled) {
        const rotateTimer = setInterval(() => { void sessionRotateTick(); }, 10 * 60 * 1000);
        rotateTimer.unref?.();
        log(`[会话换新] 定时器已排上（每天 ${String(rotateC.hour).padStart(2, '0')}:${String(rotateC.minute).padStart(2, '0')} 起 ${rotateC.windowMinutes} 分钟窗口，只换闲置会话）`);
        setTimeout(() => { void sessionRotateTick(); }, 3 * 60 * 1000).unref?.();
      }
    } catch (error) { log('[会话换新] 定时器启动失败：', error?.message ?? error); }
  } catch (error) {
    log(`[日记] 傍晚定时器启动失败：${error?.message ?? error}`);
  }

  // MARKER: world-c2-boot
  // 十分钟看一次点：10 点和 16 点各挑一次；错过 10 点不会在 15 点补。
  try {
    clearInterval(topicsTimer);
    topicsTimer = setInterval(() => { void topicTick(); }, 10 * 60 * 1000);
    // 自己刷 B 站：每 10 分钟问一次要不要刷，真正的间隔由 biliBrowseTick 里判
    setInterval(() => { void biliBrowseTick(); }, 10 * 60 * 1000);
    // 自己学表情：同一个节奏，配额和冷却由 stickerLearnTick 里判
    setInterval(() => { void stickerLearnTick(); }, 10 * 60 * 1000);
    // MARKER: world-events-boot
    // 世界自己冒的事：同一个节奏，幂等（当天有账本就不动），启动 40 秒后先补一次。
    setInterval(() => { void worldEventsTick(); }, 10 * 60 * 1000).unref?.();
    setTimeout(() => { void worldEventsTick(); }, 40 * 1000).unref?.();
    topicsTimer.unref?.();
    setTimeout(() => { void topicTick(); }, 90 * 1000).unref?.();
    log('[谈资] 定时器已排上（10 点 / 16 点各一次）');
  } catch (error) {
    log(`[谈资] 定时器启动失败：${error?.message ?? error}`);
  }

  const SETTLE_SESSION_FILE = path.join(STATE_DIR, 'settle-session.json');
  const settleSessions = new Set();
  const settleTimers = new Map();
  let settleSessionId = null;
  let settleRunning = false;

  function isSettleSession(sessionId) {
    return settleSessions.has(sessionId);
  }

  async function ensureSettleSession() {
    if (settleSessionId && settleSessions.has(settleSessionId)) {
      learnerSessions.add(settleSessionId);
      api.events.follow(settleSessionId);
      return settleSessionId;
    }
    const sc = settleCfg(cfg);
    const preset = resolvePresetName(sc.preset || cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('结算会话缺少已验证的安全 preset，拒绝创建');
    const saved = readJsonSafe(SETTLE_SESSION_FILE, null);
    const dir = path.join(STATE_DIR, 'settle-agent');
    fs.mkdirSync(dir, { recursive: true });
    // MARKER: settle-session-reuse
    // 重启之后 settleSessionId 在内存里是空的，但会话本身还活着。
    // 不接回就每重启一次新建一个会话（白烧一次 create + 一次冷启动）。
    const savedSession = saved && typeof saved === 'object' ? String(saved.__sessionId ?? '') : '';
    if (savedSession) {
      try {
        api.events.follow(savedSession);
        settleSessions.add(savedSession);
        learnerSessions.add(savedSession);
        settleSessionId = savedSession;
        log(`[settle] 复用上次的结算会话：${savedSession}`);
        return savedSession;
      } catch (error) {
        log(`[settle] 上次的结算会话接不回来（${error?.message ?? error}），重建一个`);
      }
    }
    let workspaceId = saved && typeof saved === 'object' ? String(saved.__workspaceId ?? '') : '';
    if (!workspaceId) {
      const ws = unwrap(await api.workspace.create({ path: dir }), 'settle workspace.create');
      workspaceId = ws.workspace.workspaceId;
      try { atomicWriteJson(SETTLE_SESSION_FILE, { __workspaceId: workspaceId, __updatedAt: Date.now() }); } catch {}
    }
    const value = unwrap(await api.sessions.create({ workspaceId, agentPreset: preset }), 'settle session.create');
    const sessionId = value.sessionId;
    api.events.follow(sessionId);
    settleSessions.add(sessionId);
    // 塞进 learnerSessions 是为了让事件循环用「学习会话」那套收集器收她的回答：
    // 有 key 的会话帧会被当成 QQ 会话去发消息，结算会话绝不能走那条路。
    learnerSessions.add(sessionId);
    settleSessionId = sessionId;
    try { atomicWriteJson(SETTLE_SESSION_FILE, { __workspaceId: workspaceId, __sessionId: sessionId, __updatedAt: Date.now() }); } catch {}
    log(`[settle] 结算会话已创建：${sessionId}（preset ${preset}）`);
    return sessionId;
  }

  function dropSettleSession(sessionId) {
    settleSessions.delete(sessionId);
    learnerSessions.delete(sessionId);
    if (settleSessionId === sessionId) settleSessionId = null;
  }

  /** 等一次结算 turn。返回 {promise, cancel}。 */
  function waitSettleTurn(sessionId, timeoutMs) {
    let timer = null;
    const drop = () => {
      const arr = learnerWaiters.get(sessionId) ?? [];
      const idx = arr.findIndex((w) => w.timer === timer);
      if (idx >= 0) arr.splice(idx, 1);
      if (arr.length === 0) learnerWaiters.delete(sessionId);
      if (timer) clearTimeout(timer);
    };
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        drop();
        reject(new Error(`结算超时（${timeoutMs}ms）`));
      }, timeoutMs);
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push({ resolve, reject, timer });
      learnerWaiters.set(sessionId, arr);
    });
    return { promise, cancel: drop };
  }

  async function runSettle(key) {
    const sc = settleCfg(cfg);
    if (!sc.enabled) return;
    if (settleRunning) { log('[settle] 上一次结算还没收工，跳过'); return; }
    const st = getSocialV2State(key);
    if (isConversationBusyV2(key, st)) { log(`[settle] ${key} 正在回合中，等它收工再说`); return; }
    const gate = shouldSettle({ key, st, now: Date.now(), cfg });
    if (!gate.ok) {
      if (gate.reason !== 'cooldown' && gate.reason !== 'too-few') log(`[settle] ${key} 不结算（${gate.reason}）`);
      return;
    }
    // MARKER: settle-slow-gate
    // 渠道太慢就别排这一趟（结算本身有 timeoutMs 兜底，这里只挡「注定超时」的情况）。
    // 阈值看首字延迟：60 秒首字 + 生成必然撑爆 120 秒的 timeoutMs。
    // 不用 slangResearchChannelIsFallback()：那个按「是否在候选链链首」判断，
    // 本部署的日常渠道就配在链尾，按位置判断会把结算永久关掉。
    const _ps = readJsonSafe(path.join(STATE_DIR, 'provider-switch.json'), null) || {};
    const _slowMs = Number(_ps.lastSlowAvgMs) || 0;
    const _strikes = Number(_ps.slowStrikes) || 0;
    const _checkedAt = Number(_ps.lastSlowCheckAt) || 0;
    const _slowLimit = Math.max(0, Number(sc.slowGuardMs) || 0);
    const _slowFresh = _checkedAt > 0 && Date.now() - _checkedAt < 1800000;
    if (_slowLimit > 0 && _slowFresh && _strikes >= 1 && _slowMs >= _slowLimit) {
      log(`[settle] ${key} 渠道太慢（首字 ${_slowMs}ms ≥ ${_slowLimit}ms，role=${_ps.role}），跳过结算`);
      return;
    }

    const lines = pickSettleMessages(st.recentMessages, { maxMessages: sc.maxMessages, maxChars: sc.maxChars });
    if (lines.length < 2) return;
    const known = Object.entries(st.memberImpressions || {})
      .map(([who, v]) => ({ who, text: String((Array.isArray(v?.traits) ? v.traits.slice(-1)[0] : '') ?? '') }))
      .filter((x) => x.text);
    // MARKER: settle-portrait
    // 把她的自述也递给结算：要判断「对某人的看法有没有真的变」，得先知道以前怎么看。
    let selfViewText = '';
    try {
      selfViewText = String(formatPortraitForPrompt(portraitStore()) || '');
    } catch (error) {
      log(`[settle] 自述读取失败：${error?.message ?? error}`);
    }
    // MARKER: world-life-ask
    // 只在「那天还没有安排」时才多问这一段：settle 一天跑很多次，不能每次都写。
    const lc = lifeCfg(cfg);
    let askLifeText = '';
    let lifeTargetDay = '';
    try {
      if (lc.enabled) {
        const want = lifeDayFor(Date.now(), { switchHour: lc.switchHour });
        lifeTargetDay = want.day;
        const lifeStore = readLifeStore();
        if (!lifeStore.days[want.day]) {
          const known = Object.keys(lifeStore.days).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
          const lastDay = known[known.length - 1] || '';
          const prevSummary = lastDay ? summarizeLifeDay(lifeStore, lastDay) : '';
          let moodLabel = '';
          try {
            moodLabel = String(moodStore()?.label || '');
          } catch {}
          askLifeText = buildLifeAsk({
            dayLabel: want.isTomorrow ? '明天' : '今天',
            previous: prevSummary,
            moodLabel,
            maxPlans: lc.maxPlans,
            planChars: lc.planChars
          });
        }
      }
    } catch (error) {
      log(`[life] 生成前检查失败：${error?.message ?? error}`);
    }

    // MARKER: world-b-ask
    // 话题/愿望只在有东西可记、或有话挂到期时才提要求，平时不加输出 token。
    let askWorldText = '';
    try {
      const tc = threadsCfg(cfg);
      const wc = wishesCfg(cfg);
      const threadStore = readThreadsStore();
      const wishStore = readWishesStore();
      const openThreads = (threadStore.items || []).filter((x) => x && x.status === 'open' && String(x.key ?? '') === String(key ?? ''));
      const parts = [];
      if (tc.enabled) parts.push(buildThreadsAsk({ maxInject: tc.maxInject }));
      if (wc.enabled) parts.push(buildWishesAsk({ maxItems: wc.maxInject }));
      if (datesCfg(cfg).enabled) parts.push(buildDatesAsk());
      if (parts.length) {
        parts.push('把结果并进同一个 JSON 里，加这几个可选键：');
        parts.push('- `threads`: 这次新记下的「还挂着的话」；`wishes`: 这次新记下的愿望；`done`: 已经做完的愿望原文；`resolved`: 已经问到答案的话题 id。');
        if (openThreads.length) {
          parts.push('');
          parts.push('已经挂着的（问到答案就把 id 放进 `resolved`）：');
          parts.push(openThreads.slice(0, 6).map((x) => `- ${x.id}：${x.topic}`).join('\n'));
        }
        const wishSummary = summarizeWishes(wishStore, { limit: 6 });
        if (wishSummary && wishSummary !== '（没有）') {
          parts.push('');
          parts.push('愿望清单现在是：');
          parts.push(wishSummary);
        }
        askWorldText = parts.join('\n').slice(0, 1400);
      }
    } catch (error) {
      log(`[world-b] 生成任务段失败：${error?.message ?? error}`);
    }

    const promptText = buildSettlePrompt({
      key,
      isGroup: String(key).startsWith('group:'),
      lines,
      impressions: known,
      selfView: selfViewText,
      lifeAsk: askLifeText,
      worldAsk: askWorldText
    });

    settleRunning = true;
    let settleDone = false;
    try {
      let sessionId = await ensureSettleSession();
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const handle = waitSettleTurn(sessionId, sc.timeoutMs);
        const accepted = await api.sessions.prompt({
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }]
        });
        if (!accepted?.result?.ok) {
          handle.cancel();
          const why = `${accepted?.result?.error?.code}: ${accepted?.result?.error?.message}`;
          if (attempt === 1 && /not[- ]?found|unavailable|不存在/i.test(why)) {
            dropSettleSession(sessionId);
            sessionId = await ensureSettleSession();
            continue;
          }
          log(`[settle] ${key} 提问失败：${why}`);
          return;
        }
        let text = '';
        try {
          text = await handle.promise;
        } catch (turnError) {
          // MARKER: settle-turn-retry
          // 上游偶发 503（"Service temporarily unavailable"）或慢渠道超时：
          // 同一份提示词隔 8 秒再问一次，别把整轮结算丢掉。
          const why = turnError?.message ?? String(turnError);
          try { handle.cancel?.(); } catch {}
          if (attempt < 2) {
            log(`[settle] ${key} 第 ${attempt} 次没问出来（${why}），8 秒后重试`);
            await new Promise((r) => setTimeout(r, 8000));
            continue;
          }
          throw new Error(`${why}（重试后仍失败）`);
        }
        const parsed = parseSettleJSON(text);
        if (!parsed.ok) { log(`[settle] ${key} 解析失败：${parsed.error}`); return; }
        const plan = planSettleWrites(parsed.value, { maxImpressions: sc.maxImpressions });
        // MARKER: diary-draft-write
        // 结算顺手留一份草稿：她之后看到提示词，改两句就是自己的日记。
        if (plan.diary) {
          try {
            const dcw = draftCfg(cfg);
            const draft = normalizeDiaryDraft({ ...plan.diary, day: localDayOf(Date.now()), at: Date.now() }, dcw);
            if (draft) {
              saveDiaryDraft(draft);
              log(`[日记草稿] ${key} 记了一份草稿（${draft.text.slice(0, 16)}…）`);
            }
          } catch (error) {
            log(`[日记草稿] 写入失败：${error?.message ?? error}`);
          }
        }

        let wroteMood = false;
        let moodState = moodStore();
        if (plan.mood) {
          try {
            moodState = setMood(moodState, {
              label: plan.mood.label,
              reason: plan.mood.reason,
              pleasure: plan.mood.pleasure,
              arousal: plan.mood.arousal,
              dominance: plan.mood.dominance
            });
            wroteMood = true;
          } catch (error) {
            log(`[settle] 情绪写入失败：${error?.message ?? error}`);
          }
        }

        // MARKER: notes-and-baseline
        // 手札（压着的事）和底色日结算都挂在这儿：结算本来就在写情绪，
        // 别为一个采样点再多开一次会话。三件事共用一次落盘。
        let wroteNotes = 0;
        for (const item of plan.notes) {
          try {
            moodState = ventUndercurrent(moodState, { text: item.text });
            wroteNotes += 1;
          } catch (error) {
            log(`[settle] 手札写入失败：${error?.message ?? error}`);
          }
        }
        let baseDrift = null;
        try {
          const nowTick = Date.now();
          moodState = recordMoodSample(moodState, { now: nowTick });
          const drift = settleBaseline(moodState, { now: nowTick });
          moodState = drift.state;
          if (drift.moved) baseDrift = drift;
        } catch (error) {
          log(`[settle] 底色结算失败：${error?.message ?? error}`);
        }
        if (wroteMood || wroteNotes || baseDrift) {
          try {
            saveMoodSafe(moodState, '情绪');
          } catch (error) {
            log(`[settle] 情绪落盘失败：${error?.message ?? error}`);
          }
        }
        // MARKER: world-mood-days
        // 心情编年史：一天一格，同一天重复结算就覆盖。趋势由代码算，不让模型发挥。
        try {
          const mc = moodDaysCfg(cfg);
          if (mc.enabled) {
            const rec = recordMoodDay(readMoodDaysStore(), {
              now: Date.now(),
              label: String(moodState.label || ''),
              pad: moodState.pad,
              samples: Array.isArray(moodState.samples) ? moodState.samples.length : 0
            });
            saveMoodDaysStore(pruneMoodDays(rec, { now: Date.now(), keepDays: mc.keepDays }));
          }
        } catch (error) {
          log(`[心情日历] 记录失败：${error?.message ?? error}`);
        }
        let wroteImp = 0;
        for (const item of plan.impressions) {
          // 模型会把 QQ 号当名字写回来，先归到已有键，别让同一个人分身成三条。
          const who = resolveImpressionWho({ key, impressions: st.memberImpressions || {}, who: item.who });
          if (who && applyMemberImpression(st, who, item.text)) wroteImp += 1;
        }
        // MARKER: settle-portrait-write
        // 自述走 portrait-store 的 addPortrait：它自己会校验 facet、限条数、查重。
        // 一条写不进去就跳过这一条，别让自述的问题拖垮整轮结算。
        let wroteSelf = 0;
        for (const item of plan.portraits) {
          try {
            const store = portraitStore();
            addPortrait(store, { subject: item.subject, facet: item.facet, text: item.text });
            savePortraitSafe(store, '画像');
            wroteSelf += 1;
          } catch (error) {
            log(`[settle] 自述写入失败（${item.subject}/${item.facet}）：${error?.message ?? error}`);
          }
        }
        // MARKER: world-life-write
        // 只有这次确实要了这段、且模型给了内容才写；一天只写一次（缺才问）。
        let wroteLife = false;
        if (askLifeText && lifeTargetDay && plan.life) {
          try {
            const normalized = normalizeLifePlan(plan.life, lc);
            if (normalized) {
              saveLifeStore(setLifeDay(readLifeStore(), lifeTargetDay, normalized, { keepDays: lc.keepDays }));
              wroteLife = true;
              // 计划刚写进来，那一天的排程要按新计划重排一次（否则她排的还是旧的空闲格）。
              // force 只在这一刻用：平时绝不重排，避免同一个下午两次说法不一样。
              try {
                const plans = Array.isArray(normalized?.plans) ? normalized.plans : [];
                lifeTimelineFor(Date.now(), { force: true, dayKey: lifeTargetDay });
                log(`[life] 排程已按新计划重建：${lifeTargetDay}（${plans.length} 条）`);
              } catch (error) {
                log(`[life] 重建排程失败：${error?.message ?? error}`);
              }
            }
          } catch (error) {
            log(`[life] 写入失败：${error?.message ?? error}`);
          }
        }
        // MARKER: world-b-write
        // 顺序：先关掉已经问到答案的 → 再并新的 → 最后剪枝。关掉在前，避免同一条被记两次。
        let wroteThreads = 0;
        let wroteWishes = 0;
        try {
          const tc = threadsCfg(cfg);
          if (tc.enabled) {
            let store = readThreadsStore();
            if (plan.resolvedThreads.length) {
              const closed = resolveThreads(store, { ids: plan.resolvedThreads, now: Date.now() });
              store = closed.store;
            }
            if (plan.threads.length) {
              const merged = addThreads(store, { key, who: '', items: plan.threads, now: Date.now(), cfg: tc });
              store = merged.store;
              wroteThreads = merged.added;
            }
            store = pruneThreads(store, { now: Date.now(), cfg: tc });
            saveThreadsStore(store);
          }
        } catch (error) {
          log(`[threads] 写入失败：${error?.message ?? error}`);
        }
        try {
          const wc = wishesCfg(cfg);
          if (wc.enabled) {
            let store = readWishesStore();
            if (plan.doneWishes.length) {
              const done = completeWishes(store, { texts: plan.doneWishes, now: Date.now(), cfg: wc });
              store = done.store;
            }
            if (plan.wishes.length) {
              const merged = addWishes(store, { items: plan.wishes, now: Date.now(), addedBy: '她', cfg: wc, key });
              store = merged.store;
              wroteWishes = merged.added;
            }
            store = pruneWishes(store, { now: Date.now(), cfg: wc });
            saveWishesStore(store);
          }
        } catch (error) {
          log(`[wishes] 写入失败：${error?.message ?? error}`);
        }
        // MARKER: world-c-write
        let wroteDates = 0;
        try {
          const dc = datesCfg(cfg);
          if (dc.enabled && plan.dates.length) {
            const merged = addDates(readDatesStore(), { items: plan.dates, now: Date.now(), cfg: dc, key });
            saveDatesStore(merged.store);
            wroteDates = merged.added;
          }
        } catch (error) {
          log(`[dates] 写入失败：${error?.message ?? error}`);
        }
        settleDone = true;
        st.lastSettleAt = Date.now();
        if (wroteMood || wroteImp || wroteSelf) saveSocialV2State();
        const moodNote = wroteMood ? `「${plan.mood.label}」` : '无变化';
        const skipNote = plan.skippedImpressions ? `（${plan.skippedImpressions} 条超限没写）` : '';
        const selfNote = wroteSelf ? `，自述 ${wroteSelf} 条` : '';
        const skipSelfNote = plan.skippedPortraits ? `（${plan.skippedPortraits} 条自述超限没写）` : '';
        const noteNote = wroteNotes ? `，手札 ${wroteNotes} 条` : '';
        const lifeNote = wroteLife ? `，日程 ${lifeTargetDay} 记下` : '';
        const driftNote = baseDrift
          ? `，底色 ${Object.entries(baseDrift.delta)
              .filter(([, v]) => v)
              .map(([k, v]) => `${k}${v > 0 ? '+' : ''}${v}`)
              .join(' ')}`
          : '';
        log(`[settle] ${key} 结算完成：情绪${moodNote}，印象 ${wroteImp} 条${skipNote}${selfNote}${skipSelfNote}${noteNote}${driftNote}${lifeNote}`);
        return;
      }
    } catch (error) {
      log(`[settle] ${key} 出错：${error?.message ?? error}`);
    } finally {
      settleRunning = false;
      // 没成也要记一笔：否则慢渠道/JSON 不合规时，每个回合收工都会再白试一次。
      if (!settleDone) {
        st.lastSettleAt = Date.now();
        saveSocialV2State();
        log(`[settle] ${key} 这轮没成，冷却 ${Math.round((Number(sc.cooldownMs) || 0) / 60000)} 分钟后再试`);
      }
    }
  }

  function scheduleSettle(key) {
    const sc = settleCfg(cfg);
    if (!sc.enabled) return;
    if (settleTimers.has(key)) return;
    const timer = setTimeout(() => {
      settleTimers.delete(key);
      runSettle(key).catch((error) => log(`[settle] ${key} 未捕获：${error?.message ?? error}`));
    }, sc.delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    settleTimers.set(key, timer);
  }

  function turnBudgetCfg(key) {
    const b = cfg.socialV2?.turnBudget ?? {};
    const pick = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
    // 正常回合 2–10 分钟 / 10–15 次工具 / 2–4 条发送，这里留 3–4 倍余量
    let maxSends = pick(b.maxSends, 8);
    let maxMs = pick(b.maxMs, 600000);
    // MARKER: per-group-override —— 单个群单独收紧每轮发送条数。
    // 优先级：按群覆盖 > 全局。只降低不抬高（Math.min），避免覆盖成了开后门。
    const keyStr = String(key ?? '');
    if (keyStr.startsWith('group:')) {
      const ov = cfg.socialV2?.wake?.overrides?.[keyStr.slice(6)];
      const n = Number(ov?.turnMaxSends);
      if (Number.isFinite(n) && n > 0) maxSends = Math.min(maxSends, Math.floor(n));
    }
    // MARKER: owner-turn-budget —— 主人私聊单独放宽每轮条数 / 时长。
    // 方向与群覆盖相反：那边是「收紧防刷屏」（Math.min），这边是「信任授予」（Math.max）。
    // 语义是「主人至少这么多条」：全局值往上调，owner 跟着涨；全局往下调，owner 仍按
    // ownerMaxSends 给（因为那是显式的信任授予）。所以要收紧主人，改的是 ownerMaxSends
    // 本身或删掉它，不是改全局 —— 别指望调小 maxSends 能连带把主人按住。
    // 起因（2026-10-26 21:26:07 实测）：private:1124721191 只跑了 97s / 4 步就发满 6 条被
    // 「发送 6 条 > 5」掐掉 —— 全局 5 条是按群聊防刷屏定的，主人私聊里这是误伤。
    const ownerKey = cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
    if (ownerKey && keyStr === ownerKey) {
      maxSends = Math.max(maxSends, pick(b.ownerMaxSends, maxSends));
      maxMs = Math.max(maxMs, pick(b.ownerMaxMs, maxMs));
    }
    // MARKER: friend-turn-budget —— 好友私聊（非主人）也放宽每轮条数。
    // 需求（2026-10-27）：主人在私聊里还是老撞 5 条，好友同样。全局 5 条是按群里防刷屏定的，
    // 一对一聊天里纯属误伤 —— 私聊没有"刷屏打扰一屋子人"的问题。
    // 与群覆盖方向相反（Math.max），语义同样是「至少这么多条」，只升不降。
    // 只放宽条数，不动 maxMs：私聊没必要跟着变长，那是另一件事。
    if (keyStr.startsWith('private:') && keyStr !== ownerKey) {
      maxSends = Math.max(maxSends, pick(b.privateMaxSends, maxSends));
    }
    return { maxSteps: pick(b.maxSteps, 40), maxMs, maxSends };
  }
  function turnBudgetFor(sessionId) {
    let entry = turnBudgetLedger.get(sessionId);
    if (!entry) {
      entry = { startedAt: Date.now(), steps: 0, sends: 0, cancelled: false, reason: '' };
      turnBudgetLedger.set(sessionId, entry);
    }
    return entry;
  }
  function readGraceNotes() {
    try {
      const parsed = JSON.parse(fs.readFileSync(TURN_BUDGET_GRACE_FILE, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : {};
    } catch { return {}; }
  }
  function writeGraceNote(key, note) {
    try {
      const notes = readGraceNotes();
      if (note) notes[key] = note; else delete notes[key];
      const trimmed = Object.fromEntries(Object.entries(notes).slice(-50));
      const tmp = `${TURN_BUDGET_GRACE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ notes: trimmed }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, TURN_BUDGET_GRACE_FILE);
    } catch (error) {
      log('[turn-budget] 写 grace 失败：', error?.message ?? error);
    }
  }
  function noteTurnBudgetStep(key, sessionId) {
    if (!key || !sessionId) return;
    const b = turnBudgetCfg(key);
    const entry = turnBudgetFor(sessionId);
    entry.steps += 1;
    if (entry.cancelled) return;
    if (entry.steps > b.maxSteps) { void cancelTurnForBudget(key, sessionId, entry, `步数 ${entry.steps} > ${b.maxSteps}`); return; }
    if (Date.now() - entry.startedAt > b.maxMs) { void cancelTurnForBudget(key, sessionId, entry, `时长超 ${Math.round(b.maxMs / 60000)} 分钟`); }
  }
  // MARKER: turn-budget-by-messages —— 按「实际发出的条数」记账。
  // 旧版固定 +1，而 qq_send_burst 一次可带 burstMaxMessages 条，
  // maxSends=8 的真实语义变成「8 次调用」，实际最多能发 8 × burstMaxMessages 条。
  function noteTurnBudgetSend(key, sessionId, count = 1) {
    if (!key || !sessionId) return;
    const b = turnBudgetCfg(key);
    const entry = turnBudgetFor(sessionId);
    const n = Math.max(1, Math.floor(Number(count) || 1));
    entry.sends += n;
    if (entry.cancelled) return;
    if (entry.sends > b.maxSends) { void cancelTurnForBudget(key, sessionId, entry, `发送 ${entry.sends} 条 > ${b.maxSends}`); }
  }
  // 掐回合。不抛错：调用方是 tool/result 处理流，抛了会连带吞掉正常逻辑。
  async function cancelTurnForBudget(key, sessionId, entry, why) {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.reason = why;
    abortReasonByKey.set(key, why);
    const elapsedMs = Date.now() - entry.startedAt;
    log(`[turn-budget] 超上限（${why}）：${key} 已跑 ${Math.round(elapsedMs / 1000)}s / ${entry.steps} 步 / ${entry.sends} 条，掐掉本回合`);
    appendActivity(`${key} [turn-budget] 超上限（${why}），已中止回合`);
    // stopSessionWork = 清队列 + session/cancel + archiveSession，是桥接现成且唯一的
    // 「让 DSH 停下这个会话」入口（见 stopRetiredSessionWork 的注释）。别自己拼 cancel。
    try {
      await api.stopSessionWork(sessionId);
    } catch (error) {
      log('[turn-budget] 中止回合失败（DSH 侧可能仍在内跑）：', error?.message ?? error);
    }
    writeGraceNote(key, {
      at: Date.now(), reason: why,
      elapsedSec: Math.round(elapsedMs / 1000), steps: entry.steps, sends: entry.sends
    });
    // MARKER: cancel-cooldown —— 掐断后给一段冷却，否则下一批消息立刻又把她叫醒，
    // 惩罚等于没罚（实测 11:12:59 掐断，39 秒后又被唤醒）。
    // 私聊不加冷却：主人找她不该被沉默。
    const cfgCooldown = Number(cfg.socialV2?.turnBudget?.cancelCooldownMs);
    const cooldownMs = Number.isFinite(cfgCooldown) && cfgCooldown >= 0 ? cfgCooldown : 5 * 60 * 1000;
    if (!String(key).startsWith('private:') && cooldownMs > 0) {
      cancelCooldownUntil.set(key, Date.now() + cooldownMs);
      log(`[turn-budget] ${key} 进入 ${Math.round(cooldownMs / 1000)}s 冷却，期间不安排新唤醒`);
    }
  }
  // key -> 掐断冷却截止时间
  const cancelCooldownUntil = new Map();
  // MARKER: abort-reason-by-key —— key -> 回合被掐的原因（时长超限 / 条数超限）。
  // 供 ended.reason.kind === 'aborted' 分支拼诊断用，免得只发一句没头没尾的「已停止」。
  const abortReasonByKey = new Map();
  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”
  // MARKER: role-card-refresh —— 会话 -> 最近一次已注入的角色卡指纹。
  // 进程重启后为空，所以每个会话重启后第一次唤醒会重注入一次，属于预期行为。
  const roleCardInjectSeen = new Map();
  // MARKER: world-home —— 会话 -> 最近一次已注入的住处块指纹。
  // 与角色卡同一套判重：进程重启或会话换新后为空，于是重注入一次，属预期。
  const worldHomeSeen = new Map();
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // reserved2 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        || (slangResearchSessionId && sessionId === slangResearchSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });
  // MARKER: modules-ctx-tokens
  // Token 用量账本模块：tokenLedger / priceTable 都是只建一次的 const，
  // 之后只调方法、不改引用，所以直接交引用是安全的。
  Object.assign(moduleCtx, { tokenLedger, priceTable });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
    // MARKER: turn-context-restore —— 恢复回合的同时要把「当前回合上下文」登记回去。
    // 起因（2026-10-27 16:52:58 实测）：重启后 session-c603df85（private:1124721191）的回合被
    // 上面这段恢复了，但 __qqTurnContexts 是空的 —— 那个还在跑的回合去调生图工具，被
    // imageAllowedNow 判成「没有回合上下文」直接拒掉。回复保住了，额度丢了。
    // 修法：用 sessionId→key 的反查表把 ctx 补回来；已经有 ctx 的不覆盖（运行中的重连别打架）。
    const convKey = reverse.get(sessionId);
    if (convKey && !activeTurnCtx(convKey)) {
      setActiveTurnCtx({ key: convKey, reason: 'resume', at: Date.now() });
      log(`重连后恢复了回合上下文（${convKey} <- ${sessionId}）`);
    }
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  // MARKER: modules-ctx-test-send
  // /api/test-send 的依赖：modeAllowed / redactKnownTokensOnly 是本作用域里
  // 后文才声明的函数，只能写在箭头函数体里（对象字面量位置会触发 TDZ）；
  // bot 在 L14045 才 new 出来，必须走访问器读实时值。
  Object.assign(moduleCtx, {
    allowed: (kind, id, config) => allowed(kind, id, config),
    modeAllowed: (key, kind, id, config, mode) => modeAllowed(key, kind, id, config, mode),
    redactKnownTokensOnly: (value) => redactKnownTokensOnly(value),
    bot: () => bot,
    onebotHttpAction: (action, params) => onebotHttpAction(action, params),
    SENSITIVE_RE,
    escapeCqText: (value) => escapeCqText(value),
  });
  // MARKER: modules-ctx-status
  // /api/status 的依赖：前五个是「会被重新赋值 / 字段会被就地改写」的状态，
  // 一律交访问器；readActivityTail 是顶层函数目录里的纯读函数，直接交引用。
  Object.assign(moduleCtx, {
    currentMode: () => currentMode,
    dshReady: () => dshReady,
    closedAgentPreset: () => closedAgentPreset,
    socialV2: () => socialV2,
    readActivityTail: (n) => readActivityTail(n),
    snowlumaHealthSnapshot: () => snowlumaHealthSnapshot(),
  });
  // MARKER: modules-ctx-dashboard
  // 统一面板（src/modules/dashboard/）的依赖。
  //  - os：顶部 import（src/bridge.js:9），纯内存读，可直接进值位置；
  //  - appStartedAt：求值即得，用来算进程 uptime，不碰 systemd；
  //  - readRoleState：文件级纯函数，声明在 :747 —— 比注入点早，可以直接进值位置，
  //    但还是包成箭头，跟其它块保持同一形态，以后挪位置也不会踩 TDZ。
  Object.assign(moduleCtx, {
    os,
    appStartedAt: Date.now(),
    readRoleState: () => readRoleState(),
    // 跨域检索（src/modules/search/）要的会话键清单。
    // 为什么用箭头：`socialV2` 在 :7810 才声明（比这个注入点晚），
    // 直接写进值位置会撞 TDZ；箭头延迟到调用时才求值。
    conversationKeys: () => Array.from(socialV2.conversations.keys()),
    // 运行备注（S3）要写盘：atomicWriteJson 在 :302 声明，比注入点早，可进值位置；
    // 但跟上面保持同一形态，包箭头。
    atomicWriteJson: (file, obj) => atomicWriteJson(file, obj),
  });
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  // MARKER: mode-boot-hint
  // 为什么要有这段：真正的模式要等 DSH 回话后 refreshMode() 才读到，而 HTTP 服务在
  // 那之前就已经 listen 了 —— 中间这几秒里 currentMode 还是上面那个 'chat' 初值，
  // 于是任何带 x-agent-token 的 /api/socialV2/* 调用都会被总闸挡成
  // 「该接口仅 reserved2 模式可用」。实测代价：2026-10-28 18:04 她想收藏一张表情，
  // 恰好撞上 provider 切换触发的重启窗口（模式 18:04:15 才确认），收藏失败并被她理解成
  // 「收藏这个口子我这边是关着的」。
  // 先用控制台自己写的 state/mode.json 垫底（那里就是最后一次人工/控制台设定的模式），
  // DSH 活着以后 refreshMode() 会用 DSH 设置覆盖它 —— 顺序不变，只是初值不再是假的 'chat'。
  {
    const bootLocal = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const bootMode = bootLocal ? normalizeModeInput(bootLocal.mode) : null;
    if (bootMode) {
      currentMode = bootMode;
      log(`[mode] 启动时按 state/mode.json 预置模式：${bootMode}（等 DSH 就绪后再以 DSH 设置为准）`);
    }
  }
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      if (presetNs?.value && typeof presetNs.value.default === 'string' && presetNs.value.default) {
        dshDefaultPreset = presetNs.value.default;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      const fromDsh = ns?.value ? normalizeModeInput(ns.value.mode) : null;
      if (fromDsh) {
        // MARKER: mode-change-log
        // 以前模式切换完全静默：只会在 DSH 首次就绪时打一行「模式: X」，
        // 之后从 chat 换成 reserved2 还是反过来，日志里一点痕迹都没有，
        // 排查「为什么工具突然全 403」只能靠猜。这行是给自己留的自证。
        if (fromDsh !== currentMode) log(`[mode] 桥接模式切换：${currentMode} -> ${fromDsh}（来源：DSH 设置）`);
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；未设置该字段时不覆盖 config.json。
        if (ns.value.ownerQQ !== undefined) {
          try {
            cfg.ownerQQ = normalizeOwnerQQ(ns.value.ownerQQ);
          } catch (error) {
            log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / reserved2（仿真模式）
    // 被动收消息：走 allowed()（含 friendOnly「仅好友」档位）
    return allowed(kind, id, cfg);
  }

  /**
   * 主动发起的准入（比 modeAllowed 更严）。
   *
   * 需求：「好友都能聊，但 AI 不主动找他们」——
   *   被动收消息 → allowed()（friendOnly 时任何好友都行）
   *   主动唤醒/冒泡 → 只允许 allow 白名单里的对象
   *
   * 注意必须保留 modeAllowed 的其余判定（含 closed-agent 仅 owner），
   * 所以先过 modeAllowed，再叠加白名单成员检查。
   */
  function proactiveAllowed(key, kind, id, cfg, mode) {
    // MARKER: self-user-id —— 绝不主动找自己。白名单里历史上混进了自己的号
    // （allow.private 含 2157801858），会让幽灵会话 private:<自己> 排上档期，
    // 到点就「主动给主人自己发私聊」。这里兜住，不依赖白名单配置是否正确。
    if (selfUserId && String(id) === selfUserId) return false;
    if (!modeAllowed(key, kind, id, cfg, mode)) return false;
    // 主动侧永远要求显式白名单：friendOnly 放宽的是"接收"，不是"主动打扰"。
    const list = cfg.allow?.[kind] ?? cfg.allow?.[kind + 's'] ?? [];
    if (list.length === 0) return false;          // 白名单为空 ⇒ 不主动找任何人
    return list.map(String).includes(String(id));
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / reserved2，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node scripts/setup-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 二代仿真模式优先使用 socialV2.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的二代状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await api.stopSessionWork(sessionId); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await api.workspace.archiveSession({ sessionId }); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 清掉「按会话 key 记账」的内存态。
   *
   * 为什么单独抽出来：这些 Map/Set 分散在文件各处，退役路径（retireSession）、
   * 手动重置（/api/session/reset、/reset、workspace reset）、二代状态重置
   * 各自只清了其中一部分 —— 于是「哪个 key 清哪个不清」完全靠人记。
   * 结果是有界但真实的慢性泄漏：被移出白名单的会话，其 lastSendFailed、
   * 限流时间戳会一直留在内存里。所有撤销会话映射的路径都必须调用这里。
   */
  function forgetConversationCaches(key) {
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
  }

  // MARKER: session-rotate-runtime —— 每天换新会话。
  // 只清「映射 + 会话级缓存」，社交状态（recentMessages/memberImpressions/life/threads/wishes/dates/diary）全部保留：
  // 她的连续性靠 state，不靠 DSH 的会话历史 —— 这也是敢每天换的前提。
  const SESSION_ROTATE_FILE = path.join(STATE_DIR, 'session-rotate.json');
  function readRotateState() {
    const raw = readJsonSafe(SESSION_ROTATE_FILE, { days: {} });
    const days = raw && typeof raw.days === 'object' && raw.days ? raw.days : {};
    return { days };
  }
  function saveRotateState(next) {
    try { atomicWriteJson(SESSION_ROTATE_FILE, { days: pruneRotateDays(next.days, rotateDayOf(Date.now()), 7) }); }
    catch (error) { log('[会话换新] 记账写盘失败：', error?.message ?? error); }
  }
  function rotateLastActivity(key) {
    const st = socialV2?.conversations?.get(key);
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    let last = Number(st?.lastIncomingAt) || 0;
    for (const m of recent) last = Math.max(last, Number(m?.time) || 0);
    return last;
  }
  async function rotateOneSession(key) {
    const old = state.sessions[key];
    if (!old) return false;
    try { if (typeof sessionEpoch === 'number') sessionEpoch += 1; } catch {}
    // 换之前先写交接条：新会话第一轮才能接上昨天的话（失败不影响换会话）。
    await generateContinuity(key);
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    modelAppliedSessions.delete(old);
    reverse.delete(old);
    collectors.delete(old);
    sendToolSucceededSessions.delete(old);
    pendingSendToolCalls.delete(old);
    v2TurnStartAt.delete(old);
    toolCallNames.delete(old);
    social.silentTurns.delete(old);
    social.exitingSessions.delete(old);
    sessionModels.delete(old);
    // 角色卡指纹要一起忘掉：新会话得重新注入一次，否则她会没有角色卡。
    roleCardInjectSeen.delete(key);
    worldHomeSeen.delete(key);
    saveState();
    try { await api.stopSessionWork(old); } catch {}
    try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
    log(rotateLine(key, old));
    return true;
  }
  let rotateRunning = false;
  async function sessionRotateTick() {
    if (rotateRunning) return;
    const rc = rotateCfg(cfg);
    if (!rc.enabled) return;
    const now = Date.now();
    const today = rotateDayOf(now);
    const rs = readRotateState();
    const done = new Set(Array.isArray(rs.days?.[today]?.keys) ? rs.days[today].keys : []);
    const news = [];
    for (const key of Object.keys(state.sessions)) {
      if (done.has(key)) continue;
      const busy = isConversationBusyV2(key, socialV2.conversations.get(key));
      const verdict = shouldRotate(key, { now, cfg: rc, lastDay: done.has(key) ? today : null, busy, lastActivityAt: rotateLastActivity(key) });
      if (!verdict.rotate) continue;
      news.push(key);
    }
    if (!news.length) {
      // 窗口里但没有可换的（都在忙/刚说话）：记一笔 attemptedAt，避免刷日志。
      // MARKER: rotate-retry —— 2026-10-29
      // 原来只要 attemptedAt 存在就 return，于是一次「都在忙」就把整个 90 分钟窗口废掉：
      // 实测 2026-10-29 04:18:05 记了一次（keys 空），到 05:40 窗口结束都没再试，
      // 当天一个会话都没换新（每天换新是省钱主力，等于白丢一天）。
      // 现在改成「距上次尝试不足 15 分钟才跳过」，窗口内会自然重试。
      const lastTry = Number(rs.days?.[today]?.attemptedAt || 0);
      if (lastTry && now - lastTry < 15 * 60 * 1000) return;
    }
    rotateRunning = true;
    try {
      const swapped = [];
      for (const key of news) {
        try { if (await rotateOneSession(key)) swapped.push(key); }
        catch (error) { log(`[会话换新] ${key} 失败：${error?.message ?? error}`); }
      }
      const next = readRotateState();
      const prevKeys = Array.isArray(next.days?.[today]?.keys) ? next.days[today].keys : [];
      next.days[today] = { keys: [...new Set([...prevKeys, ...swapped])], at: Date.now(), attemptedAt: Date.now() };
      saveRotateState(next);
      if (swapped.length) log(`[会话换新] 今天已换 ${swapped.length} 个会话：${swapped.join(', ')}`);
    } finally {
      rotateRunning = false;
    }
  }

  function retireSession(key) {
    const sessionId = state.sessions[key];
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    // 按 key 记账的内存态在**有映射和无映射时都要清**：一条被移出白名单、
    // 但从未成功建过会话的 key 同样会留下限流时间戳与失败标记。
    forgetConversationCaches(key);
    if (!sessionId) return;
    reverse.delete(sessionId);
    collectors.delete(sessionId);
    sessionModels.delete(sessionId);
    modelAppliedSessions.delete(sessionId);
    sendToolSucceededSessions.delete(sessionId);
    pendingSendToolCalls.delete(sessionId);
    v2TurnStartAt.delete(sessionId);
    toolCallNames.delete(sessionId);
    social.silentTurns.delete(sessionId);
    social.exitingSessions.delete(sessionId);
    // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开一条
    // follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
    api.events.forget?.(sessionId);
    const entry = pending.get(key);
    if (entry) { clearTimeout(entry.timer); void cancelPendingEntry(entry).catch(() => {}); }
    pending.delete(key);
    clearSocialV2Timers(key);
    cancelSocialTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    const st = socialV2.conversations.get(key);
    if (st) {
      // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
      st.agentToken = crypto.randomBytes(24).toString('hex');
      rememberAgentToken(key, st.agentToken);
      st.bootstrapSent = false;
      st.modelSeenSeqs = new Set();
    }
    saveState();
    saveSocialV2State();
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["reserved2","",null]` —— 与已存的 `["reserved2","qq-chat-v2",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'reserved2') {
          // 首次确定模式为 reserved2 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已确定为 reserved2，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开一代仿真模式，清理社交状态');
        }
        if (lastMode === 'reserved2' && currentMode !== 'reserved2') {
          clearAllSocialV2Timers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          log('桥接模式已离开二代仿真模式，清理 reserved2 定时器与排队投递');
        }
        if (currentMode === 'reserved2' && lastMode !== 'reserved2') {
          for (const key of socialV2.conversations.keys()) {
            setupSleepTimerV2(key);
            scheduleProactiveCheckV2(key);
          }
          log('桥接模式已进入二代仿真模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「qq-bridge 注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `src/mcp-snowluma-safe.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
    // ── WS 看门狗观测（见 startWsWatchdog）──
    lastConnectError: '',      // 最近一次 connect() 失败原因
    lastConnectErrorAt: 0,
    watchdogRevives: 0,        // 看门狗累计强制重连次数
    watchdogLastAt: 0,
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── WS 看门狗：SDK 自动重连失效时的最后一道保险 ─────────────────────────────
  //
  // 为什么需要它（这是「WS 断了必须人工 systemctl restart」的真正根因）：
  //   SDK 的 close() 会把内部的 closedByUser 置 true，而这个标志**只有
  //   connect() 会清回 false**。桥接在 token 热切换时是 close() + connect()
  //   连着调用的；只要 connect() 那一步失败（异步 rejection 被空的 try/catch 吞掉），
  //   closedByUser 就永久停在 true —— SDK 的退避重连据此判断「是用户主动关的，
  //   不该重连」，于是**再也不发起任何连接**。进程还活着、日志还在刷「重连中…」，
  //   但链路永远不会再通。SDK 自身没有任何「重连久未成功」的出口。
  //
  // 看门狗不碰 SDK 内部字段，只用两个可信的外部事实：
  //   · bot.isConnected —— 底层 socket 是否 OPEN，SDK 的公开 getter；
  //   · 连续多次采样都为 false —— 证明不是瞬时抖动。
  // 满足条件就 close() + connect() 一次，把 closedByUser 重新清回 false。
  const WS_WATCHDOG_INTERVAL_MS = 60_000;    // 采样周期
  const WS_WATCHDOG_FAILS_BEFORE_REVIVE = 3; // 连续 3 次（约 3 分钟）不通才动手
  const WS_WATCHDOG_BACKOFF_MS = 5 * 60_000; // 同一轮故障里最快每 5 分钟重连一次
  let wsWatchdogStarted = false;
  let wsWatchdogFails = 0;
  let wsWatchdogLastReviveAt = 0;

  /**
   * 启动 WS 看门狗。
   * @param {() => ({ isConnected: boolean, connect: () => Promise<void>, close: (c?: number, r?: string) => void })} getBot
   *   延迟取 bot 的取值器。**必须传函数而不是对象**：bot 在 main() 里声明得比这里
   *   晚得多（`const`，TDZ），直接引用会在启动瞬间抛
   *   「Cannot access 'bot' before initialization」。
   */
  function startWsWatchdog(getBot) {
    if (wsWatchdogStarted) return;
    wsWatchdogStarted = true;
    const timer = setInterval(() => {
      let b;
      try { b = getBot(); } catch { return; }
      if (!b) return;
      if (b.isConnected) {
        if (wsWatchdogFails > 0) log(`[ws-watchdog] 连接已恢复（此前连续 ${wsWatchdogFails} 次不通）`);
        wsWatchdogFails = 0;
        return;
      }
      wsWatchdogFails += 1;
      if (wsWatchdogFails < WS_WATCHDOG_FAILS_BEFORE_REVIVE) return;
      const now = Date.now();
      if (now - wsWatchdogLastReviveAt < WS_WATCHDOG_BACKOFF_MS) return;
      wsWatchdogLastReviveAt = now;
      snowlumaHealth.watchdogRevives += 1;
      snowlumaHealth.watchdogLastAt = now;
      log(`[ws-watchdog] WS 已连续 ${wsWatchdogFails} 次采样不通，强制重连（第 ${snowlumaHealth.watchdogRevives} 次）`);
      // 先 close 再 connect：close() 会清掉 SDK 的 socket 与 connectPromise，
      // 让 connect() 走完整流程并把 closedByUser 清回 false —— 这正是自愈的关键一步。
      // 但 close() 会把 closedByUser 置 true，所以两步必须绑在一起，且 connect() 必须接住失败。
      try { b.close(1000, 'watchdog'); } catch (error) {
        log(`[ws-watchdog] close 异常（忽略，继续 connect）：${error?.message ?? error}`);
      }
      Promise.resolve()
        .then(() => b.connect())
        .then(() => log('[ws-watchdog] 已重新发起连接'))
        .catch((error) => {
          snowlumaHealth.lastConnectError = error?.message ?? String(error);
          snowlumaHealth.lastConnectErrorAt = Date.now();
          log(`[ws-watchdog] 强制重连失败：${snowlumaHealth.lastConnectError}`);
        });
    }, WS_WATCHDOG_INTERVAL_MS);
    timer.unref?.();
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  /**
   * 解析某个会话适用的发送频率阈值。
   *
   * 全局字段 maxSendPerMinute / maxSendPerHour 对所有会话生效；
   * 群聊可用 maxSendPerMinuteInGroup / maxSendPerHourInGroup 单独放慢，
   * 未配置（null/空/非法）时回退到全局值 —— 保证旧配置行为不变。
   */
  function resolveSendLimitsV2(key, sendCfg) {
    const isGroup = String(key ?? '').startsWith('group:');
    const pick = (globalKey, groupKey) => {
      const g = Number(sendCfg?.[globalKey]) || 0;
      if (!isGroup) return g;
      const raw = sendCfg?.[groupKey];
      if (raw === null || raw === undefined || raw === '') return g;   // 未配置 ⇒ 回退全局
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : g;
    };
    return {
      maxPerMinute: pick('maxSendPerMinute', 'maxSendPerMinuteInGroup'),
      maxPerHour: pick('maxSendPerHour', 'maxSendPerHourInGroup'),
      isGroup,
    };
  }

  /**
   * 解析某个会话适用的「唤醒频率」阈值。
   *
   * 全局 autoReplyCheckMs / wake.maxWakePerHour 对所有会话生效；
   * 群聊可用 *InGroup 单独调慢，未配置（null/空/非法）时回退全局值，
   * 保证私聊与旧配置行为完全不变。
   */
  function resolveWakeLimitsV2(key) {
    const isGroup = String(key ?? '').startsWith('group:');
    const g = cfg.socialV2 ?? {};
    const w = g.wake ?? {};
    const pick = (globalVal, groupVal, fallback) => {
      const base = Number(globalVal);
      const baseOk = Number.isFinite(base) && base > 0 ? base : fallback;
      if (!isGroup) return baseOk;
      if (groupVal === null || groupVal === undefined || groupVal === '') return baseOk;
      const n = Number(groupVal);
      return Number.isFinite(n) && n > 0 ? n : baseOk;
    };
    // MARKER: per-group-override —— 单个群单独收紧的口子。
    // 起因：906710082 在 12:32~12:40 八分钟内发了 15 条（多轮唤醒叠加，
    // 每轮 1~2 条都在上限内，但没人管「一段时间内累计多少」）。
    // 全局收紧会误伤私聊和正常群，所以用「按群覆盖」而不是改全局值。
    const ov = (isGroup && w.overrides && w.overrides[String(key).slice(6)]) || {};
    const pickOv = (base, o) => {
      const n = Number(o);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : base;
    };
    return {
      autoReplyCheckMs: pick(g.autoReplyCheckMs, g.autoReplyCheckMsInGroup, 30000),
      maxWakePerHour: pickOv(pick(w.maxWakePerHour, w.maxWakePerHourInGroup, 12), ov.maxWakePerHour),
      maxWakePerMinute: pickOv(Number(w.maxWakePerMinute) > 0 ? Number(w.maxWakePerMinute) : 0, ov.maxWakePerMinute),
      // MARKER: wake-quarter —— 15 分钟短窗口。5 条/小时这套滑动窗口天生「爆发完就哑」：
      // 实测 2026-10-30 19:15~19:26 八分钟连发 5 条把整小时额度用光，之后 52 分钟一句说不出。
      // 总量不变，只是不许一口气花完。0 / 不配 = 不限。
      maxWakePerQuarterHour: pickOv(pick(w.maxWakePerQuarterHour, w.maxWakePerQuarterHourInGroup, 0), ov.maxWakePerQuarterHour),
      turnMaxSends: pickOv(0, ov.turnMaxSends),
      isGroup,
    };
  }

  // MARKER: shared-memory-wire
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
      fs.appendFileSync(SHARED_MEMORY_AUDIT_FILE, `${line}\n`, { mode: 0o600 });
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
    const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
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
  // MARKER: auto-memory-write
  // 代码层自动记忆：每回合收工时，从这回合收到的用户消息里抽一条值得记住的话写进 shared-memory。
  // 主人 2026-10-24 明确要求「直接做代码层的自动写入」——记忆工具靠她自觉调用，实测三个月 0 次。
  function autoRememberFromTurn(key, userText) {
    try {
      if (!key || !userText) return;
      if (cfg.socialV2?.autoMemory?.enabled === false) return;
      const who = String(key).startsWith('private:') ? '主人' : '有人';
      const best = extractMemories(userText, { max: 1, who })[0];
      if (!best) return;
      const store = loadSharedMemoryState();
      if (!store) return;
      const scope = scopeForText(best.text);
      const { created } = addItem(store, { text: best.text, scope, importance: best.importance, sourceRef: key });
      if (created) {
        saveSharedMemoryState();
        log(`[auto-memory] 记住（${scope}）：${best.text}`);
      }
    } catch (error) {
      log(`[auto-memory] 抽取失败：${error?.message ?? error}`);
    }
  }

  function buildSharedMemoryLineFor(key) {
    if (cfg.socialV2?.sharedMemory?.enabled === false) return '';
    const reader = sharedMemoryReaderFor(key);
    if (!reader) return '';
    const store = getSharedMemoryState();
    if (!store) return '';
    // MARKER: shared-memory-maxchars
    // 这里不能调 bounded() —— 它是 buildWakeSnapshotV2 内部的局部箭头函数
    // （同一份文件、但另一个作用域），模块层拿不到它，调了就是运行期
    // ReferenceError: bounded is not defined。而这一行是**每条唤醒 prompt 都会走**
    // 的路径，一旦抛错就是整条唤醒失败（2026-10-22 20:08:33 主人私聊唤醒即栽于此）。
    // 所以就地夹紧，读的还是同一个 cfg.socialV2.context，键名保持一致。
    const smContext = cfg.socialV2?.context ?? {};
    const smWant = Number(smContext.sharedMemoryMaxChars ?? SHARED_MEMORY_INJECT_MAX_CHARS);
    const maxChars = Number.isFinite(smWant)
      ? Math.min(2000, Math.max(200, Math.round(smWant)))
      : SHARED_MEMORY_INJECT_MAX_CHARS;
    const text = formatForPrompt(store, {
      reader,
      max: SHARED_MEMORY_INJECT_MAX_ITEMS,
      maxChars
    });
    if (!text) return '';
    return `${text}\n\n`;
  }

  /** 会话 key 是否为本群（用来判定 group:X 条目归属）。 */
  function sharedMemoryGroupIdOf(key) {
    const m = /^group:(\d+)$/.exec(String(key ?? '').trim());
    return m ? m[1] : null;
  }


  // MARKER: share-signal-wire
  // ── 主动报告的接线层 ────────────────────────────────────────────────
  // 这里只做四件事：读写文件、留审计、问一次「现在能不能报」、把报告变成一次唤醒。
  // 所有判断（冷却、安静时段、未回应退避、暂停）都在 share-signal-store.js ——
  // 两边各写一套迟早会走偏。
  //
  // 一条硬规则在这里再落一次：报告只能由群事件触发。store 侧的 addSignal 已经
  // 拒掉 private: 来源，路由那边还会再要求 sourceGroup === 当前会话 key。
  // MARKER: phone-bridge-offline-decl
  let phoneOfflineLoggedAt = 0;
  let shareStateCache = null;
  let shareSkipLoggedAt = 0;
  let shareSkipLoggedReason = '';
  // 观察模式下「已经念过哪条」，免得同一条信号每 30 秒刷一次日志。
  let shareObservedSignalId = '';

  // 审计日志独立一份：不占 share-signal.json，也方便主人直接翻。
  const SHARE_SIGNAL_AUDIT_FILE = path.join(STATE_DIR, 'share-signal-audit.jsonl');

  function loadShareStateOrNull() {
    try {
      const st = loadShareState(SHARE_SIGNAL_FILE);
      shareStateCache = st;
      return st;
    } catch (error) {
      // 和共享记忆一样：文件坏了要吵出来，绝不静默当空库写回去 ——
      // 那等于把她攒着的「想跟主人说的事」一次性抹掉。
      console.error(`[share] 读取失败，本轮不投递也不写入：${error?.message ?? error}`);
      return null;
    }
  }

  function getShareState() {
    if (!shareStateCache) shareStateCache = loadShareStateOrNull();
    return shareStateCache;
  }

  function appendShareAudit(entry) {
    try {
      const line = JSON.stringify({
        at: new Date().toISOString(),
        action: String(entry?.action ?? ''),
        key: String(entry?.key ?? ''),
        detail: entry?.detail ?? null
      });
      fs.appendFileSync(SHARE_SIGNAL_AUDIT_FILE, `${line}\n`, { mode: 0o600 });
    } catch {
      // 审计失败不该让业务失败
    }
  }

  function persistShareState({ action, key, detail } = {}) {
    const st = getShareState();
    if (!st) return false;
    try {
      saveShareState(SHARE_SIGNAL_FILE, st);
      appendShareAudit({ action, key, detail });
      return true;
    } catch (error) {
      console.error(`[share] 写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 报告永远只投给主人私聊。 */
  function shareOwnerKey() {
    return `private:${cfg.ownerQQ}`;
  }

  /** buildWakePromptV2 拼文案时取「刚投递的那一条」。 */
  function shareLastDeliveryInfo() {
    const st = getShareState();
    if (!st) return null;
    const d = lastDelivery(st);
    if (!d || !d.summary) return null;
    return {
      summary: d.summary,
      sourceGroup: d.sourceGroup || '',
      valence: Number(d.valence) || 0,
      at: Number(d.at) || 0
    };
  }

  /**
   * 主人私聊来信 = 他回应了，也等于「他不理我」这个暂停理由不成立了。
   * 所以这条既是记回应，也是唯一的解除暂停途径。
   */
  function noteOwnerReplyToShare() {
    const st = getShareState();
    if (!st) return;
    const r = noteShareOwnerReply(st, { now: Date.now() });
    if (!r.answered && !r.resumed) {
      // 没回应过任何一条、也没在暂停里：只更新时间戳，别刷日志。
      saveShareState(SHARE_SIGNAL_FILE, st);
      return;
    }
    persistShareState({
      action: 'owner-reply',
      key: shareOwnerKey(),
      detail: { answered: r.answered, resumed: r.resumed }
    });
    if (r.resumed) log('[share] 主人说话了，报告暂停自动解除');
    if (r.answered) log(`[share] 主人回应了之前的报告，未回应计数清零`);
  }

  /**
   * 30 秒巡检时问一次：现在能不能把待报的事跟主人说。
   *
   * 挂在 sweepPendingWakeReasons 末尾，是因为计划要求不新增定时器；而
   * socialLoopTick 只在 currentMode === 'reserved' 下跑，本模式是 reserved2，
   * 那条路根本到不了这里。
   */
  function reportTickV2() {
    if (cfg.socialV2?.share?.enabled === false) return;
    const st = getShareState();
    if (!st) return;
    const now = Date.now();

    // 先把过窗口的投递结算掉：谁没回我、要不要降频、要不要暂停。
    const settled = settleDeliveries(st, { now });
    pruneState(st, { now });
    if (settled.newlyUnanswered || settled.paused) {
      persistShareState({
        action: 'settle',
        detail: {
          newlyUnanswered: settled.newlyUnanswered,
          streak: st.unansweredStreak,
          paused: settled.paused,
          silencedUntil: settled.silencedUntil || null
        }
      });
      if (settled.paused) {
        log(`[share] 连续 ${UNANSWERED_THRESHOLD} 次没回应、且这段时间主人一句没回，暂停到 ${new Date(settled.silencedUntil).toLocaleString()}`);
      } else {
        log(`[share] 上一次报告没被回应，未回应 ${st.unansweredStreak} 次，间隔调到 ${Math.round(effectiveIntervalMs(st) / 60000)} 分钟`);
      }
    }

    const verdict = canDeliver(st, { now });
    if (!verdict.ok) {
      // 没信号是常态，一个字都不打。其它原因 10 分钟最多一条日志，避免 30 秒一刷。
      if (verdict.reason !== 'no-signal' && verdict.reason !== 'disabled' && st.signals.length) {
        if (verdict.reason !== shareSkipLoggedReason || now - shareSkipLoggedAt > 600_000) {
          shareSkipLoggedReason = verdict.reason;
          shareSkipLoggedAt = now;
          const wait = verdict.waitMs ? `，还需等 ${Math.round(verdict.waitMs / 60000)} 分钟` : '';
          log(`[share] 节流拦截（${verdict.reason}）：待报 ${st.signals.length} 条${wait}`);
        }
      }
      return;
    }

    const ownerKey = shareOwnerKey();
    // 主人在跟她聊别的，这时候插一条群里的汇报就是在打断人。
    // 不消费信号、不加冷却，30 秒后再看一眼就够。
    const ownerSt = socialV2.conversations.get(ownerKey);
    if (isConversationBusyV2(ownerKey, ownerSt)) {
      if (now - shareSkipLoggedAt > 600_000) {
        shareSkipLoggedAt = now;
        shareSkipLoggedReason = 'owner-busy';
        log(`[share] 主人私聊正忙，这次报告先压着（待报 ${st.signals.length} 条）`);
      }
      return;
    }

    const sig = verdict.signal;

    // 观察模式：判定全跑，但**不记账、不发送** —— 每 6 小时才有一条，
    // 上线后要盯好几轮才能确认判定对不对。开着它先看日志：
    //   · 挑中的是不是真值得说的
    //   · valence 的语气提示合不合适
    //   · 安静时段/冷却有没有按预期拦
    // 确认没问题再把 socialV2.share.deliverEnabled 改成 true。
    if (cfg.socialV2?.share?.deliverEnabled !== true) {
      // 同一条信号只念一次，别每 30 秒刷一遍。
      if (shareObservedSignalId !== sig.id || now - shareSkipLoggedAt > 3_600_000) {
        shareObservedSignalId = sig.id;
        shareSkipLoggedAt = now;
        shareSkipLoggedReason = 'observe';
        log(`[share][观察] 本可以投递（${sig.sourceGroup}，valence ${sig.valence}）：${sig.summary}`);
      }
      return;
    }

    const marked = markDelivered(st, { signalId: sig.id, now });
    if (!marked.ok) return;
    persistShareState({
      action: 'deliver',
      key: ownerKey,
      detail: {
        eventId: sig.eventId,
        sourceGroup: sig.sourceGroup,
        valence: sig.valence,
        summary: sig.summary
      }
    });
    // 先记账再发：发失败也不重试，否则一次网络抖动会变成连发。
    log(`[share] 报告已投递（${sig.sourceGroup}，valence ${sig.valence}）：${sig.summary}`);
    void sendWakePromptV2(ownerKey, 'share').catch((error) => {
      log(`[share] 投递唤醒异常，不重试：${error?.message ?? error}`);
    });
  }

  /** addSignal 的失败原因翻成人话，让角色知道该怎么办。 */
  function shareRejectReason(reason) {
    switch (reason) {
      case 'event-id-required': return 'eventId 不能为空：同一条事件要能认出来，用来去重';
      case 'group-source-required': return '报告只能由群聊事件触发：sourceGroup 必须是 group:群号';
      case 'summary-required': return 'summary 不能为空：一句话说清发生了什么';
      case 'duplicate-event': return '这条事件已经报过了（或正在待报），同一条只说一次';
      default: return String(reason || '未知原因');
    }
  }

  // MARKER: image-approval-wire
  // ══════════════════════════════════════════════════════════════════════
  // MARKER: image-rate-limit
  // 同一会话 60 秒内只允许真正开画一次：一轮对话里连点三次 = 三张的钱 + 前两张白发。
  const IMAGE_THROTTLE_MS = 60_000;
  const imageLastStartAt = new Map();
  // 生图审批 + 主人私聊跨会话代发
  //
  // 两件事共用一层，因为数据流是同一条：
  //   好友私聊要图 → 产生一条申请 → 通知主人 → 主人确认 → 桥接直接出图发给好友。
  //   主人私聊代发让那条令牌能写到好友会话（否则连通知都发不出去）。
  // ══════════════════════════════════════════════════════════════════════

  /** 审批状态的内存缓存。改盘上的 json 不会立刻生效，要重启（踩过一次）。 */
  let imageApprovalCache = null;
  // MARKER: modules-ctx-inspect
  // 阶段20：巡检小族的句柄。getSocialV2State / readThroughSeqV2 声明在注入点之后 ⇒ 包箭头。
  Object.assign(moduleCtx, {
    readToolLog: (limit) => readToolLog(limit),
    readFeedbackEntries: () => readFeedbackEntries(),
    toolLogFile: TOOL_LOG_FILE,
    feedbackFile: FEEDBACK_FILE,
    getSocialV2State: (key) => getSocialV2State(key),
    readThroughSeqV2: (st) => readThroughSeqV2(st),
  });
  // MARKER: modules-ctx-memory
  // 阶段19：记忆读写模块要用的句柄。五个函数全部声明在注入点之后 ⇒ 只能包箭头，
  // 绝不能直接放进对象字面量的值位置（那会立即求值并撞上 TDZ）。
  Object.assign(moduleCtx, {
    redactKnownTokensOnly: (text) => redactKnownTokensOnly(text),
    getSocialV2State: (key) => getSocialV2State(key),
    appendMemoryV2: (st, category, content, extra) => appendMemoryV2(st, category, content, extra),
    formatMemoryV2: (st) => formatMemoryV2(st),
    saveSocialV2State: () => saveSocialV2State(),
  });
  // MARKER: modules-ctx-social
  // 阶段18：旧社交引擎（仿真群友模式）搬进 social 模块要用的句柄。
  // social 是 L9556 的 const 对象（Map 内容可变、引用不变）⇒ 直交；
  // enterActive/leaveActive/flushSummaries 都声明在注入点之后 ⇒ 只能包箭头。
  Object.assign(moduleCtx, {
    social: () => social,
    socialHelpers: {
      enterActive: (key) => enterActive(key),
      leaveActive: (key) => leaveActive(key),
      flushSummaries: (key) => flushSummaries(key),
    },
  });
  // MARKER: modules-ctx-whitelist
  // 阶段17：白名单模块要用的句柄。四个函数都在注入点之前声明（顶层三个 +
  // main 内的 reconcileSessionPolicies），直交引用安全；cfg 是对象，改它的属性
  // 立刻对所有持有者可见，不需要访问器。
  Object.assign(moduleCtx, {
    readConfigObject,
    atomicWriteJson,
    normalizeOwnerQQ,
    reconcileSessionPolicies: () => reconcileSessionPolicies(),
  });
  // MARKER: modules-ctx-image
  // 阶段16：生图/审批/画像搬进 image 模块后要用的句柄。
  // imageAllowedNow(L10013) / generateImageNow(L10055) 比这里晚得多，必须包闭包；
  // imageLastStartAt 是 Map（引用不变）但给访问器，免得以后改成重新赋值时踩空。
  Object.assign(moduleCtx, {
    imageHelpers: {
      // 注意：不能写成 (key, token) => agentTokenOkOrOwnerDelegate(key, token) ——
      // 那个 const 在 startConsoleServer() 里，main() 的箭头函数体看不到它，
      // 调用时会 ReferenceError: agentTokenOkOrOwnerDelegate is not defined（2026-10-24 实测生图全挂）。
      // moduleCtx 上的那个是 L5140 注入的、在正确作用域里，这里延迟到调用时再取。
      agentTokenOkOrOwnerDelegate: (key, token) => moduleCtx.agentTokenOkOrOwnerDelegate(key, token),
      imageAllowedNow: (key) => imageAllowedNow(key),
      imageApprovalEligible: (key) => imageApprovalEligible(key),
      requestImageApproval: (key, prompt, size) => requestImageApproval(key, prompt, size),
      imageReportOnly: () => imageReportOnly(),
      reportImageUsage: (info) => reportImageUsage(info),
      getImageApprovalState: () => getImageApprovalState(),
      imageApprovalStatsOf: (st) => imageApprovalStatsOf(st),
      approveImageApproval: (st, id) => approveImageApproval(st, id),
      rejectImageApproval: (st, id) => rejectImageApproval(st, id),
      persistImageApproval: (action, detail) => persistImageApproval(action, detail),
      commitApprovedImageApproval: (approval) => commitApprovedImageApproval(approval),
      generateImageNow: (opts) => generateImageWithRetry(opts),
      // MARKER: selfie-helpers
      generateImageWithRef: (opts) => generateImageWithRef(opts),
      // MARKER: image-see-helpers
      describeMediaByRef: (key, opts) => describeMediaByRef(key, opts),
      describeLocalImageFile: (p) => describeLocalImageFile(p),
      noteSelfImage: (key, desc, p) => noteSelfImage(key, desc, p),
      selfieCfg: () => selfieCfg(cfg),
      selfieRefPath: () => selfieRefPath(),
      selfieQuotaCheck: () => selfieQuota({ todayCount: selfieCountToday(), cfg: selfieCfg(cfg) }),
      buildSelfiePrompt: (opts) => buildSelfiePrompt({ ...(opts || {}), cfg: selfieCfg(cfg) }),
      recordGeneratedImage: (entry) => recordGeneratedImage(entry),
      recentGeneratedImages: (limit) => recentGeneratedImages(limit),
      onebotSend: (kind, id, message, replyToMessageId, atUserId, images) =>
        onebotSend(kind, id, message, replyToMessageId, atUserId, images),
      throttleMs: () => IMAGE_THROTTLE_MS,
      lastStartAt: (key) => imageLastStartAt.get(key),
      markStart: (key) => imageLastStartAt.set(key, Date.now()),
      maxPromptChars: () => IMAGE_APPROVAL_MAX_PROMPT,
      ttlMs: () => IMAGE_APPROVAL_TTL_MS,
    },
  });

  // MARKER: modules-core-ctx
  // v2:core 一族需要的句柄。全部是箭头函数：socialV2（L~8419）、getSocialV2State（L~8834）
  // 这些名字都在注入点之后才声明，在对象字面量值位置直接引用会撞 TDZ。
  Object.assign(moduleCtx, {
    coreHelpers: {
      // —— 会话状态 ——
      socialV2: () => socialV2,
      socialV2File: SOCIAL_V2_FILE,
      configFile: path.join(ROOT, 'config.json'),
      getSocialV2State: (key) => getSocialV2State(key),
      saveSocialV2State: () => saveSocialV2State(),
      state: () => state,
      saveState: () => saveState(),
      readConfigObject: (file) => readConfigObject(file),
      atomicWriteJson: (file, obj) => atomicWriteJson(file, obj),
      // —— 唤醒/安全 ——
      wakeSafety: (wc) => computeWakeSafetyV2(wc),
      currentMode: () => currentMode,
      modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),
      setupSleepTimer: (key) => setupSleepTimerV2(key),
      scheduleProactiveCheck: (key) => scheduleProactiveCheckV2(key),
      clearAllSocialV2Timers: () => clearAllSocialV2Timers(),
      drainAllPromptQueues: (msg) => drainAllPromptQueues(msg),
      refreshAllDefaultWakeConfigs: () => refreshAllDefaultWakeConfigsV2(),
      sendWakePrompt: (key, reason) => sendWakePromptV2(key, reason),
      cancelReplyCheck: (key) => cancelReplyCheckV2(key),
      clearAllPendingWakeLeases: () => clearAllPendingWakeLeases(),
      isSleepingConfig: (wc) => isSleepingConfigV2(wc),
      preSleepWaitBlocked: (st) => preSleepWaitBlockedV2(st),
      ensureWakeable: (st, opts) => ensureWakeableV2(st, opts),
      clampWakeProbability: (key, next) => clampWakeProbabilityV2(key, next),
      normalizeSpeakerIds: (ids) => normalizeSpeakerIdsV2(ids),
      // —— 未读游标 ——
      readThroughSeq: (st) => readThroughSeqV2(st),
      noteModelMessages: (st, msgs) => noteModelMessagesV2(st, msgs),
      requestedReadThroughSeq: (st, body, isAgent) => requestedReadThroughSeqV2(st, body, isAgent),
      acknowledgeMessages: (st, seq) => acknowledgeMessagesV2(st, seq),
      resolveReplyInfo: (kind, id, messageId) => resolveReplyInfo(kind, id, messageId),
      // —— prompt 内容 ——
      readRoleState: () => readRoleState(),
      currentRoleHint: () => currentRoleHint(),
      currentRoleHintV2: () => currentRoleHintV2(),
      // toolMap 原本是 get_prompt 里的字面量，不是 main() 的变量 —— 已整体搬进 core/self.js
      stickerEnabled: () => stickerEnabled(),
      replyTiming: (st) => replyTimingV2(st),
      formatMemory: (st) => formatMemoryV2(st),
      formatParticipation: (st) => formatParticipationV2(st),
      scheduleStore: () => scheduleStore(),
      portraitStore: () => portraitStore(),
      formatSchedule: (store, opts) => formatScheduleForPrompt(store, opts),
      formatPortrait: (store) => formatPortraitForPrompt(store),
      syncStickerLibrary: (force) => syncStickerLibrary(force),
      stickerEntries: () => stickerEntries,
      buildStickerContext: (entries, max, options) => buildStickerContext(entries, max, options),
      buildStickerStrategyHint: () => buildStickerStrategyHint(),
      confirmedSlangList: () => confirmedSlangListV2(),
      slangEntries: () => slangEntries,
      buildSlangContext: (entries, max, key) => buildSlangContext(entries, max, key),
      voiceLibrary: () => voiceLibrary(),
      voiceCfg: () => voiceCfg(),
      // —— 映射表（reset 时逐个清） ——
      bumpEpoch: () => { sessionEpoch += 1; },
      sessionPromises: () => sessionPromises,
      sessionModels: () => sessionModels,
      modelAppliedSessions: () => modelAppliedSessions,
      reverse: () => reverse,
      collectors: () => collectors,
      v2TurnStartAt: () => v2TurnStartAt,
      toolCallNames: () => toolCallNames,
      pendingSendToolCalls: () => pendingSendToolCalls,
      sendToolSucceededSessions: () => sendToolSucceededSessions,
      seenForwardIds: () => seenForwardIds,
      pendingWakeKeys: () => pendingWakeKeys,
      wakeConfigUpdatedKeys: () => wakeConfigUpdatedKeys,
      markReadCalledKeys: () => markReadCalledKeys,
      wakeConfigMissCount: () => wakeConfigMissCount,
      forgetAgentToken: (key) => forgetAgentToken(key),
      stopRetiredSessionWork: (sid, key) => stopRetiredSessionWork(sid, key),
    },
  });
  // MARKER: modules-ctx-reset
  // 阶段21：清除上下文 / 清空工作区。声明在注入点之前的直接交引用；
  // 声明在其之后的（sessionEpoch / pending / 各种 Map / 函数）一律包箭头或访问器，
  // 绝不能把晚期名字放进对象字面量的值位置 —— 那会立即求值并撞 TDZ。
  Object.assign(moduleCtx, {
    unwrap,
    ACTIVITY_LOG,
    CONVERSATION_TOKENS,
    KNOWN_AGENT_TOKENS,
    forgetAgentToken,
    saveState,
    slangWindows,
    slangExtractionCooldowns,
    slangSubmitTimes,
    pendingWakeKeys,
    wakeConfigUpdatedKeys,
    markReadCalledKeys,
    wakeConfigMissCount,
    collectors,
    sendToolSucceededSessions,
    v2TurnStartAt,
    toolCallNames,
    pendingSendToolCalls,
    reverse,
    sessionPromises,
    queued,
    queuedHintAt,
    resetHelpers: {
      getState: () => state,
      bumpEpoch: () => { sessionEpoch += 1; },
      pending: () => pending,
      modelAppliedSessions: () => modelAppliedSessions,
      social: () => social,
      socialV2: () => socialV2,
      messageMediaStore: () => messageMediaStore,
      seenForwardIds: () => seenForwardIds,
      saveSocialV2State: () => saveSocialV2State(),
      cancelSocialTimers: (key) => cancelSocialTimers(key),
      cancelAllSocialTimers: () => cancelAllSocialTimers(),
      clearSocialV2Timers: (key) => clearSocialV2Timers(key),
      clearAllSocialV2Timers: () => clearAllSocialV2Timers(),
      drainPromptQueue: (key, msg) => drainPromptQueue(key, msg),
      drainAllPromptQueues: (msg) => drainAllPromptQueues(msg),
      cancelPendingEntry: (entry) => cancelPendingEntry(entry),
    },
  });
  // MARKER: modules-ctx-console
  // 阶段22：console 族句柄。
  Object.assign(moduleCtx, {
    crypto, readConfigObject, atomicWriteJson, atomicWriteText, readRoleState,
    getSocialV2State: (key) => getSocialV2State(key),
    deliverPrompt: (key, text, opts) => deliverPrompt(key, text, opts),
    appendActivity: (line) => appendActivity(line),
    ensureSession: (key) => ensureSession(key),
    modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),
    allowed: (kind, id, c) => allowed(kind, id, c),
    helpers: {
      state: () => state,
      social: () => social,
    },
    dshReady: () => dshReady,
    currentMode: () => currentMode,
  });
  // MARKER: modules-ctx-message-image
  // 阶段22：消息图片族句柄。前四个在 startConsoleServer() 里，后两个声明于 main() 中段 —— 全部包箭头。
  Object.assign(moduleCtx, {
    currentMode: () => currentMode,
    agentTokenOk: (key, token) => agentTokenOk(key, token),
    v2ToolEnabled: (flag) => v2ToolEnabled(flag),
    modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),
    findMessageMedia: (key, messageId) => findMessageMedia(key, messageId),
    fetchMediaData: (media) => fetchMediaData(media),
  });
  // MARKER: modules-ctx-mode
  // 阶段23：运行模式切换句柄。currentMode / lastMode / closedAgentPreset 是可变的 let，
  // 必须用读写句柄，不能交快照值；socialV2 声明在 main() 中段，包箭头。
  Object.assign(moduleCtx, {
    normalizeModeInput, VALID_MODES, readJsonSafe, atomicWriteJson,
    cleanupSocialForModeChange: () => cleanupSocialForModeChange(),
    clearAllSocialV2Timers: () => clearAllSocialV2Timers(),
    drainAllPromptQueues: (msg) => drainAllPromptQueues(msg),
    reconcileSessionPolicies: () => reconcileSessionPolicies(),
    setupSleepTimerV2: (key) => setupSleepTimerV2(key),
    scheduleProactiveCheckV2: (key) => scheduleProactiveCheckV2(key),
    socialV2: () => socialV2,
    setClosedAgentPreset: (value) => { closedAgentPreset = value; },
    setMode: (value) => { currentMode = value; lastMode = value; },
  });
  // MARKER: modules-ctx-send-legacy
  // 阶段23：老版发送通道句柄。socialV2 / getSocialV2State / sendMessagesV2 / resolveReplyTargetV2 等
  // 全部声明在 main() 中段（晚于注入点），一律包箭头；agentTokenOk 在 startConsoleServer() 里。
  Object.assign(moduleCtx, {
    SENSITIVE_RE, unquoteJsonString, appendActivity, resolveSendLimitsV2,
    v2ToolEnabled: (flag) => v2ToolEnabled(flag),
    modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),
    shouldBlockSilentReply: (key) => shouldBlockSilentReply(key),
    socialV2: () => socialV2,
    getSocialV2State: (key) => getSocialV2State(key),
    resolveReplyTargetV2: (st, kind, id, ref) => resolveReplyTargetV2(st, kind, id, ref),
    sendMessagesV2: (key, msgs, imgs, reply, at) => sendMessagesV2(key, msgs, imgs, reply, at),
    recordSentMessagesV2: (key, msgs) => recordSentMessagesV2(key, msgs),
    saveSocialV2State: () => saveSocialV2State(),
    scheduleReplyCheckV2: (key) => scheduleReplyCheckV2(key),
  });

  // MARKER: modules-ctx-share
  // 阶段24：主动报告与跨会话记忆。
  // 纯逻辑是叶子模块 import，交引用安全；main() 内函数声明在本块之后，必须包箭头。
  Object.assign(moduleCtx, {
    shareStatsOf, normalizeSharePolicy, setSharePolicy, addSignal, shareRejectReason, isGroupKey,
    SHARE_HARD_MIN_INTERVAL_MS, SHARE_HARD_MAX_PER_DAY, SHARE_MAX_SIGNALS,
    listItems, listGroupScopeForOwner, findSimilar, addItem, pruneStore, canRead, forgetItem,
    sharedMemoryStats, SHARED_MEMORY_MAX_ITEMS, SHARED_MEMORY_MAX_ARCHIVED,
    shareHelpers: {
      getShareState: () => getShareState(),
      persistShareState: (args) => persistShareState(args),
      getSharedMemoryState: () => getSharedMemoryState(),
      persistSharedMemoryState: (store, args) => persistSharedMemoryState(store, args),
      sharedMemoryReaderFor: (key) => sharedMemoryReaderFor(key),
    },
  });
  // 好友昵称表（号码 -> 昵称），由 refreshFriends 填。不落盘。
  const friendNames = new Map();
  const IMAGE_APPROVAL_AUDIT_FILE = path.join(STATE_DIR, 'image-approval-audit.jsonl');

  function loadImageApprovalOrNull() {
    try {
      return loadImageApprovalState(IMAGE_APPROVAL_FILE);
    } catch (error) {
      // 读不动就吵出来：静默当空库会把主人的审批历史覆盖掉。
      log(`[imgapprove] 读审批状态失败：${error?.message ?? error}`);
      return null;
    }
  }

  function getImageApprovalState() {
    if (!imageApprovalCache) {
      imageApprovalCache = loadImageApprovalOrNull() || createDefaultImageApprovalState();
    }
    return imageApprovalCache;
  }

  function appendImageApprovalAudit(entry) {
    try {
      fs.appendFileSync(IMAGE_APPROVAL_AUDIT_FILE, JSON.stringify({ at: Date.now(), ...entry }) + '\n', { mode: 0o600 });
    } catch (error) {
      log(`[imgapprove] 写审计失败：${error?.message ?? error}`);
    }
  }

  function persistImageApproval(action, detail = '') {
    if (!imageApprovalCache) return;
    try {
      saveImageApprovalState(IMAGE_APPROVAL_FILE, imageApprovalCache);
    } catch (error) {
      log(`[imgapprove] 落盘失败：${error?.message ?? error}`);
    }
    appendImageApprovalAudit({ action, detail });
  }

  /** 主人私聊的 key（审批通知都往这里发）。 */
  function imageApprovalOwnerKey() {
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    return ownerQQ ? `private:${ownerQQ}` : null;
  }

  /**
   * 这个会话能不能走审批要图？
   *
   * 硬条件：是 private:<id>、不是主人、不是她自己、是好友、且过当前模式准入。
   * 少一条都不行 —— 判宽了等于给所有人开了花钱的口子。
   */
  function imageApprovalEligible(key) {
    const m = /^private:(\d+)$/.exec(String(key ?? '').trim());
    if (!m) return false;
    const id = String(Number(m[1]));
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ || id === ownerQQ) return false;
    if (selfUserId && id === String(selfUserId)) return false;
    if (!friendSetReady || !friendSet.has(id)) return false;
    if (!allowed('private', Number(id), cfg)) return false;
    return true;
  }

  /**
   * 生图「只报备、不审批」开关。
   *
   * 主人 2026-10-25 的指令（原话）：「开启画图模式，无需审批，只需要报备管理员」。
   * 打开后好友私聊要图不再排队等主人点头，直接画，画完把「谁要的、要了什么、
   * 花了多久、成没成、发到哪」报给主人一条消息。
   * 想改回人工审批：config.json 里 socialV2.image.reportOnly 设 false。
   *
   * 边界：只放开「好友私聊」这一档。群里非主人要图仍然拒绝 —— 群成员不可控，
   * 「谁都能喊一声就让她花钱画图」的口子不能开（理由同 imageApprovalEligible）。
   */
  function imageReportOnly() {
    return cfg.socialV2?.image?.reportOnly !== false;
  }

  /** 报备一条免审批生图。失败只记日志，绝不影响出图结果本身。 */
  async function reportImageUsage(info) {
    const ownerKey = imageApprovalOwnerKey();
    const prompt = String(info?.prompt ?? '');
    const key = String(info?.key ?? '');
    const m = /^private:(\d+)$/.exec(key);
    const who = m ? `${imageApprovalRequesterName(m[1])}（${m[1]}）` : key;
    const elapsed = Number(info?.elapsedMs ?? 0);
    const lines = [
      `🖼 免审批生图报备`,
      `谁：${who}`,
      `要的：${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}`,
      info?.size ? `尺寸：${info.size}` : '',
      `结果：${info?.ok ? '✅ 已画好' : '❌ 失败'}${info?.ok && info?.sent === false ? '（但没发出去，看日志）' : ''}`,
      elapsed ? `耗时：${(elapsed / 1000).toFixed(1)}s` : '',
      info?.error ? `错误：${String(info.error).slice(0, 300)}` : '',
      '',
      `（画图已设为免审批，只向你报备；想改回来：socialV2.image.reportOnly=false）`
    ].filter((x) => x !== '');
    log(`[imgapprove] 报备 ${who} ${info?.ok ? '成功' : '失败'}：${prompt.slice(0, 40)}`);
    try {
      appendImageApprovalAudit({ action: 'report-only', detail: `${key} ${info?.ok ? 'ok' : 'fail'}` });
    } catch {}
    if (ownerKey) {
      await sendPlainToQQ(ownerKey, lines.join('\n')).catch(() => {});
    }
  }

  /**
   * 好友昵称表（号码 -> 昵称）。
   *
   * 为什么要这张表：私聊会话的 recentMessages 里 sender 恒为
   * 「我」或「私聊」（对方的真实昵称从不写进去），所以从会话里抖不出名字。
   * 而 refreshFriends 拿到的 get_friend_list 本来就带 nickname，只是过去只取了
   * user_id 就把昵称丢了。这张表由 refreshFriends 顺手填。
   */
  function rememberFriendNames(list) {
    if (!Array.isArray(list)) return;
    for (const f of list) {
      const id = String(f?.user_id ?? '').trim();
      if (!id) continue;
      const name = String(f?.nickname ?? f?.remark ?? '').trim();
      if (!name) continue;
      friendNames.set(id, name.slice(0, 32));
    }
  }

  /** 申请人的显示名（通知主人时用；拿不到就退回号码）。 */
  function imageApprovalRequesterName(id) {
    const sid = String(id ?? '').trim();
    // 好友表里的昵称最准。
    const known = friendNames.get(sid);
    if (known) return known;
    try {
      const st = socialV2.conversations.get(`private:${sid}`);
      const rec = Array.isArray(st?.recentMessages) ? st.recentMessages.slice(-30).reverse() : [];
      for (const item of rec) {
        const name = String(item?.sender ?? '').trim();
        // 「我」「私聊」「对方」都是占位符，不是名字。
        if (name && name !== '我' && name !== '私聊' && name !== '对方' && name !== sid) return name;
      }
    } catch { /* 拿不到就算了，用号码 */ }
    return sid;
  }

  /** 直接往 QQ 发一条文本（不触发模型回合，省钱）。 */
  /**
   * 技术性投递错误只发给管理员私聊，当前会话一个字都不发。
   *
   * 为什么：`session/attachment-invalid: Model "x" does not support image input`
   * 这类信息对群友毫无意义，还会把渠道名、模型名、内部错误码抖到群里；
   * 好友私聊里读到一串英文报错一样只会让人困惑。诊断信息归管理员。
   *
   * 为什么单独成函数：两处投递失败（普通回合 / 群聊兜底路径）都要用，
   * 复制一遍既容易走样，也容易在其中一处忘了给 sourceKey。
   * 绝不抛错 —— 通知失败只能记日志，不能污染调用方的主流程。
   */
  // MARKER: notify-admin-throttle —— 2026-10-27
  // 实测事故：group:906710082 的会话损坏，同一错误每 3 秒触发一次，
  // 一小时往管理员私聊推了几十条一模一样的「消息未被接受」，把主人的私聊刷成了日志。
  // 技术报错本来就只该给管理员看，但「只看一次」和「看八十六次」是两回事。
  // 同一来源 + 同一标题在窗口内只发第一条；之后再出现只累计，等下一条发出时带上次数。
  const NOTIFY_ADMIN_MIN_GAP_MS = 5 * 60 * 1000;
  const notifyAdminSeen = new Map(); // `${sourceKey}|${headline}` -> { lastSentAt, suppressed }

  async function notifyAdminOnly(headline, detail, sourceKey) {
    const src = String(sourceKey ?? '').trim();
    const ownerKey = cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
    const where = src && src !== ownerKey ? `（${src}）` : '';
    log(`${headline}${where}：${detail}`);
    if (!ownerKey) {
      log(`⚠️ ${headline}：未配置 ownerQQ，诊断信息只留在日志里`);
      return;
    }
    const throttleKey = `${src ?? ''}|${headline}`;
    const seen = notifyAdminSeen.get(throttleKey);
    const now = Date.now();
    if (seen && now - seen.lastSentAt < NOTIFY_ADMIN_MIN_GAP_MS) {
      seen.suppressed += 1;
      return;
    }
    const extra = seen && seen.suppressed > 0
      ? `（此前同类报错已重复 ${seen.suppressed} 次，已省略；${Math.round(NOTIFY_ADMIN_MIN_GAP_MS / 60000)} 分钟内不再重复发）`
      : '';
    notifyAdminSeen.set(throttleKey, { lastSentAt: now, suppressed: 0 });
    try {
      await sendToQQ(ownerKey, `${headline}${where}：${detail}${extra}`);
    } catch (error) {
      log(`${headline} 通知管理员失败（已忽略）：${error?.message ?? error}`);
    }
  }

  async function sendPlainToQQ(key, text) {
    const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
    if (!m) throw new Error(`sendPlainToQQ: key 格式不对：${key}`);
    const id = Number(m[2]);
    if (!Number.isFinite(id) || id <= 0) throw new Error(`sendPlainToQQ: id 不合法：${key}`);
    await onebotSend(m[1], id, String(text));
  }

  /** 通知主人：有人要图，等你点头。 */
  async function notifyOwnerImageRequest(approval) {
    const ownerKey = imageApprovalOwnerKey();
    if (!ownerKey) {
      log('[imgapprove] 没配 ownerQQ，没法通知主人');
      return false;
    }
    const who = approval.requesterName || approval.key.replace(/^private:/, '');
    const minutes = Math.round(IMAGE_APPROVAL_TTL_MS / 60000);
    const text = [
      `【有人想要图】${who}（${approval.key.replace(/^private:/, '')}）`,
      `要画：${approval.prompt}`,
      approval.size ? `尺寸：${approval.size}` : '',
      `回「通过」就开始画，回「拒绝」就不画。${minutes} 分钟内有效，编号 ${approval.id}。`
    ].filter(Boolean).join('\n');
    try {
      await sendPlainToQQ(ownerKey, text);
      appendImageApprovalAudit({ action: 'notify', detail: `${approval.id} → 主人` });
      return true;
    } catch (error) {
      log(`[imgapprove] 通知主人失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 好友私聊要图 → 登记一条申请（不发图）。
   *
   * 同一句 prompt 重复要（催）只续期、不再通知主人 —— 否则好友连敲三次
   * 就是三条申请，主人被刷屏。
   */
  function requestImageApproval(key, prompt, size) {
    const st = getImageApprovalState();
    const idMatch = /^private:(\d+)$/.exec(String(key ?? '').trim());
    if (!idMatch) return { ok: false, error: '只有好友私聊能申请生图' };
    const id = String(Number(idMatch[1]));
    const created = createImageApproval(st, {
      key,
      requesterName: imageApprovalRequesterName(id),
      prompt,
      size
    });
    if (!created.approval) {
      const msg = created.reason === 'too-many-pending'
        ? '待审批的图太多了，等主人处理完再说'
        : created.reason === 'no-prompt'
          ? 'prompt 不能为空'
          : '申请格式不对';
      return { ok: false, error: msg };
    }
    persistImageApproval(created.reused ? 'request-again' : 'request', `${created.approval.id} ${key}`);
    log(`[imgapprove] ${created.reused ? '重复申请（已续期）' : '收到生图申请'}（${key}）：${String(prompt).slice(0, 50)}`);
    if (!created.reused) {
      // 通知失败不回滚申请：主人下次问起还能看到这条。
      void notifyOwnerImageRequest(created.approval).catch(() => {});
    }
    return {
      ok: true,
      approval: created.approval,
      reused: created.reused,
      note: created.reused
        ? `已经在等主人确认了（编号 ${created.approval.id}），不会再催一次。`
        : `已经把请求转给主人了（编号 ${created.approval.id}），等主人点头才画。`
    };
  }

  /** 审批通过 → 真出图 → 直接发给申请的好友。 */
  async function commitApprovedImageApproval(approval) {
    const ownerKey = imageApprovalOwnerKey();
    try {
      log(`[imgapprove] 主人已通过 ${approval.id}，开始出图（${approval.key}）：${String(approval.prompt).slice(0, 50)}`);
      const result = await generateImageWithRetry({ prompt: approval.prompt, size: approval.size || undefined });
      let sent = false;
      try {
        if (result?.path) {
          const [sendKind, sendId] = String(approval.key).split(':');
          if ((sendKind === 'group' || sendKind === 'private') && Number(sendId) > 0) {
            await onebotSend(sendKind, Number(sendId), '', null, null, [result.path]);
            sent = true;
          }
        }
      } catch (error) {
        log(`[imgapprove] 出图后发送失败（${approval.key}）：${error?.message ?? error}`);
      }
      appendImageApprovalAudit({ action: 'generated', detail: `${approval.id} sent=${sent}` });
      if (ownerKey) {
        await sendPlainToQQ(ownerKey, sent
          ? `✅ ${approval.requesterName || approval.key} 的图已经画好发出去了（${approval.id}）。`
          : `⚠️ ${approval.id} 画好了但没能发出去，你看下日志。`).catch(() => {});
      }
      return { ok: true, sent };
    } catch (error) {
      log(`[imgapprove] 出图失败（${approval.id}）：${error?.message ?? error}`);
      appendImageApprovalAudit({ action: 'generate-failed', detail: `${approval.id} ${error?.message ?? error}` });
      if (ownerKey) {
        await sendPlainToQQ(ownerKey, `❌ ${approval.id} 出图失败：${error?.message ?? error}`).catch(() => {});
      }
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * 主人在私聊里回「通过 / 拒绝」时消费一条审批。
   *
   * 返回 true 表示这句话被审批吃掉了（不再往下走模型）。
   * 没有待审申请时返回 false —— 主人平时说「通过」不该被拦。
   */
  function tryConsumeImageApprovalReply(key, text) {
    if (!/^private:(\d+)$/.test(String(key ?? ''))) return false;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ || String(key) !== `private:${ownerQQ}`) return false;
    const raw = String(text ?? '').trim();
    if (!raw) return false;

    const st = getImageApprovalState();
    expireStaleImageApprovals(st);
    if (pendingImageApprovalCount(st) === 0) return false;

    // 支持「通过 ia3f2」指定编号；不指定就取最新那条。
    const idHit = /\b(ia[0-9a-z]+)\b/i.exec(raw);
    const explicitId = idHit ? idHit[1] : '';
    const bare = raw.replace(/\bia[0-9a-z]+\b/gi, '').replace(/[#＃]/g, '').replace(/[。，！!.、\s@]/g, '').toLowerCase();
    if (!bare) return false;

    let want = '';
    if (APPROVE_WORDS.has(bare)) want = 'approve';
    else if (REJECT_WORDS.has(bare)) want = 'reject';
    if (!want) return false;

    const target = pickImageApprovalToDecide(st, { id: explicitId });
    if (!target) {
      void sendPlainToQQ(key, '没找到待审批的生图申请（可能已经过期或处理过了）。').catch(() => {});
      return true;
    }

    if (want === 'approve') {
      const res = approveImageApproval(st, target.id);
      if (!res.ok) {
        void sendPlainToQQ(key, `这条申请已经不能通过了（${res.reason === 'expired' ? '已过期' : res.reason}）。`).catch(() => {});
        return true;
      }
      persistImageApproval('approved', `${target.id} ${target.key}`);
      log(`[imgapprove] 主人通过 ${target.id}（${target.key}）`);
      // 出图要几十秒到几分钟，不能卡住消息处理。
      void commitApprovedImageApproval(res.approval).catch(() => {});
      void sendPlainToQQ(key, `好，开始画（${target.id}），画好会直接发给${target.requesterName || '对方'}。`).catch(() => {});
      return true;
    }

    const rej = rejectImageApproval(st, target.id);
    if (!rej.ok) {
      void sendPlainToQQ(key, `这条申请已经不能拒绝了（${rej.reason}）。`).catch(() => {});
      return true;
    }
    persistImageApproval('rejected', `${target.id} ${target.key}`);
    log(`[imgapprove] 主人拒绝 ${target.id}（${target.key}）`);
    void sendPlainToQQ(key, `好，不画了（${target.id}）。`).catch(() => {});
    return true;
  }

  /**
   * 「主人私聊的令牌可以代发到好友私聊」的判定。
   *
   * 这里是**外层**，看不见 startConsoleServer 里的 tokenEq，所以令牌比较
   * 就地用 crypto.timingSafeEqual（同一个理由：定长比较，不给时延试探）。
   *
   * 边界（缺一不可）：
   *   - 令牌必须属于 `private:<ownerQQ>` 这个会话，别的一律不认；
   *   - 目标必须也是私聊，群里不许跨会话发（群里冒名代价太大）；
   *   - 目标必须是好友、且过当前模式准入；
   *   - 目标不能是主人自己，也不能是她自己。
   */
  function ownerDelegateTokenOk(key, token) {
    if (typeof token !== 'string' || !token) return false;
    const target = canonicalV2Key(key);
    if (!target) return false;
    const ownerQQ = String(cfg.ownerQQ ?? '').trim();
    if (!ownerQQ) return false;
    const m = /^private:(\d+)$/.exec(target);
    if (!m) return false;
    const id = String(Number(m[1]));
    if (id === ownerQQ) return false;
    if (selfUserId && id === String(selfUserId)) return false;
    if (!friendSetReady || !friendSet.has(id)) return false;
    if (!allowed('private', Number(id), cfg)) return false;
    const ownerSt = socialV2.conversations.get(`private:${ownerQQ}`);
    const stored = ownerSt?.agentToken;
    if (typeof stored !== 'string' || !stored) return false;
    const x = Buffer.from(stored, 'utf8');
    const y = Buffer.from(token, 'utf8');
    if (x.length !== y.length || !crypto.timingSafeEqual(x, y)) return false;
    log(`[delegate] 主人私聊代发 → ${target}`);
    return true;
  }

  // MARKER: affinity-wire
  // ── 好感度的接线层 ────────────────────────────────────────────────────
  //
  // 三件事：读当前会话的好感度、拼进唤醒 prompt、长期没动过时提一句。
  // 全部只读 + 一次可能的落盘，不新增定时器。

  let affinityCache = null;

  function getAffinityState() {
    if (affinityCache) return affinityCache;
    try {
      affinityCache = loadAffinityState(AFFINITY_FILE);
    } catch (error) {
      // MARKER: affinity-migrate-corrupt
      // 文件损坏不能静默重置 —— 那会把所有人的好感度一次抹了。
      // 但也不能只给空表：空表被下一次写入落盘，就等于**用空表覆盖了坏文件**，
      // 数据彻底没了。所以标一个脏标记，写入前检查，坏了就拒绝写。
      log(`[affinity] 状态读取失败（本次不注入，且拒绝写入以免覆盖）：${error?.message ?? error}`);
      affinityCache = { version: 1, affinities: {}, nudgeAt: {} };
      affinityCache.__corrupt = String(error?.message ?? error);
    }
    return affinityCache;
  }

  function saveAffinitySafe(reason) {
    // MARKER: affinity-migrate-save
    // 这里**故意不吞异常**（原来吞了）。
    // 吞掉的后果是：她以为写了、其实没落盘，下次醒来还念着旧评价，
    // 而且日志里只有一行 warn，人不会去看。
    // 唯一例外是提醒（nudge）那一路 —— 那只是顺口一提，失败不该让整轮唤醒变红，
    // 由调用方自己 try 包住。
    try {
      saveAffinityState(AFFINITY_FILE, getAffinityState());
    } catch (error) {
      log(`[affinity] 落盘失败（${reason}）：${error?.message ?? error}`);
      throw error;
    }
  }

  /** 当前会话对她眼里「这个人」的评价（没有就是 null）。 */
  function affinityEntryFor(key) {
    try {
      return getAffinity(getAffinityState().affinities, key);
    } catch {
      return null;
    }
  }

  /**
   * 写入某个会话的好感度，并记一次「已提醒」时间清零用不上。
   * 供 qq_mood action=affinity 调用（旧的全局写入仍然保留，见调用点）。
   */
  function recordAffinityForKey(key, { level, note }) {
    const st = getAffinityState();
    // MARKER: affinity-migrate-guard
    // 文件坏了就拒绝写 —— 宁可这一次改不成，也不能用空表覆盖掉她的全部好感度。
    if (st.__corrupt) {
      throw new Error('好感度文件损坏（' + st.__corrupt + '），为免覆盖已拒绝写入，请先修 state/affinity.json');
    }
    const { map } = setAffinityByKey(st.affinities, { key, level, note, now: Date.now() });
    st.affinities = map;
    // 她自己改过，就没必要再提醒「该看看了」
    if (st.nudgeAt) delete st.nudgeAt[normalizeAffinityKey(key) ?? key];
    saveAffinitySafe('write');
    return map[normalizeAffinityKey(key) ?? key];
  }

  /** 唤醒 prompt 里的好感度行 +（间隔足够时）一句提醒。 */
  function buildAffinityLineFor(key) {
    if (cfg.socialV2?.affinity?.enabled === false) return '';
    const entry = affinityEntryFor(key);
    if (!entry) return '';
    let out = formatAffinityLine({ entry, key, ownerQQ: cfg.ownerQQ });
    try {
      const st = getAffinityState();
      if (shouldNudgeAffinity({ entry, lastNudgedAt: st.nudgeAt?.[key], now: Date.now() })) {
        out += formatAffinityNudge({ entry, key, ownerQQ: cfg.ownerQQ });
        if (!st.nudgeAt || typeof st.nudgeAt !== 'object') st.nudgeAt = {};
        st.nudgeAt[key] = Date.now();
        saveAffinitySafe('nudge');
        log(`[affinity] 提醒她重新看看 ${key} 的好感度`);
      }
    } catch (error) {
      log(`[affinity] 提醒判定跳过 ${key}：${error?.message ?? error}`);
    }
    return out;
  }

  // MARKER: group-digest-wire
  // ── 群聊近况 + 睡眠整合的接线层 ────────────────────────────────────────
  //
  // 两件事都只在**唤醒 prompt 拼装时**发生，不新增定时器、不主动投递：
  //   · D：主人私聊里问起某个群 → 只注入那一个群的最近几条。
  //   · 睡眠整合：4 点后她第一次自然醒来 → 注入「今天发生过什么」+ 提醒补日记。

  let sleepReviewCache = null;

  function getSleepReviewState() {
    if (sleepReviewCache) return sleepReviewCache;
    try {
      const raw = readJsonSafe(SLEEP_REVIEW_FILE, null, false);
      sleepReviewCache = raw && typeof raw === 'object' ? raw : { reviewDays: {} };
      if (!sleepReviewCache.reviewDays || typeof sleepReviewCache.reviewDays !== 'object') sleepReviewCache.reviewDays = {};
    } catch (error) {
      // 读不出来就当没做过 —— 最坏结果是多念一次，不会丢数据。
      log(`[sleep-review] 状态读取失败：${error?.message ?? error}`);
      sleepReviewCache = { reviewDays: {} };
    }
    return sleepReviewCache;
  }

  function saveSleepReviewState() {
    try {
      atomicWriteJson(SLEEP_REVIEW_FILE, getSleepReviewState());
    } catch (error) {
      log(`[sleep-review] 状态落盘失败：${error?.message ?? error}`);
    }
  }

  /**
   * 取这个会话里**主人**最后说的一句话。
   *
   * ⚠️ 必须是 `isOwner && !isSelf`：recordSentMessagesV2 写她自己发的消息时
   * isOwner 也是 true，只查 isOwner 会把她的发言当成主人在问。
   */
  function lastOwnerUtterance(st) {
    const msgs = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      const m = msgs[i];
      if (m && m.isOwner && !m.isSelf) {
        const text = String(m.plain ?? m.text ?? '').trim();
        if (text) return text;
      }
    }
    return '';
  }

  /**
   * D：主人问起群时，返回那个群的近况文本；否则空串。
   *
   * 只在主人私聊里生效 —— 群里她自己就在现场，不需要再从记忆里翻。
   */
  function buildGroupDigestLineFor(key) {
    if (!key || key !== `private:${cfg.ownerQQ}`) return '';
    try {
      const st = getSocialV2State(key);
      const said = lastOwnerUtterance(st);
      if (!said || !asksAboutGroups(said)) return '';
      const candidates = listGroupCandidates(socialV2.conversations);
      if (!candidates.length) return '';
      const target = pickGroupFor(said, candidates);
      if (!target) return '';
      const conv = socialV2.conversations.get(target);
      const messages = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
      const digest = formatGroupDigest({ key: target, messages, now: Date.now() });
      if (!digest) return '';
      log(`[group-digest] 主人问起群，注入 ${target} 的近况（${messages.length} 条里取最后几条）`);
      return digest + '\n\n';
    } catch (error) {
      // 群近况是锦上添花，读不出来就当没问过，绝不连累唤醒。
      log(`[group-digest] 跳过 ${key}：${error?.message ?? error}`);
      return '';
    }
  }

  /**
   * 睡眠整合：4 点后第一次醒来时，给她今天发生过的摘要 + 提醒补日记。
   *
   * 图里的要求是「只是提醒，不强制」—— 所以文案里明说可以什么都不做。
   * 做过就落盘记今天，当天不再念。
   */
  // MARKER: diary-level
  // 展示用：只有非普通档才加标记，普通条目保持干净（不要每条都挂个【普通】）
  function fmtLevelTag(level) {
    const lv = normalizeLevel(level);
    if (lv === DEFAULT_LEVEL) return '';
    return `【${LEVEL_LABELS[lv] || lv}】`;
  }

  function fmtDiaryLine(e) {
    const lv = normalizeLevel(e?.level);
    // 给模型看的行里附上 id：改某条（mode=replace）要用
    // 有配图就把这件事告诉她（图本身在日记本里，不在聊天里）
    return `[${e.time || '未知时间'}]${fmtLevelTag(lv)}${e.mood ? `（${e.mood}）` : ''} ${e.text}${e.art && e.art.file ? ' 〔配图〕' : ''}${e.id ? ` 〔${e.id}〕` : ''}`;
  }

  // MARKER: diary-daily
  // 每天先日记：今天还没写就在私聊里提醒一次，冷却 3 小时、当天最多 3 次、安静时段不催。
  // 记账放独立状态文件，不塞进 conversation —— 免得和 social-v2.json 的整块落盘互相覆盖。
  let diaryDailyCache = null;
  function readDiaryDailyState() {
    if (diaryDailyCache) return diaryDailyCache;
    try {
      const raw = readJsonSafe(DIARY_DAILY_FILE, null, false);
      diaryDailyCache = raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object' ? raw : { days: {} };
    } catch (error) {
      log(`[diary-daily] 状态读取失败：${error?.message ?? error}`);
      diaryDailyCache = { days: {} };
    }
    return diaryDailyCache;
  }
  function saveDiaryDailyState(next) {
    diaryDailyCache = next;
    try {
      atomicWriteJson(DIARY_DAILY_FILE, next);
    } catch (error) {
      log(`[diary-daily] 状态落盘失败：${error?.message ?? error}`);
    }
  }
  function buildDailyDiaryLineFor(key) {
    const local = dailyDiaryCfg(cfg);
    if (!local.enabled) return '';
    // 只在私聊催：群里催人写日记很奇怪，而且她不一定在群里说话。
    if (!String(key ?? '').startsWith('private:')) return '';
    let entries = [];
    try {
      entries = readDiary(path.join(ROOT, 'diary', DIARY_JSONL));
    } catch {
      return '';
    }
    const now = Date.now();
    const out = decideDailyDiary({ entries, now, hour: new Date(now).getHours(), state: readDiaryDailyState(), cfg: local });
    if (out.nudged) {
      saveDiaryDailyState(out.state);
      log(`[diary-daily] ${key} 今天还没写日记，提醒一次（今天第 ${out.count} 次）`);
      return out.line;
    }
    if (out.dirty) saveDiaryDailyState(out.state);
    return '';
  }

  // MARKER: diary-draft-runtime
  // ① 结算写草稿 → 存 diary-draft.json；② 23:20 那一档催一次。
  // 草稿不进 日记.jsonl：她的日记得是她自己写的，系统替她写就不算数了。
  const DIARY_DRAFT_FILE = path.join(STATE_DIR, 'diary-draft.json');
  let diaryDraftCache = null;
  function readDiaryDraft() {
    if (diaryDraftCache !== undefined && diaryDraftCache !== null) return diaryDraftCache;
    try {
      const raw = readJsonSafe(DIARY_DRAFT_FILE, null, false);
      diaryDraftCache = normalizeDiaryDraft(raw, draftCfg(cfg));
    } catch (error) {
      log(`[日记草稿] 读取失败：${error?.message ?? error}`);
      diaryDraftCache = null;
    }
    return diaryDraftCache;
  }
  function saveDiaryDraft(draft) {
    diaryDraftCache = draft;
    try {
      atomicWriteJson(DIARY_DRAFT_FILE, draft);
    } catch (error) {
      log(`[日记草稿] 落盘失败：${error?.message ?? error}`);
    }
  }
  function buildDiaryDraftLineFor(key, reason) {
    if (!String(key ?? '').startsWith('private:')) return '';
    const dc = draftCfg(cfg);
    const draft = readDiaryDraft();
    if (!draft) return '';
    const now = Date.now();
    const isEvening = String(reason ?? '') === 'diary-reminder';
    if (!isEvening && !isDraftFresh(draft, { now, cfg: dc })) return '';
    let entries = [];
    try {
      entries = readDiary(path.join(ROOT, 'diary', DIARY_JSONL));
    } catch {}
    if (entries.some((e) => String(e.day ?? '') === localDayOf(now))) return ''; // 已经写了就不用再提草稿
    const line = diaryDraftLine(draft, { now, cfg: dc });
    if (!line) return '';
    return isEvening ? `【今天日记还空着】别拖到明天。\n\n` + line : line;
  }
  // 傍晚那一档：只有私聊、今天没写、当天还没催过的才催，一个 10 分钟窗口只跑一次。
  let diaryEveningBusy = false;
  async function diaryEveningTick() {
    if (diaryEveningBusy) return;
    const dc = draftCfg(cfg);
    const now = Date.now();
    if (!eveningDue(now, dc)) return;
    const day = localDayOf(now);
    const st0 = readDiaryDailyState();
    const done = (st0.eveningDays && st0.eveningDays[day]) || {};
    const keys = [];
    try {
      for (const key of Object.keys(socialV2.conversations || {})) {
        if (!String(key).startsWith('private:')) continue;
        if (done[key]) continue;
        const conv = socialV2.conversations[key];
        const msgs = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
        // 今天真说过话才催：一整天没人理她，她还去写日记给谁看。
        const talkedToday = msgs.some((m) => m && Number(m.at || 0) > 0 && localDayOf(Number(m.at)) === day);
        if (!talkedToday) continue;
        keys.push(key);
      }
    } catch (error) {
      log(`[日记草稿] 傍晚扫描失败：${error?.message ?? error}`);
      return;
    }
    if (!keys.length) return;
    let entries = [];
    try {
      entries = readDiary(path.join(ROOT, 'diary', DIARY_JSONL));
    } catch {}
    if (entries.some((e) => String(e.day ?? '') === day)) return;
    diaryEveningBusy = true;
    try {
      for (const key of keys) {
        try {
          saveDiaryDailyState({ ...st0, eveningDays: { ...(st0.eveningDays || {}), [day]: { ...done, [key]: now } } });
          await sendWakePromptV2(key, 'diary-reminder');
          log(`[日记] ${key} 23 点后还没写，催一次`);
        } catch (error) {
          log(`[日记] ${key} 傍晚催写失败：${error?.message ?? error}`);
        }
      }
    } finally {
      diaryEveningBusy = false;
    }
  }

  function buildSleepReviewLineFor(key) {
    if (cfg.socialV2?.sleepReview?.enabled === false) return '';
    let sleepSt;
    try {
      sleepSt = getSleepReviewState();
    } catch {
      return '';
    }
    const now = new Date();
    const nowMs = now.getTime();
    // 今天 0 点起算「今天」
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const material = formatSleepReviewMaterial({
      conversations: Object.fromEntries(socialV2.conversations),
      now: nowMs,
      dayStartMs: dayStart.getTime()
    });
    if (!shouldSleepReview(sleepSt, { key, now, hasActivity: !!material })) return '';
    markSleepReviewed(sleepSt, { key, now });
    saveSleepReviewState();
    log(`[sleep-review] 注入今日回顾 ${key}（${localDayOf(now)}）`);
    // MARKER: diary-level
    // 空窗提醒：她连着几天没写，就直接说出来。
    // 原来只说「想记的写一条」，三天一条没写 —— 抽象的门槛等于没有门槛。
    let diaryGap = '';
    try {
      const entries = readDiary(path.join(ROOT, 'diary', DIARY_JSONL));
      const gap = daysSinceLast(entries, nowMs);
      const lv = diaryStats(entries, nowMs).byLevel;
      if (gap === null) diaryGap = '你还没写过日记。';
      else if (gap >= 1) diaryGap = `你上次写日记是 ${gap} 天前了。`;
      if (entries.length) diaryGap += `（本子上一共 ${entries.length} 条：不想忘 ${lv.critical}、重要 ${lv.important}、普通 ${lv.normal}）`;
    } catch {
      diaryGap = '';
    }
    return '【今天过完了】下面是今天发生的事。睡前翻一翻，挑一件具体的小事记下来 —— 用 qq_diary 写一两句，别写总结句。'
      + (diaryGap ? diaryGap + '\n' : '')
      + '记的时候可以标个档：level=critical（非常重要，永不淡）、level=important（重要，两三周慢慢淡）、不标就是普通（几天就淡了）。'
      + '标档不是做报表，是给你自己以后翻日记时用的 —— 觉得就是件普通事，那就真的别标。'
      + '想顺带记一下当时的心情就带 mood。'
      + '不想写、不想动，就直接安静收尾，没人要求你必须留点什么。\n'
      + (material ? material + '\n' : '')
      + '\n';
  }


  // MARKER: phone-bridge-wire
  // ── 浏览器桥：借主人电脑的 IP 发站点请求 ──
  //
  // 为什么需要：服务器（阿里云）的 IP 被 B 站风控，
  //   /x/web-interface/view  → -412 request was banned
  //   /x/v2/reply            → 被重定向成 HTML 页面
  // 同一组请求从主人本机发出是 200。所以站点请求必须借浏览器的 IP 发。
  const phoneBridge = new PhoneBridge({
    log: (msg) => log(msg)
  });
  // MARKER: modules-ctx-phone
  // 浏览器桥：phoneBridge 只建一次（交引用），phoneTokenOk 交闭包。
  Object.assign(moduleCtx, {
    phoneBridge,
    phoneTokenOk: (token) => phoneTokenOk(token),
  });

  let phoneTokenCache = { value: '', mtimeMs: 0 };

  /** 读取扩展访问令牌（无则生成）。缓存按 mtime 失效，改文件不必重启进程。 */
  function phoneToken() {
    try {
      const st = fs.statSync(PHONE_TOKEN_FILE);
      if (phoneTokenCache.value && phoneTokenCache.mtimeMs === st.mtimeMs) {
        return phoneTokenCache.value;
      }
      const v = fs.readFileSync(PHONE_TOKEN_FILE, 'utf8').trim();
      if (v) {
        phoneTokenCache = { value: v, mtimeMs: st.mtimeMs };
        return v;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`[phone] 读令牌失败：${error?.message ?? error}`);
    }
    // 没有就生成一个
    const fresh = crypto.randomBytes(24).toString('hex');
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(PHONE_TOKEN_FILE, fresh + '\n', { mode: 0o600 });
      const st = fs.statSync(PHONE_TOKEN_FILE);
      phoneTokenCache = { value: fresh, mtimeMs: st.mtimeMs };
      log('[phone] 首次运行，已生成浏览器扩展访问令牌（state/phone-token）');
    } catch (error) {
      log(`[phone] 生成令牌失败：${error?.message ?? error}`);
    }
    return fresh;
  }

  /** 扩展提交的令牌是否正确。不回显、不区分「没带」和「带错」。 */
  function phoneTokenOk(token) {
    const expect = phoneToken();
    if (typeof token !== 'string' || !token || !expect) return false;
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expect, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  /** B 站客户端工厂（复用同一个 phoneBridge）。 */
  let biliClientCache = null;
  // MARKER: bili-browse
// 她自己刷 B 站：后台不定期拉推荐流、点进去看几条、偶尔真看一个画面，
// 结果落在 state/bili-browse.json，等她下一次被唤醒时当成「你刚刷到的」注入。
// 一条记录只提一次（promptedAt），不然 8 小时里每轮都念同一段会很烦。
const BILI_BROWSE_FILE = path.join(STATE_DIR, 'bili-browse.json');
let biliBrowseBusy = false;
function readBiliBrowse() {
  return readBrowse(BILI_BROWSE_FILE);
}
function writeBiliBrowse(data) {
  return writeBrowse(BILI_BROWSE_FILE, data);
}
async function biliBrowseTick() {
  if (biliBrowseBusy) return;
  const bc = cfg.socialV2?.biliBrowse ?? {};
  if (bc.enabled === false) return;
  const hour = new Date().getHours();
  const fromHour = Number(bc.fromHour ?? 9);
  const toHour = Number(bc.toHour ?? 23);
  if (hour < fromHour || hour >= toHour) return;
  const now = Date.now();
  const prev = readBiliBrowse() || {};
  const gapMs = Math.max(30, Number(bc.minGapMinutes ?? 180)) * 60000;
  if (prev.at && now - prev.at < gapMs) return;
  const today = new Date().toISOString().slice(0, 10);
  const dayCount = prev.day === today ? Number(prev.count || 0) : 0;
  if (dayCount >= Number(bc.maxPerDay ?? 5)) return;
  biliBrowseBusy = true;
  try {
    log('[bili-browse] 开始刷一轮…');
    const r = await browseRound({
      client: biliClient(),
      // biliHelpers 只是下面 helpers 容器的键名，不是变量（原来写 biliHelpers.watchVideo
      // 每次都在这里抛 ReferenceError: biliHelpers is not defined，线上 2026-10-30 12:14 实证）。
      // 这里直接调导入的函数，与 biliHelpers.watchVideo 的实现保持同一份。
      // 展开顺序很重要：依赖放在 args 之后，免得将来调用方多传一个 direct/log 把它们覆盖掉。
      // maxBytes 显式给：不传就只有 bili-watch 的内部默认，调用方看不出来上限是多少。
      // 代看放在这层做，不放 browseRound 里：
      // browseRound 是纯逻辑模块，返回值要能直接 JSON 落盘，不该承载二进制。
      watch: async (args) => {
        const r = await watchBiliVideo({
          ...(args || {}),
          direct: biliDirect(),
          log: (m) => log(m),
          maxBytes: Number(args && args.maxBytes) || WATCH_DEFAULTS.maxBytes
        });
        if (!r || !r.ok || !Array.isArray(r.tiles) || !r.tiles.length) return r;
        // 只转第一张：一轮一张够她接话，多转只是多烧钱。
        // 主模型不吃图，不转写成文字等于没看。
        try {
          const first = r.tiles.find((t) => t && Buffer.isBuffer(t.buffer));
          if (first) {
            const text = await describeImage({
              mediaType: 'image/jpeg',
              data: first.buffer.toString('base64'),
              name: `bili-${String(r.video?.bvid || 'x')}-1.jpg`
            });
            // 当成不可信外部内容：去控制字符、压成一行、限长。
            // 字幕里可能带指令性文字，转述出来也不能当命令用。
            const clean = String(text || '')
              .replace(/[\u0000-\u001f\u007f]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 120);
            if (clean) {
              r.see = clean;
              log(`[bili-browse] 代看画面 ${clean.length} 字：${clean.slice(0, 30)}`);
            } else {
              log('[bili-browse] 代看返回空，只当没看清');
            }
          }
        } catch (error) {
          // 代看失败不影响这一轮：清单照留，但不声称看过画面
          log(`[bili-browse] 代看没成：${error?.message ?? error}`);
        }
        // 无论成功与否，Buffer 都不能留在返回值里（JSON 化会膨胀成字节数组）
        r.tiles = r.tiles.map(({ buffer, ...rest }) => rest);
        return r;
      },
      log,
      cfg: bc
    });
    if (!r.ok) {
      log(`[bili-browse] 这轮没刷成：${r.error}`);
      return;
    }
    writeBiliBrowse({ ...r, day: today, count: dayCount + 1, promptedAt: 0 });
    const watched = r.watched && !r.watched.error ? '，还看了一个画面' : '';
    log(`[bili-browse] 刷到 ${r.items.length} 条${watched}`);
  } catch (error) {
    log(`[bili-browse] 抛错：${error?.message ?? error}`);
  } finally {
    biliBrowseBusy = false;
  }
}

// MARKER: sticker-learn
// 表情包「自己学会」：群里反复出现的图，自己收进库。
//
// 为什么是这个通道：state/sticker-sightings.json 里的 url 是入站签名地址，
// 几小时就失效（实测直下 3/3 全部 HTTP 400），补不了图。
// 能取到字节的只有 social-v2.json 的 recentMessages[].media —— collectStickerV2
// 内部走 fetchOneBotImage 再 get_image 换新鲜 url，这条路实测可通。
//
// 一句话：观测次数达标 + 还留在 recentMessages 里 + 不在库 + 没被自己发过，
// 四个条件同时成立才收，收的时候把语境写进备注（不猜用法）。
const STICKER_LEARN_FILE = path.join(STATE_DIR, 'sticker-learn.json');
let stickerLearnBusy = false;
function readStickerLearn() {
  return readBrowse(STICKER_LEARN_FILE);
}
function writeStickerLearn(data) {
  return writeBrowse(STICKER_LEARN_FILE, data);
}

/**
 * 把刚学会的 emojiId 加进提示词白名单。
 *
 * 为什么必须加：buildStickerContext 的 allowIds 非空时只放行名单内的 id，
 * 不加进去的话「学了也看不见」，等于白学。
 * 白名单原本为空时直接返回 —— 空 = 全部放行，比追加成白名单更宽松。
 */
function addStickerToAllowlist(emojiId) {
  const id = String(emojiId || '').trim();
  if (!id) return;
  try {
    const cur = Array.isArray(cfg.socialV2?.sticker?.allowIds)
      ? cfg.socialV2.sticker.allowIds.map(String).filter(Boolean)
      : [];
    if (!cur.length) return;
    if (cur.includes(id)) return;
    // 上限 60，先清失效 id。原来的 `slice(-40)` 是纯 FIFO，实测第一轮就把手工挑的
    // mfuns-02 挤掉了 —— 而库里 27 个 QQ 表情有 10 个 useCount=0 从没被淘汰过。
    // 真正卡提示词长度的是 buildStickerContext 的 max（promptMaxStickers=30），
    // allowIds 只是粗筛，没必要勒到 40。
    const LIMIT = 60;
    const libEntries = Array.isArray(stickerEntries) ? stickerEntries : [];
    const libIds = new Set(libEntries.map((e) => String(e?.id || '')));
    let next = [...cur, id];
    if (libIds.size) next = next.filter((x) => x === id || libIds.has(x));
    let victim = '';
    if (next.length > LIMIT) {
      // 只淘汰 QQ 收藏表情，手工挑的不动；挤出去的是最早进名单的那张。
      const dropIdx = next.findIndex((x) => x !== id && String(x).startsWith('2157801858_'));
      if (dropIdx >= 0) {
        victim = next[dropIdx];
        next = next.filter((_, i) => i !== dropIdx);
      }
    }
    const configFile = path.join(ROOT, 'config.json');
    const file = readConfigObject(configFile);
    if (!file.socialV2 || typeof file.socialV2 !== 'object') file.socialV2 = {};
    if (!file.socialV2.sticker || typeof file.socialV2.sticker !== 'object') file.socialV2.sticker = {};
    file.socialV2.sticker.allowIds = next;
    atomicWriteJson(configFile, file);
    cfg.socialV2.sticker.allowIds = next;
    log(`[sticker-learn] 白名单加进 ${id}（现 ${next.length} 张${victim ? '，挤掉 ' + String(victim).slice(-20) : ''}）`);
  } catch (error) {
    log(`[sticker-learn] 写白名单失败：${error?.message ?? error}`);
  }
}

async function stickerLearnTick() {
  if (stickerLearnBusy) return;
  const sc = cfg.socialV2?.sticker ?? {};
  const lc = sc.learn ?? {};
  if (sc.enabled === false) return;
  if (lc.enabled === false) return;
  if (sc.sightings?.enabled === false) return;   // 没有观测就没有输入，直接跳过
  const now = Date.now();
  const record = readStickerLearn() || {};
  if (!learnQuota(record, lc, now).can) return;

  let sightings = [];
  try {
    const res = readSightings(STATE_DIR, { minCount: Math.max(1, Number(lc.minCount) || 3) });
    sightings = Array.isArray(res?.items) ? res.items : [];
  } catch (error) {
    log(`[sticker-learn] 读观测失败：${error?.message ?? error}`);
    return;
  }
  if (!sightings.length) return;

  // 用内存里的会话状态而不是文件：文件是定时落盘的，内存才是最新的。
  const recentIndex = buildRecentIndex(Object.fromEntries(socialV2.conversations));
  const perTick = Math.max(1, Number(lc.maxPerTick) || 2);
  const candidates = pickLearnCandidates({
    sightings, library: stickerEntries, recentIndex, record, now, opts: lc
  }).slice(0, perTick);
  if (!candidates.length) return;

  stickerLearnBusy = true;
  try {
    let learned = 0;
    let next = record;
    for (const cand of candidates) {
      const remark = buildLearnRemark(cand, lc);
      try {
        const got = await collectStickerV2(cand.key, cand.messageId, remark);
        next = recordLearnAttempt(next, cand.hash, { ok: true, now: Date.now() });
        writeStickerLearn(next);
        learned += 1;
        log(`[sticker-learn] 学会一张 ${String(cand.hash).slice(0, 8)}（${cand.key} 里出现 ${cand.count} 次）：${remark}`);
        if (got?.emojiId) addStickerToAllowlist(got.emojiId);
      } catch (error) {
        next = recordLearnAttempt(next, cand.hash, { ok: false, error: error?.message ?? String(error), now: Date.now() });
        writeStickerLearn(next);
        log(`[sticker-learn] 没学成 ${String(cand.hash).slice(0, 8)}：${error?.message ?? error}`);
      }
    }
    if (learned) log(`[sticker-learn] 这轮共学会 ${learned} 张`);
  } catch (error) {
    log(`[sticker-learn] 抛错：${error?.message ?? error}`);
  } finally {
    stickerLearnBusy = false;
  }
}

// MARKER: bili-direct
  // 直连出口：不依赖浏览器桥，补一个 buvid3 就能打 B 站接口（2026-10-29 实测全通）。
  // 桥留在 BiliClient.egress() 里当兜底，直连哪天被风控了还能退回去。
  let biliDirectCache = null;
  function biliDirect() {
    if (!biliDirectCache) {
      biliDirectCache = createBiliDirect({
        stateFile: path.join(STATE_DIR, 'bili-cookie.json'),
        log: (msg) => log(msg)
      });
    }
    return biliDirectCache;
  }

  function biliClient() {
    if (!biliClientCache) {
      biliClientCache = new BiliClient({
        phone: phoneBridge,
        direct: biliDirect(),
        log: (msg) => log(msg)
      });
    }
    return biliClientCache;
  }

// MARKER: modules-ctx-forward
  // 合并转发查看模块的句柄。全部包箭头：
  // getSocialV2State / fetchMediaData / modeAllowed 都在注入点之后声明，
  // bot 是 late 绑定（可能在 main() 里被整体重新赋值），seenForwardIds 是会被清空的 Map。
  Object.assign(moduleCtx, {
    forwardHelpers: {
      currentMode: () => currentMode,
      getSocialV2State: (k) => getSocialV2State(k),
      modeAllowed: (k, kind, id, config, mode) => modeAllowed(k, kind, id, config, mode),
      seenForwardIds: () => seenForwardIds,
      bot: () => bot,
      fetchMediaData: (list) => fetchMediaData(list),
    },
  });

// MARKER: modules-ctx-bili
  // B 站浏览模块用的句柄。biliClient 懒建一次后复用（内部持有唯一的 PhoneBridge 订阅），
  // 所以交工厂而不是交实例 —— 注入这一刻它还是 null。
  Object.assign(moduleCtx, {
    biliHelpers: {
      biliClient: () => biliClient(),
      phoneOnline: () => phoneOnline(),
      // 刷站的主路已经是直连，桥离线不再等于「刷不了」（2026-10-29）
      biliOnline: () => biliOnline(),
      biliDirect: () => biliDirect(),
      watchVideo: (opts) => watchBiliVideo({ direct: biliDirect(), log: (m) => log(m), ...opts }),
      // 主模型（deepseek）不接图：拼图必须在这里就转成文字，
      // transcribeMediaImages 返回的项不带 data，上层就不会拼出 image block。
      transcribeImages: (images) => transcribeMediaImages(images),
      describePhoneOffline,
      describeBiliResult,
    },
  });

  /** 给别的模块用：浏览器扩展现在在不在线。 */
  function phoneOnline() {
    return phoneBridge.isOnline();
  }

  /**
   * 现在能不能刷站。
   *
   * 直连（bili-direct）没有任何前置状态要等 —— buvid3 是现拿的，桥在不在线都无所谓，
   * 所以这里恒为 true。真的连不上时，请求里会抛出带原因的具体错误，比在这里猜准得多。
   * 留着这个函数是为了：模块侧的 503 分支不用动，将来要加「连续失败就暂停」也有个地方挂。
   */
  function biliOnline() {
    return true;
  }


  // MARKER: spotify-client-factory
  // 单例：token 缓存与刷新都在实例里，每次重建等于每次握手。
  let spotifyClientCache = null;
  function spotifyClient() {
    if (!spotifyClientCache) {
      const sc = cfg.spotify ?? {};
      spotifyClientCache = new SpotifyClient({
        clientId: String(sc.clientId ?? ''),
        clientSecret: String(sc.clientSecret ?? ''),
        redirectUri: String(sc.redirectUri ?? 'http://127.0.0.1:8888/callback'),
        secrets: new SecretBox({ dir: STATE_DIR }),
        log: (m) => log(m)
      });
    }
    return spotifyClientCache;
  }

  function v2ToolEnabled(flag) {
    return cfg.socialV2?.tools?.[flag] !== false;
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = configuredToken.length >= 16 && configuredToken.length <= 128 && /^[A-Za-z0-9_-]+$/.test(configuredToken);
    // loadOrCreateConsoleToken() 返回 { token, fromFile }：
    // fromFile=true 表示 state/console-token 里已有值、本次只是沿用。
    const loadedToken = tokenValid ? null : loadOrCreateConsoleToken();
    const consoleTokenLoadedFromFile = Boolean(loadedToken?.fromFile);
    let consoleToken = tokenValid ? configuredToken : loadedToken.token;
  // MARKER: modules-ctx-console-token
  // consoleToken 是本函数的局部 let，模块改令牌后必须靠这个句柄写回。
  Object.assign(moduleCtx, { consoleTokenSet: (value) => { consoleToken = value; } });
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    // ⚠️ 文案必须区分「首次生成」与「沿用文件里已有的」：loadOrCreateConsoleToken()
    // 是「有就读、没有再生成」，令牌本身在多次重启间**是稳定的**。
    // 原来一律写「已自动生成」，看日志的人会以为每次重启都换了令牌，
    // 进而怀疑控制台凭据失效 —— 实际没有。
    if (!configuredToken) {
      log(consoleTokenLoadedFromFile
        ? `控制台未配置 consoleToken，沿用 state/console-token 中已有的令牌：${String(consoleToken).slice(0, 6)}…`
        : `控制台未配置 consoleToken，已自动生成：${String(consoleToken).slice(0, 6)}…（完整值保存在 state/console-token）`);
    }
    // 二代会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
    // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
    //
    // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
    // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
    const tokenEq = (a, b) => {
      if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
      const x = Buffer.from(a, 'utf8');
      const y = Buffer.from(b, 'utf8');
      return x.length === y.length && crypto.timingSafeEqual(x, y);
    };
    const agentTokenOk = (key, token) => {
      const canonical = canonicalV2Key(key);
      const st = socialV2.conversations.get(canonical ?? key);
      return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
    };
    // MARKER: image-approval-adelegate
    // 主人私聊的令牌可以代发到好友私聊（边界见 ownerDelegateTokenOk）。
    // 只给 4 个发送端点用；其余端点仍走严格的 agentTokenOk。
    const agentTokenOkOrOwnerDelegate = (key, token) => {
      if (agentTokenOk(key, token)) return true;
      try { return ownerDelegateTokenOk(key, token); } catch { return false; }
    };
    /**
     * 令牌是否匹配**任意**一个活跃二代会话。
     *
     * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
     * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
     * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
     * 端点漏写时会整个失效。
     */
    const isLiveAgentToken = (token) => {
      if (typeof token !== 'string' || !token) return false;
      for (const st of socialV2.conversations.values()) {
        if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
      }
      return false;
    };
    // 二代会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const v2SessionAllowed = isSessionAllowedInCurrentMode;
    // MARKER: modules-ctx-ops-token
    // 把鉴权原语交到 main() 作用域：它们是 startConsoleServer() 的局部 const，
    // ops 模块的 /api/authorize/read 要用，但模块拿不到那个闭包。
    Object.assign(moduleCtx, {
      agentTokenOk,
      isLiveAgentToken,
      v2SessionAllowed,                 // = isSessionAllowedInCurrentMode，上一行声明的 const
      v2ToolEnabled: (flag) => v2ToolEnabled(flag),
      agentTokenOk: (key, token) => agentTokenOk(key, token),
      agentTokenOkOrOwnerDelegate: (key, token) => agentTokenOkOrOwnerDelegate(key, token),  // 函数声明在 L4652，交闭包避开 TDZ
      safeFetchBuffer,                  // 顶层 import 的纯函数（safe-fetch.js），交引用安全
    });
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      };
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }

      // MARKER: modules-diagnostics
      // 模块诊断端点（只读）。只回「装了什么、有没有问题」，不含令牌、聊天内容或文件路径。
      // 故意的取舍：放在 Host 校验之后（DNS rebinding 那层仍然有效），但放在令牌校验之前 ——
      // 出问题时最需要「不登录也能一眼看出装载器活没活」。它不泄露任何会话数据。
      if (req.method === 'GET' && url.pathname === '/api/_modules') {
        sendJson({
          ok: true,
          enabled: cfg.socialV2?.modules?.enabled !== false,
          loaded: moduleHost !== null,
          registry: moduleHost ? moduleHost.describe() : null,
        });
        return;
      }

      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      const hostHeader = String(req.headers.host ?? '');
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      // MARKER: phone-bridge-host —— 浏览器扩展是主人电脑上的独立进程，访问控制台时
      // Host 是公网地址而不是回环地址。只对 /api/phone/* 放行，且那几条路由自己校验
      // x-phone-token（独立的 48 位十六进制令牌），DNS rebinding 的威胁模型不适用于它：
      // 攻击者把域名解析到 127.0.0.1 也拿不到 phone-token。控制台其它路径仍然只认回环。
      const phoneHostExempt = url.pathname.startsWith('/api/phone/');
      if (!allowedHosts.includes(hostHeader.toLowerCase()) && !phoneHostExempt) {
        sendJson({ ok: false, error: `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问` }, 403);
        return;
      }
      // 控制台鉴权：所有请求需带 x-console-token 或 ?token=
      // 定长比较：`!==` 会在第一个不同的字符处短路，理论上可被本机进程用响应时延逐字节试探。
      // 令牌是 192 bit 随机值且只监听回环，所以这是纵深防御而非在野漏洞。
      const suppliedToken = String(url.searchParams.get('token') ?? req.headers['x-console-token'] ?? '');
      const tokenMatches = (() => {
        if (!consoleToken) return false; // 上面已拒绝空令牌；真出现也只许失败关闭，绝不 return true
        const a = Buffer.from(suppliedToken, 'utf8');
        const b = Buffer.from(consoleToken, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      // MARKER: phone-bridge-exempt —— /api/phone/* 走独立令牌（x-phone-token），
      // 不吃控制台令牌：扩展装在主人浏览器里，不该持有控制台全权令牌（那是管理端全权）。
      // 放行点放在 Host 校验之后，各路由自己校验 phoneTokenOk()。
      const phonePathExempt = url.pathname.startsWith('/api/phone/');
      if (consoleToken && !tokenMatches && !phonePathExempt) {
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end('<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>');
        } else {
          sendJson({ ok: false, error: '未授权：请提供控制台访问令牌' }, 401);
        }
        return;
      }
      // 智能体调用隔离（集中关卡）。
      //
      // 背景：控制台令牌是「管理端全权」，会话令牌是「只能动自己这个会话」。MCP 工具进程
      // 两者都持有，所以「这次请求到底是智能体发的还是管理端发的」必须由请求自己声明。
      // 各端点用 `if (x-agent-token && !agentTokenOk(...))` 做会话绑定校验，但那个写法在
      // **头缺失时整条跳过** —— 而头缺失恰恰是模型没传 token 时的自然结果
      // （旧版 mcp-snowluma-safe.js 用 `...(token ? {...} : {})` 直接省略了这个头）。
      // 于是「漏传令牌」不是被拒绝，而是**升级成控制台全权**：典型的 confused deputy。
      //
      // 现在 MCP 端一律带上 x-agent-call: 1（缺令牌时 x-agent-token 为空串），这里只要看到
      // 这个声明就要求令牌必须命中某个活跃会话，端点自己漏写校验也不会退回管理端。
      if (req.headers['x-agent-call'] !== undefined) {
        if (!isLiveAgentToken(req.headers['x-agent-token'])) {
          sendJson({ ok: false, error: '未授权：智能体调用必须携带有效的会话令牌' }, 403);
          return;
        }
      }
      // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
      // 默认未配 consoleToken 时，这可阻止任意网页用表单/跨站请求触发
      // /api/restart、/api/workspace/reset、/api/role 等破坏性接口。
      if (req.method !== 'GET') {
        const ctype = String(req.headers['content-type'] ?? '');
        if (!ctype.toLowerCase().includes('application/json')) {
          sendJson({ ok: false, error: '请求必须是 application/json' }, 415);
          return;
        }
        const origin = req.headers['origin'];
        if (origin) {
          let originHost = '';
          try { originHost = new URL(String(origin)).host; } catch {}
          if (![`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`].includes(originHost)) {
            sendJson({ ok: false, error: '跨站请求被拒绝' }, 403);
            return;
          }
        }
      }
      try {
        // 空 agent token 一律拒绝，防止 MCP 传入空字符串时被当作“管理端/无 token”绕过校验
        if (req.headers['x-agent-token'] === '') {
          sendJson({ ok: false, error: 'agent token 不能为空' }, 403);
          return;
        }
        // 暂停二代 AI 时，所有带 agent token 的 v2 工具调用一律拒绝
        if (socialV2.paused && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 二代模式总开关：关闭后 agent token 调用的 v2 工具全部拒绝（控制台仍可管理）
        if (cfg.socialV2?.enabled === false && req.headers['x-agent-token'] && (url.pathname.startsWith('/api/socialV2/') || url.pathname.startsWith('/api/send/') || url.pathname.startsWith('/api/images/'))) {
          sendJson({ ok: false, error: '二代模式已关闭，当前不允许执行 v2 工具' }, 403);
          return;
        }
        // 模式隔离：带 agent token 的 v2 接口只允许在 reserved2 模式下使用
        if (req.headers['x-agent-token'] && url.pathname.startsWith('/api/socialV2/') && currentMode !== 'reserved2') {
          // MARKER: mode-gate-why
          // 带上当前模式：以前只说「仅 reserved2 可用」，看不出到底是「真的不是 reserved2」
          // 还是「刚重启还没读到 DSH 设置」，两种处理方式完全不同。
          sendJson({ ok: false, error: `该接口仅 reserved2 模式可用（当前模式：${currentMode}）` }, 403);
          return;
        }
        // 管理端专用 v2 接口：带 agent token 的请求一律拒绝，防止 MCP 工具越权访问控制台功能
        const adminOnlyV2Paths = ['/api/socialV2/config', '/api/socialV2/activity', '/api/socialV2/reset', '/api/socialV2/states', '/api/socialV2/wake'];
        if (req.headers['x-agent-token'] && (adminOnlyV2Paths.includes(url.pathname) || (url.pathname === '/api/socialV2/feedback' && req.method === 'GET') || (url.pathname === '/api/socialV2/tool-log' && req.method === 'GET'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
        // 表情库管理接口只允许控制台（带 agent token 的 v2 工具一律拒绝，防止越权改库）
        if (req.headers['x-agent-token'] && (url.pathname === '/api/stickers' || url.pathname.startsWith('/api/stickers/'))) {
          sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
          return;
        }
      // MARKER: modules-delegate
      // 功能模块委派（阶段 1）。
      //
      // 位置很关键：**在控制台令牌闸门与全部智能体闸门闭合之后**。
      //
      // 阶段 8 修正：原先放在 favicon 之后（= 令牌闸门之前），对照黄金快照才发现
      // `GET /api/stickers` 的 anon 身份从 401 变成了 200 —— 能匿名读到 2179 条表情元数据。
      // 根因是 /api/stickers 在老 if 链里就位于令牌闸门之后，而模块委派点比它靠前。
      // 现在挪到闸门之后：模块与老 if 链看到的是同一份「已过令牌校验」的请求。
      //
      // 第二次修正（同一天）：令牌闸门之后还有一整段**智能体隔离闸门**（空令牌拒绝、
      // 暂停/停用、reserved2 模式、adminOnly、表情库仅控制台）。这些是缩进 8 的前缀 if，
      // 位置本来就比老路由靠前；但委派点如果放在它们中间，模块路由就会跳过它们。
      // 已实测到「agent token 打在 /api/stickers 上由 403 变 200」。
      // 所以委派点最终定在**表情库闸门之后、第一条普通业务路由之前**。
      // （原注释写的「favicon 之后 = 全部闸门之后」是错的：favicon 处理在 4636 行左右，
      //   令牌闸门在 4843 行，两者之间还隔着整个鉴权段。）
      //
      // 没命中任何模块路由时返回 "unhandled"，继续走下面的老 if 链，行为零变化。
      if (moduleHost) {
        let verdict = 'unhandled';
        try {
          verdict = await moduleHost.dispatch(req.method, url.pathname, { req, res, url, sendJson, readBody });
        } catch (error) {
          // MARKER: module-stack —— 光有 message 定位不到行（22:06:34 那条
          // `key is not defined` 就是这样，静态扫了 108 条路由也没复现）。
          // 这里把 method+path 和前三层栈帧一起打出来，下次一犯就能指到行号。
          log('[modules] 路由处理失败:', error?.message ?? error, `${req.method} ${url.pathname}`);
          const stk = String(error?.stack ?? '').split('\n').slice(1, 4).map((s) => s.trim()).join(' | ');
          if (stk) log('[modules] 出错位置:', stk);
          sendJson({ ok: false, error: `模块处理失败：${error?.message ?? error}` }, Number(error?.statusCode) || 500);
          return;
        }
        if (verdict === 'handled') return;
      }

        // agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
        // 因此仅靠控制台令牌挡不住 AI。这里改成白名单：只有 AI 真正需要的面放行，
        // 其余（人格/提示词/思考强度/白名单/重启…）一律 403——避免以后新增管理端点时忘记拉黑。
        if (req.headers['x-agent-token']) {
          const agentAllowed = url.pathname === '/api/status'
            || url.pathname.startsWith('/api/socialV2/')
            || url.pathname.startsWith('/api/send/')
            || url.pathname.startsWith('/api/images/')
            || url.pathname === '/api/authorize/read';
          if (!agentAllowed) {
            sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
            return;
          }
        }
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：qq-bridge/public/console.html');
          }
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────

        // ── 仿真提示词（一代 / 二代各自的预设内置提示词）──────────────────────
        // ── 黑话库管理 ──────────────────────────────────────────────────────
        // ── 会话查看 ──────────────────────────────────────────────────────────
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        // ── DSH 模型与思考强度 ───────────────────────────────────────────────

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        // ── 二代仿真模式（reserved2）内部 Agent API ─────────────────────────
        // MARKER: bili-route
        // B 站只读（MCP qq_bili 走这里）。
        //
        // 为什么要绕这么一圈：这台服务器的出口 IP 已被 B 站拉黑（/x/web-interface/view
        // 直接 -412 request was banned）。所以请求一律交给主人电脑上的浏览器扩展代发，
        // 桥接只负责排队、等结果、把 JSON 掰成人话。
        //
        // 只读：四个 action 全是 GET，没有点赞/投币/收藏/评论/发弹幕的代码路径。
        // MARKER: v2-rest-rollback
        // 阶段27 事故回滚（2026-10-24）：模块化把 config→forward-message 之间 1957 行整段删掉，
        // 但只搬了 13 条进 core 模块，剩下 14 条（send-message / send-sticker / send-poke /
        // send-burst / record-sent / check-send / collect-sticker / wait / diary / album /
        // schedule / portrait / qzone / send-voice）连带被删，导致 MCP 里 8 个工具全线 404。
        // 这里把原文逐字插回来：零改写 = 零行为变化。它们的闭包依赖 67–91，是整个仓库最重的一族，
        // 后续要模块化必须连同 ctx 一起设计，不能再来一次「整段删除 + 部分搬运」。
        // 位置与原位置一致：控制台令牌闸门与智能体闸门之后、第一条普通业务路由之前。

        if (req.method === 'POST' && url.pathname === '/api/socialV2/qzone') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const action = String(body.action ?? 'post').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('qzone')) { sendJson({ ok: false, error: '工具未启用：qq_qzone' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          const qzoneCall = async (name, params, timeoutMs = 60000) => {
            const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
            const res = await fetch(`${httpUrl}/${name}`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
              },
              body: JSON.stringify(params),
              signal: AbortSignal.timeout(timeoutMs)
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.status !== 'ok' || (data.retcode !== undefined && data.retcode !== 0)) {
              throw new Error(`${name} 失败: ${data.wording || data.retcode || res.status}`);
            }
            return data.data;
          };
          try {
            if (action === 'list') {
              const data = await qzoneCall('get_qzone_msg_list', {
                ...(body.targetUin ? { target_uin: Number(body.targetUin) } : {}),
                pos: Number.isFinite(Number(body.pos)) ? Number(body.pos) : 0,
                num: Math.min(30, Math.max(1, Number(body.num) || 10))
              });
              sendJson({ ok: true, action: 'list', data });
              return;
            }
            if (action === 'delete') {
              const tid = String(body.tid ?? '').trim();
              if (!/^[A-Za-z0-9_-]{4,120}$/.test(tid)) { sendJson({ ok: false, error: 'tid 格式不对（用 action=list 拿到的 tid）' }, 400); return; }
              await qzoneCall('delete_qzone_msg', { tid });
              log(`[qzone] 删除说说 tid=${tid}`);
              // 删了就要把本地账划掉，否则 qzone-post.json 里留着这条，冷却会一直说「刚发过」。
              // 2026-10-28 咱自测那条删了两小时，本地账还在，把她卡了整整一小时的冷却。
              try {
                const psPath = path.join(STATE_DIR, 'qzone-post.json');
                const psRaw = fs.readFileSync(psPath, 'utf8');
                const psData = JSON.parse(psRaw);
                const before = Array.isArray(psData?.posts) ? psData.posts : [];
                const kept = before.filter((p) => String(p?.tid ?? '') !== tid);
                if (kept.length !== before.length) {
                  fs.writeFileSync(psPath, JSON.stringify({ posts: kept }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
                  log(`[qzone] 已从本地账里划掉 tid=${tid}（剩 ${kept.length} 条）`);
                }
              } catch (error) {
                log(`[qzone] 划账失败：${error?.message ?? error}`);
              }
              sendJson({ ok: true, action: 'delete', tid });
              return;
            }
            if (action !== 'post') { sendJson({ ok: false, error: 'action 只支持 post / list / delete' }, 400); return; }
            const content = String(body.content ?? '').trim();
            const images = Array.isArray(body.images) ? body.images.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, 9) : [];
            // MARKER: qzone-image-base64
            // SnowLuma 在容器里看不到宿主机的 state/images，而它的 send_qzone_msg 支持 base64://，
            // 所以这里先读成 base64 再递过去（和发 QQ 图片走 base64 是同一个思路）。
            let uploadImages = [];
            try {
              uploadImages = prepareQzoneImages(images, { imageDir: path.join(STATE_DIR, 'images'), stateDir: STATE_DIR });
            } catch (error) {
              sendJson({ ok: false, error: String(error?.message ?? error) }, 400);
              return;
            }
            if (!content && !images.length) { sendJson({ ok: false, error: 'content 和 images 不能同时为空' }, 400); return; }
            if (content.length > 1000) { sendJson({ ok: false, error: '说说正文最多 1000 字' }, 400); return; }
            const postCfg = cfg.qzone?.post ?? {};
            const maxPerDay = Math.max(1, Number(postCfg.maxPerDay) || 3);
            const minIntervalMs = Math.max(0, Number(postCfg.minIntervalMs) || 3600000);
            const postStatePath = path.join(STATE_DIR, 'qzone-post.json');
            let postState = { posts: [] };
            try { postState = JSON.parse(fs.readFileSync(postStatePath, 'utf8')); } catch { postState = { posts: [] }; }
            const now = Date.now();
            const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
            const posts = (Array.isArray(postState.posts) ? postState.posts : []).filter((p) => p && now - Number(p.at || 0) < 7 * 86400000);
            const todayCount = posts.filter((p) => Number(p.at || 0) >= dayStart.getTime()).length;
            const lastAt = posts.reduce((m, p) => Math.max(m, Number(p.at || 0)), 0);
            if (todayCount >= maxPerDay) { sendJson({ ok: false, error: `今天已经发过 ${todayCount} 条说说，上限 ${maxPerDay} 条` }, 429); return; }
            if (lastAt && now - lastAt < minIntervalMs) {
              sendJson({ ok: false, error: `距离上一条说说才 ${Math.round((now - lastAt) / 60000)} 分钟，至少间隔 ${Math.round(minIntervalMs / 60000)} 分钟` }, 429);
              return;
            }
            const data = await qzoneCall('send_qzone_msg', {
              content,
              ...(uploadImages.length ? { images: uploadImages } : {}),
              ...(Number.isFinite(Number(body.ugcRight)) ? { ugc_right: Number(body.ugcRight) } : {})
            }, 120000);
            const tid = String(data?.tid ?? data?.unikey ?? '').trim();
            posts.push({ tid, at: now, content: content.slice(0, 200), images: images.length });
            try { fs.writeFileSync(postStatePath, JSON.stringify({ posts }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 }); } catch (error) { log(`[qzone] 写状态失败：${error?.message ?? error}`); }
            log(`[qzone] 发表说说 成功 tid=${tid || '-'} 字数=${content.length} 图=${uploadImages.length}`);
            sendJson({ ok: true, action: 'post', tid, contentLength: content.length, images: uploadImages.length, todayCount: todayCount + 1, maxPerDay, raw: data });
            return;
          } catch (error) {
            log(`[qzone] ${action} 失败：${error?.message ?? error}`);
            sendJson({ ok: false, action, error: String(error?.message ?? error) }, 502);
            return;
          }
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'reserved2') {
            sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          try {
            const st = getSocialV2State(key);
            const now = Date.now();
            const __lim = resolveSendLimitsV2(key, sendCfg);
            const maxPerMinute = __lim.maxPerMinute;
            const maxPerHour = __lim.maxPerHour;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限。⚠️ 不要在本轮重试这条内容——重试只会继续失败；先 qq_wait_for_messages 等下一批消息，或直接结束本轮，等下次唤醒再说。' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGapsV2(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessagesV2(key, messages, delays);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            // MARKER: burst-turn-budget —— 分条发送同样要记 turn-budget，且按实际条数记
            if (sentMessages.length > 0) noteTurnBudgetSend(key, state.sessions[key], sentMessages.length);
            log(`[reserved2] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [reserved2] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 二代不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.socialV2?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-msg
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSocialV2State(key);
          const now = Date.now();
          const __lim = resolveSendLimitsV2(key, sendCfg);
          const maxPerMinute = __lim.maxPerMinute;
          const maxPerHour = __lim.maxPerHour;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限。⚠️ 不要在本轮重试这条内容——重试只会继续失败；先 qq_wait_for_messages 等下一批消息，或直接结束本轮，等下次唤醒再说。' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTargetV2(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSocialV2State();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessagesV2(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessagesV2(key, sentMessages);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSocialV2State();
            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) noteTurnBudgetSend(key, state.sessions[key], sentMessages.length);
            appendActivity(`${key} [reserved2] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheckV2(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessagesV2(key, error.sent);
              log(`[reserved2] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const failedCount = Math.max(0, messages.length - sentCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送拍一拍必须携带 agent token' }, 403); return; }
          if (!agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-poke
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!v2ToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (socialV2.paused) { sendJson({ ok: false, error: '二代 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSocialV2State(key);
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          const __lim = resolveSendLimitsV2(key, sendCfg);
          const maxPerMinute = __lim.maxPerMinute;
          const maxPerHour = __lim.maxPerHour;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限。⚠️ 不要在本轮重试这条内容——重试只会继续失败；先 qq_wait_for_messages 等下一批消息，或直接结束本轮，等下次唤醒再说。' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          try {
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            log(`[reserved2] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [reserved2] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[reserved2] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

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

            // ── 日记本：日记与配图的专门存档处（不进聊天）──
            // MARKER: diary-book
            // 页面本身也在控制台这一侧（同一台机器、同一个令牌），不走外网。
            if (req.method === 'GET' && (url.pathname === '/diary' || url.pathname === '/diary.html')) {
              res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
              try {
                res.end(fs.readFileSync(path.join(ROOT, 'public', 'diary.html'), 'utf8'));
              } catch {
                res.end('日记本页面缺失：qq-bridge/public/diary.html');
              }
              return;
            }
            // MARKER: history-recall-route —— 「上周你说过的那个」得找得回来。
            if (url.pathname === '/api/socialV2/recall') {
              try {
                const q = url.searchParams;
                const result = recallArchive({
                  text: String(q.get('text') ?? '').trim(),
                  who: String(q.get('who') ?? '').trim(),
                  days: q.get('days'),
                  key: String(q.get('key') ?? '').trim(),
                  excludeSelf: q.get('excludeSelf') === '1'
                });
                sendJson(result);
              } catch (error) {
                sendJson({ ok: false, error: `回忆失败：${error?.message ?? error}` }, 500);
              }
              return;
            }
            if (req.method === 'GET' && url.pathname === '/api/socialV2/diary/book') {
              const DIARY_BOOK_FILE = path.join(ROOT, 'diary', DIARY_JSONL);
              const DIARY_ART_ROOT = path.join(ROOT, 'diary', 'art');
              let entries = [];
              try { entries = readDiary(DIARY_BOOK_FILE); } catch (error) { sendJson({ ok: false, error: '日记读不出来：' + (error?.message ?? error) }, 500); return; }
              const month = String(url.searchParams.get('month') ?? '').trim();
              const limit = Number(url.searchParams.get('limit') ?? 200) || 200;
              const items = bookItems(entries, {
                month,
                limit,
                artExists: (rel) => {
                  const full = resolveArtFile(DIARY_ART_ROOT, rel);
                  return Boolean(full && fs.existsSync(full));
                }
              });
              sendJson({ ok: true, month, summary: bookSummary(entries), months: bookMonths(entries), items });
              return;
            }
            if (req.method === 'GET' && url.pathname.startsWith('/api/socialV2/diary/art/')) {
              const DIARY_ART_ROOT = path.join(ROOT, 'diary', 'art');
              let rel = '';
              try { rel = decodeURIComponent(url.pathname.slice('/api/socialV2/diary/art/'.length)); }
              catch { sendJson({ ok: false, error: '图片名解码失败' }, 400); return; }
              const full = resolveArtFile(DIARY_ART_ROOT, rel);
              if (!full) { sendJson({ ok: false, error: '配图路径不合法' }, 400); return; }
              let buf;
              try { buf = fs.readFileSync(full); } catch { sendJson({ ok: false, error: '配图不存在' }, 404); return; }
              res.writeHead(200, {
                'content-type': 'image/png',
                'content-length': String(buf.length),
                'cache-control': 'private, max-age=86400',
                'X-Content-Type-Options': 'nosniff'
              });
              res.end(buf);
              return;
            }

        if ((req.method === 'GET' || req.method === 'POST') && (url.pathname === '/api/socialV2/diary' || url.pathname === '/api/socialV2/album')) {
          const isDiary = url.pathname.endsWith('/diary');
          // MARKER: diary-jsonl
          // 新日记写 jsonl；旧的 日记.md 保留为只读（迁移/回看用）。
          const DIARY_FILE = path.join(ROOT, 'diary', DIARY_JSONL);
          const DIARY_LEGACY = path.join(ROOT, 'diary', DIARY_LEGACY_MD);
          const ALBUM_DIR = path.join(ROOT, 'album');
          // MARKER: diary-jsonl
          // 上限放宽：jsonl 比 Markdown 紧凑，2MB / 2000 条够她写很久。
          const LIM = {
            diary: { maxPerMinute: 3, maxPerHour: 20, maxBytes: DIARY_MAX_BYTES, maxEntries: DIARY_MAX_ENTRIES, maxChar: DIARY_MAX_TEXT },
            album: { maxPerMinute: 3, maxPerHour: 20, maxEntries: 800 }
          };
          // 读失败就切只读，避免把「读不动」当「空日记」写回去（与 slang/sticker 同一教训）。
          if (typeof globalThis.__diaryWritable !== 'boolean') globalThis.__diaryWritable = true;
          // MARKER: diary-jsonl
          let diaryWritable = globalThis.__diaryWritable !== false;
          const scopeTimes = (globalThis.__diaryAlbumTimes ??= new Map());
          const scopeCheck = (scope) => {
            const lim = LIM[scope];
            const now = Date.now();
            const bucket = (scopeTimes.get(scope) ?? []).filter((t) => now - t < 3600000);
            const inMin = bucket.filter((t) => now - t < 60000).length;
            if (lim.maxPerMinute > 0 && inMin + 1 > lim.maxPerMinute) throw new Error('操作过于频繁（每分钟最多 ' + lim.maxPerMinute + ' 次）');
            if (lim.maxPerHour > 0 && bucket.length + 1 > lim.maxPerHour) throw new Error('操作过于频繁（每小时最多 ' + lim.maxPerHour + ' 次）');
            bucket.push(now);
            scopeTimes.set(scope, bucket);
          };
          try {
            const q = url.searchParams;
            const body = req.method === 'POST' ? await readBody() : {};
            const key = String(body.key ?? q.get('key') ?? '').trim();
            // ⚠️ agent token 只从 x-agent-token 头读：GET 的 query `token` 是**控制台令牌**，
            // 两个名字撞在一起会让控制台鉴权层拿 agent token 去校验 → 401。
            const agentToken = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
            const toolFlag = isDiary ? 'diary' : 'album';
            if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
            if (!agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
            if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
            if (!v2ToolEnabled(toolFlag)) { sendJson({ ok: false, error: '工具未启用：' + (isDiary ? 'qq_diary' : 'qq_album') }, 403); return; }

            // ── 读 ──
            if (req.method === 'GET') {
              if (isDiary) {
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
                // MARKER: diary-recall
                // 两个视图：最近 N 条照给（刚发生的事本来就该记得）；
                // 「还值得想起来的」按档位+时间算权重挑 ——
                // 普通条目过了几天权重掉到门槛以下就不在这里出现了，这就是「几天就忘」。
                // 数据一条都没删，翻全部还在文件里。
                const recalled = recallDiary(entries, { now: Date.now(), recent: limit, faded: 4 });
                const stats = diaryStats(entries);
                const gap = daysSinceLast(entries, Date.now());
                sendJson({
                  ok: true,
                  key,
                  total: entries.length,
                  // 给模型看的是可读的行，不是原始 JSON —— 她不需要解析字段名
                  recent: recalled.recent.map(fmtDiaryLine),
                  // 更早的、还够分量的（可能包含 critical 的旧条目）
                  faded: recalled.faded.map(fmtDiaryLine),
                  entries: recalled.recent,
                  days: diaryDays(entries).slice(-20),
                  stats,
                  hint: entries.length ? undefined : '日记还是空的，你可以写第一条',
                  levelHint: '写的时候可以标 level：critical（非常重要，永不淡）/ important（重要，两三周慢慢淡）/ 不标就是普通（几天就淡了）。'
                });
              } else {
                const limit = Math.max(1, Math.min(200, Number(q.get('limit')) || 20));
                let items = [];
                try {
                  items = fs.readdirSync(ALBUM_DIR)
                    .filter((f) => /\.(webp|png|jpg|jpeg|gif)$/i.test(f))
                    .map((f) => {
                      const full = path.join(ALBUM_DIR, f);
                      const st = fs.statSync(full);
                      let note = '';
                      try { note = fs.readFileSync(full.replace(/\.[^.]+$/, '.txt'), 'utf8').trim().slice(0, 100); } catch {}
                      return { file: f, bytes: st.size, at: st.mtimeMs, note };
                    })
                    .sort((a, c) => c.at - a.at);
                } catch { items = []; }
                sendJson({ ok: true, key, total: items.length, items: items.slice(0, limit), hint: items.length ? undefined : '相册还是空的，看到想留的图可以存进来' });
              }
              return;
            }

            // ── 写：日记（jsonl）──
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
              // MARKER: diary-level
              // 分档（normal / important / critical）：只决定「多久以后想不起来」，不决定能不能写。
              // 非法值不许报错 —— 归一到 normal，别因为标注写错把整条日记弄丢。
              const levelRaw = body.level !== undefined && body.level !== null && String(body.level).trim() !== ''
                ? normalizeLevel(body.level)
                : undefined;
              // MARKER: diary-level
              // 只改档（mode=replace 且只带 level）也是合法操作 —— 原来这里要求 text/mood 至少一个，
              // 结果「把这条提成 critical」被当成空内容挡掉。
              // append 模式只给 level 仍然会被 appendDiaryEntry 拒（那里才是真正的空内容校验）。
              if (!text && !moodRaw && levelRaw === undefined) { sendJson({ ok: false, error: '日记内容不能为空' }, 400); return; }
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
                  mood: moodRaw !== undefined ? moodRaw : undefined,
                  level: levelRaw
                });
                if (!r) { sendJson({ ok: false, error: '找不到要改写的那条日记' }, 404); return; }
                const bytes = writeDiary(DIARY_FILE, entries);
                if (bytes > DIARY_MAX_BYTES) { sendJson({ ok: false, error: '日记文件已达上限' }, 400); return; }
                sendJson({
                  ok: true, key, mode: 'replace', changed: r.changed,
                  level: normalizeLevel(r.entry.level),
                  line: `[${r.entry.time}]${fmtLevelTag(r.entry.level)}${r.entry.mood ? `（${r.entry.mood}）` : ''} ${r.entry.text}`,
                  total: entries.length
                });
                return;
              }

              let entry;
              try {
                entry = appendDiaryEntry(entries, { text, mood: moodRaw, level: levelRaw });
              } catch (error) {
                sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
                return;
              }
              const bytes = writeDiary(DIARY_FILE, entries);
              if (bytes > DIARY_MAX_BYTES) { sendJson({ ok: false, error: '日记文件已达上限' }, 400); return; }
              log(`[日记] ${key} 写了一条（共 ${entries.length} 条）`);
              // MARKER: diary-art-trigger
              try { queueDiaryArt(key, entry, { artPrompt: body.artPrompt }); } catch (error) { log(`[日记配图] 排队失败：${error?.message ?? error}`); }
              sendJson({
                ok: true, key, mode: 'append',
                level: normalizeLevel(entry.level),
                line: `[${entry.time}]${fmtLevelTag(entry.level)}${entry.mood ? `（${entry.mood}）` : ''} ${entry.text}`,
                entry,
                total: entries.length
              });
              return;
            }

            // ── 写：相册（只收消息里的图）──
            const messageId = String(body.messageId ?? '').trim();
            if (!messageId) { sendJson({ ok: false, error: '缺少 messageId（要存的那张消息图）' }, 400); return; }
            const note = truncateText(redactKnownTokensOnly(String(body.note ?? '')).trim(), 100);
            if (note && SENSITIVE_RE.test(note)) { sendJson({ ok: false, error: '说明疑似含敏感信息，已拒绝' }, 400); return; }
            const media = findMessageMedia(key, messageId);
            if (!media.length) { sendJson({ ok: false, error: '这条消息里没有可保存的图片/表情' }, 404); return; }
            const picked = media.find((mm) => mm && mm.kind !== 'face') || media[0];
            const fetchedArr = await fetchMediaData([picked]);
            const img = (fetchedArr || []).find((x) => x && x.kind === 'image' && x.data);
            const bytes = img ? Buffer.from(String(img.data), 'base64') : null;
            if (!bytes?.length) { sendJson({ ok: false, error: '图片获取失败' }, 502); return; }
            const hash = crypto.createHash('md5').update(bytes).digest('hex');
            const mt = String(img.mimeType || 'image/webp');
            const ext = mt === 'image/png' ? 'png' : (mt === 'image/gif' ? 'gif' : (mt === 'image/jpeg' ? 'jpg' : 'webp'));
            const target = path.join(ALBUM_DIR, hash + '.' + ext);
            const rel = path.relative(ALBUM_DIR, target);
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { sendJson({ ok: false, error: '文件名非法' }, 400); return; }
            const existed = fs.existsSync(target);
            if (!existed) {
              let cnt = 0;
              try { cnt = fs.readdirSync(ALBUM_DIR).filter((f) => /\.(webp|png|jpg|jpeg|gif)$/i.test(f)).length; } catch {}
              if (cnt >= LIM.album.maxEntries) { sendJson({ ok: false, error: '相册张数已达上限（' + LIM.album.maxEntries + '）' }, 400); return; }
              scopeCheck('album');
              fs.mkdirSync(ALBUM_DIR, { recursive: true });
              fs.writeFileSync(target, bytes);
              if (note) fs.writeFileSync(path.join(ALBUM_DIR, hash + '.txt'), note + '\n', 'utf8');
            }
            sendJson({ ok: true, key, file: path.basename(target), existed, bytes: bytes.length, note });
            return;
          } catch (error) {
            sendJson({ ok: false, error: '操作失败：' + (error?.message ?? error) }, 400);
            return;
          }
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!v2ToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          // 放在 try 外面：块内的 let 出了 try 就看不见（wantVoiceRef 给 sendVoiceForV2，
          // ttsMeta 给下面的回包），踩过两次同样的坑。
          let wantVoiceRef = '';
          let ttsMeta = null;
          try {
            // 只给 text 就现场合成（TTS）；给了 voice/file 就走语音库，两者互斥。
            wantVoiceRef = body.voice ?? body.file ?? '';
            if (!wantVoiceRef && typeof body.text === 'string' && body.text.trim()) {
              const made = await ttsSpeakV2(body.text, {});
              if (!made.ok) { sendJson({ ok: false, error: made.error }, 400); return; }
              wantVoiceRef = made.file;
              ttsMeta = { text: made.text, characters: made.characters, truncated: made.truncated, segments: made.totalSegments };
              if (body.dryRun === true) {
                // 顺序要紧：先探测，再删 —— 反过来会对着一个已经删掉的文件 inspect。
                const probe2 = await inspectAudio(made.absPath, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds }).catch(() => null);
                try { fs.unlinkSync(made.absPath); } catch {}
                sendJson({ ok: true, dryRun: true, key, tts: ttsMeta, detail: probe2 ? describeAudio(probe2) : null, probeOk: probe2?.ok === true });
                return;
              }
            }
            if (!wantVoiceRef) { sendJson({ ok: false, error: '缺少音频：给 voice（语音库文件名）或 text（现场合成）' }, 400); return; }
            resolved = resolveVoicePathForV2(wantVoiceRef);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForV2(key, wantVoiceRef, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings,
              ...(ttsMeta ? { tts: ttsMeta } : {})
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          if (req.headers['x-agent-token'] && !agentTokenOkOrOwnerDelegate(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }  // MARKER: image-approval-ep-sticker
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSocialV2State(key);
            const resolved = await resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.socialV2?.send ?? {};
          const now = Date.now();
          try {
            const st = getSocialV2State(key);
            const __lim = resolveSendLimitsV2(key, sendCfg);
            const maxPerMinute = __lim.maxPerMinute;
            const maxPerHour = __lim.maxPerHour;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限。⚠️ 不要在本轮重试这条内容——重试只会继续失败；先 qq_wait_for_messages 等下一批消息，或直接结束本轮，等下次唤醒再说。' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendStickerV2(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到二代会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSocialV2State();
            scheduleReplyCheckV2(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            noteTurnBudgetSend(key, state.sessions[key]);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSocialV2State(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSocialV2State(key);
          const collectCfg = cfg.socialV2?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectStickerV2(key, messageRef, remark);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSocialV2State();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2SessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !v2ToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (socialV2.paused) {
            const st = getSocialV2State(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: readThroughSeqV2(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.socialV2?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSocialV2State(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          if (activeWaits.has(key) && Date.now() - activeWaits.get(key) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          activeWaits.set(key, Date.now());
          const finishWait = () => activeWaits.delete(key);
          req.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMsV2(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheckV2(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (v2ToolEnabled('getUnread') || v2ToolEnabled('getRecent')) ? readThroughSeqV2(st) : requestSeq;
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (socialV2.conversations.get(canonicalV2Key(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !v2SessionAllowed(key) || !v2ToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 90000);
          const preSleepRemainingMs = preSleepWaitBlockedV2(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlockedV2 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSocialV2State();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(v2ToolEnabled('getUnread') ? st.unread : []),
              ...(v2ToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessagesV2(st, newMessages) : readThroughSeqV2(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!v2SessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!v2ToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/socialV2/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }

        // MARKER: share-signal-route
        // 主动报告（MCP qq_share_signal / qq_set_report_policy 走这里）。
        //   action=signal  角色在群里判断「这事值得跟主人说」→ 写一条待报信号
        //   action=policy  查/改策略（只能往更保守的方向调，硬上限由 store 夹住）
        //   action=stats   看当前节流状态，便于自查为什么没发出去
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      log(`本地控制台已启动：http://127.0.0.1:${port}`);
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }
  // MARKER: modules-ctx-pending
  // pending 是 `const Map`，只增删不整体重新赋值 → 直接交引用是安全的。
  // 必须插在声明**之后**：它在 main() 里是 TDZ 变量，插在前面会触发
  // 「Cannot access 'pending' before initialization」整进程起不来（已踩过）。
  Object.assign(moduleCtx, { pending });

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (const part of parts) {
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于一代 reserved 的自动转发文本；二代 reserved2 不走这里，二代必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  // images：本地图片绝对路径数组。为空时行为与旧版完全一致（只发文本）。
  // 存在的理由见 /api/socialV2/image 的 generate 分支 —— 生图工具只回路径，必须由这里发出去。
  // MARKER: onebot-http-action
  // WS action 的 HTTP 兜底。为什么需要：WS 重连窗口里 bot.request 必抛
  // 「SnowLuma WebSocket closed before opening」，而同一个网关的 HTTP 口一直可用
  // （onebotSend / fetch_ptt_text 早就这么走了）。实测 fetch_custom_face_detail
  // 33 次同步里 16 次失败（约 48%），全是 WS closed —— 表现就是"收藏表情时有时无"。
  async function onebotHttpAction(action, params = {}) {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${httpUrl}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      throw new Error(`OneBot HTTP ${action} 连接失败: ${error?.message ?? error}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      throw new Error(`OneBot HTTP ${action} 失败: ${body.wording || body.retcode || res.status}`);
    }
    return body.data;
  }

  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null, images = []) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    if (rawMessage.trim()) {
      segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    }
    // 图片段：只接受生图目录里的文件，避免这条通道被 prompt injection 用来读任意本地文件。
    const imageRoot = path.join(STATE_DIR, 'images') + path.sep;
    for (const file of images) {
      const abs = path.resolve(String(file));
      if (!abs.startsWith(imageRoot)) {
        throw new Error(`只允许发送生图目录里的图片：${abs}`);
      }
      const buf = fs.readFileSync(abs);
      if (!buf.length) throw new Error(`图片是空的：${abs}`);
      if (buf.length > MAX_MEDIA_BYTES) {
        throw new Error(`图片太大（${Math.round(buf.length / 1024)}KB > ${Math.round(MAX_MEDIA_BYTES / 1024)}KB）`);
      }
      segments.push({ type: 'image', data: { file: 'base64://' + buf.toString('base64') } });
    }
    if (!segments.length) throw new Error('消息不能为空');
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const retcode = Number(body.retcode);
      // 群聊 result=120 多半是禁言：查实之后抛一个能看懂的错误，并把这个群静音到期。
      if (kind === 'group' && retcode === 120) {
        const mutedUntil = await probeGroupMute(id);
        if (mutedUntil > 0) {
          mutedUntilByGroup.set(String(id), mutedUntil);
          const until = new Date(mutedUntil).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
          log(`[mute-aware] ${kind}:${id} 被禁言，到 ${until} 解禁，期间不唤醒`);
          throw new Error(`这个群正在禁言你，到 ${until} 解禁；禁言期间发不出去，不用重试`);
        }
      }
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供一代自动内联与二代按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  const MAX_MEDIA_COUNT = 5; // 单条消息最多内联/返回的图片/表情数
  const MAX_MEDIA_BYTES = 4 * 1024 * 1024; // 单条消息图片总字节上限（与 safeFetchBuffer 默认一致）
  const MAX_MEDIA_PIXELS = 64_000_000; // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // ── 喂给模型的那一份：体积与动图形态归一化 ──────────────────────────────
  //
  // MARKER: model-media-normalize —— 2026-10-27 从 v0.2.1-r1 回补
  //
  // 为什么必须在这里动手（而不是"让 DSH 自己处理"）：
  //   ① DSH 的 MCP 图片入口用正则校验 base64，实测量级 ≥4,474,880 字符
  //      （原始字节 ≥3.20 MiB）必抛 RangeError: Maximum call stack size exceeded，
  //      工具结果被降级成 `[image unavailable: … Maximum call stack size exceeded …]`
  //      —— 模型只看到一行看不懂的英文错误。
  //      而下面的 MAX_MEDIA_BYTES 是**抓取**上限（4 MiB），故意留着不动：
  //      得先把大图抓下来，才有机会压小它。
  //   ② DSH 对 image/gif 一律归一化成单帧，模型永远只看第一帧，且不知道那是动图。
  //      动图在桥接侧抽帧拼图后，信息量反而更高（实测 4.83MB/200 帧 → 92KB/269ms）。
  //
  // 上限默认值见 media-normalize.js 的 MEDIA_DEFAULTS；config.json 的 socialV2.media 可覆盖。
  // ⚠️ 只用于**喂模型**的出口。collectStickerV2 走 fetchOneBotImage 的原始字节，不能经过这里，
  //    否则收藏下来的表情会变成拼图/降采样版本。
  const modelMediaLimits = (() => {
    const m = cfg.socialV2?.media ?? {};
    return {
      enabled: m.normalize !== false,
      maxModelBytes: m.maxModelBytes,
      maxLongEdge: m.maxLongEdge,
      gifFrames: m.gifFrames,
      gifTile: m.gifTile,
      timeoutMs: m.normalizeTimeoutMs,
      ffmpegPath: process.env.FFMPEG_PATH || cfg.socialV2?.voice?.ffmpegPath || null
    };
  })();

  /**
   * 把一张已抓到的图片整理成模型可安全消费的形态。
   * @returns {Promise<{ok:boolean, buffer?:Buffer, mimeType?:string, note?:string, error?:string}>}
   *          ok=false 表示"压不到可用体积"——调用方必须把它变成一句可读的失败原因，
   *          绝不发注定被 DSH 丢掉的字节（那样模型只会看到看不懂的英文错误）。
   */
  async function toModelMedia(buffer, mimeType, label = '图片') {
    const out = await normalizeImageForModel(buffer, mimeType, { ...modelMediaLimits, label });
    if (!out.ok) {
      log(`[media] ${label} 不提供：${out.error}`);
      return out;
    }
    if (out.note) log(`[media] ${label}: ${out.note}`);
    return out;
  }

  /** 是不是有效图片 + 像素不超上限。统一出口，别再每处各写一遍。
   *  必须留在 main() 内部：它依赖 getImageDimensions / mimeFromBuffer /
   *  MAX_MEDIA_PIXELS，这三个都定义在本作用域里。放到顶层就会 ReferenceError，
   *  而调用处的 try/catch 会把它变成「表情永远取不到字节」。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  // 视频 → 几张拼图。取字节走 safeFetchBuffer（和图片同一条出站口径），
  // 绝不把消息里的 URL 直接喂给 ffmpeg 的 -i —— 那等于开一个任意 URL 读取口。
  const MAX_VIDEO_BYTES = 48 * 1024 * 1024;
  async function fetchVideoTiles(media) {
    // 视频段的字段在不同网关上不一致：有的给 url，有的只给 file（可能是
    // http 地址，也可能是 SnowLuma 落在本机的绝对路径）。三种都试一遍，
    // 都不行才报错 —— 群里视频本来就少，遇到一条读不了等于白等一天。
    const url = String(media?.url ?? '').trim();
    const fileField = String(media?.file ?? '').trim();
    const httpUrl = /^https?:\/\//i.test(url) ? url
      : (/^https?:\/\//i.test(fileField) ? fileField : '');
    const localPath = (!httpUrl && fileField.startsWith('/')) ? fileField : '';
    if (!httpUrl && !localPath) {
      const seen = JSON.stringify({ url, file: fileField }).slice(0, 300);
      return { ok: false, error: `视频段没有可用的 url 或本地路径（${seen}）` };
    }
    let tmpDir = null;
    try {
      let buf;
      if (httpUrl) {
        // 视频不是图片，safeFetchBuffer 会在返回前做图片签名校验把这里拦死，
        // 所以用同防护口径、不做类型校验的 safeFetchRaw。
        const fetched = await safeFetchRaw(httpUrl, MAX_VIDEO_BYTES);
        buf = fetched?.buffer;
      } else {
        // 同机路径：先看大小，别把一个几百 MB 的文件整个读进这台 1.7GB 的机器
        const st = await fs.promises.stat(localPath).catch(() => null);
        if (!st?.isFile()) return { ok: false, error: '视频文件不存在' };
        if (st.size > MAX_VIDEO_BYTES) {
          return { ok: false, error: `视频太大（${Math.round(st.size / 1048576)}MB）` };
        }
        buf = await fs.promises.readFile(localPath);
      }
      if (!buf?.length) return { ok: false, error: '拿到空文件' };
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qqvid-'));
      const tmpFile = path.join(tmpDir, 'v.bin');
      await fs.promises.writeFile(tmpFile, buf);
      const out = await normalizeVideoForModel(tmpFile, {
        ffmpegPath: process.env.FFMPEG_PATH || cfg.socialV2?.media?.ffmpegPath || null,
        ffprobePath: process.env.FFPROBE_PATH || cfg.socialV2?.media?.ffprobePath || null,
        tmpDir
      });
      return out;
    } catch (error) {
      return { ok: false, error: `视频处理异常：${error?.message ?? error}` };
    } finally {
      if (tmpDir) {
        try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }
  }

  async function fetchOneBotImage(media) {
    // MARKER: sticker-cdn-first
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    // 普通图片反过来：先 get_image（本地缓存最快），失败再抓 URL。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || media.kind === 'mface' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    const failures = [];
    const urls = [];
    const pushUrl = (raw) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || urls.includes(s)) return;
      urls.push(s);
    };
    pushUrl(media.url);
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate);

    const tryUrls = async () => {
      for (const url of urls) {
        try {
          const fetched = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(url) };
          failures.push(`${url} 不是有效图片`);
        } catch (error) {
          failures.push(`${url}: ${error?.message ?? error}`);
        }
      }
      return null;
    };

    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker' || media.kind === 'mface')) return null;
      if (!media.file || !isProbablySafeImageFileRef(media.file)) return null;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
          } else {
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
          } catch (error) {
            failures.push(`get_image url: ${error?.message ?? error}`);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
          }
        }
      } catch (error) {
        failures.push(`get_image: ${error?.message ?? error}`);
      }
      return null;
    };

    // 注意：这里返回的是**原始字节**，归一化由调用方 toModelMedia 做。
    // collectStickerV2 直接调本函数 → 收藏下来的表情必须是原图，不能被降采样/拼图。
    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${failures.slice(0, 3).join(' | ')}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return { buffer: fetched.buffer, mimeType: mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
            }
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : `[表情#${media.faceId}]` };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: `[表情#${media.faceId}]` };
  }

  async function resolveMediaList(mediaList) {
    // MARKER: media-diag
    // 「图到底到没到」是排查「她说没看见」的第一现场。以前日志里看不出这件事，
    // 只能靠猜。现在每条带媒体的消息都会留下一行段类型，一眼可判。
    try {
      const kinds = (Array.isArray(mediaList) ? mediaList : []).map((m) => String(m?.kind ?? '?'));
      if (kinds.length > 0) {
        const stickerNames = (Array.isArray(mediaList) ? mediaList : [])
          .filter((m) => m?.kind === 'mface' || m?.kind === 'sticker')
          .map((m) => String(m.summary ?? '').slice(0, 20) || '(无名)');
        log(`[media] 收到 ${kinds.length} 个媒体：${kinds.join(',')}`
          + (stickerNames.length ? `（表情包名：${stickerNames.join(' / ')}）` : ''));
      }
    } catch (error) {
      log(`[media] 诊断日志异常（已忽略）：${error?.message ?? error}`);
    }
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += prep.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `face-${media.faceId}.${(prep.mimeType || 'png').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          // 压不到可用体积：明确说明原因，别让模型对着「获取失败」瞎猜。
          parts.push({ type: 'text', text: `[表情${index}（${prep.error}）]` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        // 表情包的 summary 已经是「[表情包:名字]」格式，先剥壳再用，别套成双层。
        // kind 现在统一叫 'sticker'，老的 'mface' 也一并认（有历史消息/存档里的旧值）。
        const isSticker = media.kind === 'sticker' || media.kind === 'mface';
        const rawSummary = String(media.summary ?? '')
          .replace(/^\[表情包[:：]?/, '')
          .replace(/\]$/, '')
          .trim();
        const label = isSticker
          ? (rawSummary ? `[表情包:${rawSummary}]` : '[表情包]')
          : `[图片${index}]`;
        const img = await fetchOneBotImage(media);
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, label) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          parts.push({ type: 'text', text: label });
          if (prep.note) parts.push({ type: 'text', text: `（${prep.note}）` });
          parts.push({ type: 'image', mediaType: prep.mimeType, data: prep.buffer.toString('base64'), name: `qq-image-${index}.${(prep.mimeType || 'image/jpeg').split('/')[1]}` });
        } else if (prep && !prep.ok) {
          parts.push({ type: 'text', text: `${label}（${prep.error}）` });
        } else {
          parts.push({ type: 'text', text: `${label}（图片取不到，只看到名字）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' || media?.kind === 'mface' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        const prep = face.buffer ? await toModelMedia(face.buffer, face.mimeType, `表情#${media.faceId ?? index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: [face.text || '', prep.note ? `（${prep.note}）` : ''].filter(Boolean).join(' ')
          });
        } else if (prep && !prep.ok) {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: `（获取失败：${prep.error}）` });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else if (media.kind === 'video') {
        // 视频不走「一项一张图」：抽帧拼图出来是 N 张，各自带序号，
        // 下游 transcribeMediaImages 会逐张代看，模型拿到的是一串有时序的画面。
        const vid = await fetchVideoTiles(media);
        if (!vid.ok) {
          out.push({ index, kind: 'video', text: `（视频读不了：${vid.error}）` });
          continue;
        }
        const beforeBytes = totalBytes;
        for (const tile of vid.tiles) {
          if (totalBytes + tile.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'video', text: `（${tile.label} 超总大小上限，已跳过）` });
            continue;
          }
          totalBytes += tile.buffer.length;
          out.push({
            index,
            kind: 'image',
            mimeType: tile.mimeType,
            data: tile.buffer.toString('base64'),
            text: `${tile.label}（${tile.rangeText}）`
          });
        }
        log(`[video] ${vid.frameCount} 帧 → ${vid.tiles.length} 张拼图，${Math.round((totalBytes - beforeBytes) / 1024)}KB`);
      } else {
        // MARKER: sticker-fields-out
        // 表情包必须把 kind/emojiId/summary/subType 一并交出去：
        // 只给 data 的话，MCP 侧（qq_get_message_images）与日志都分不清
        // 「这是群友发的梗图表情」还是「一张普通照片」，也就没法告诉模型那张图叫什么。
        const kind = (media.kind === 'sticker' || media.kind === 'mface') ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        const img = await fetchOneBotImage(media);
        const prep = img?.buffer ? await toModelMedia(img.buffer, img.mimeType, `${noun}${index}`) : null;
        if (prep?.ok) {
          if (totalBytes + prep.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += prep.buffer.length;
          out.push({
            ...base,
            mimeType: prep.mimeType,
            data: prep.buffer.toString('base64'),
            text: prep.note ? `（${prep.note}）` : ''
          });
        } else if (prep && !prep.ok) {
          out.push({ ...base, text: `（${noun}获取失败：${prep.error}）` });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'reserved2') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 二代：消息对象上直接带 media（仅在确实存在二代会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'reserved2' || socialV2.conversations.has(key)) {
      try {
        const st = getSocialV2State(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 一代/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGapV2(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGapsV2(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGapV2(gaps[i], sendCfg));
      } else {
        const g = clampGapV2(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGapV2(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGapV2(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  function sendMessagesV2(key, messages, delays, replyToMessageId, atUserId = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否真的发出。
  async function auditAndSend(key, text) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text);
    return true;
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  // MARKER: session-corrupt-detect —— 2026-10-27
  // 实测事故：group:906710082 的 DSH 会话文件损坏（39MB，SessionFormatError:
  // turn/end crosses an open compaction）。ensureChatModel 只认 not-found 是终态，
  // corrupt 被判成 'failed' 后原样返回旧会话 → 每 3 秒重试同一个坏会话，永远失败，
  // 每失败一次就往管理员私聊推一条「消息未被接受」，今天刷了 86 条。
  // 会话日志一旦损坏，DSH 侧不可能自愈，只能退役重建。
  function sessionLogCorrupt(message) {
    const m = String(message ?? '');
    if (!m) return false;
    return /is corrupt|stored log is corrupt|SessionFormatError|turn\/end crosses an open compaction/i.test(m);
  }

  async function ensureChatModel(sessionId) {
    if (modelAppliedSessions.get(sessionId) === modelSelectionEpoch) return 'applied';
    const provider = String(cfg.dsh?.provider || 'deepseek-official');
    const model = String(cfg.dsh?.model || 'deepseek-flash');
    const effort = String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT);
    let lastError = null;
    // 档位降级：某些模型（同一 provider 下也可能）不认当前 reasoningEffort，
    // DSH 会报 does not support reasoning effort 直接拒绝 selectModel。
    // 这种错误重试同一个档位没有意义，第二轮干脆不带 reasoningEffort，让 DSH 用模型自己的默认档。
    let effortArg = effort;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const params = { sessionId, provider, model };
        if (effortArg) params.reasoningEffort = effortArg;
        const result = unwrap(await api.sessions.selectModel(params), 'session.selectModel');
        modelAppliedSessions.set(sessionId, modelSelectionEpoch);
        log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'})${effortArg ? '' : '（已放弃指定档位，改用模型默认）'}`);
        return 'applied';
      } catch (error) {
        lastError = error;
        const why = String(error?.message ?? error);
        log(`设置会话模型失败 ${sessionId}（第 ${attempt}/2 次）: ${why}`);
        if (attempt < 2) {
          if (/does not support reasoning effort/i.test(why) && effortArg) {
            effortArg = '';
            log(`模型 ${provider}/${model} 不支持档位 ${effort}，改为由 DSH 选默认档重试`);
          } else {
            await sleep(1000);
          }
        }
      }
    }
    const message = String(lastError?.message ?? lastError ?? '');
    if (/not[- ]?found/i.test(message)) {
      // 终态失败：记下 epoch，避免退役前（或退役失败时）被反复重试刷屏。
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    if (sessionLogCorrupt(message)) {
      // 会话日志损坏同样是终态：DSH 读不出这个会话，重试一万次也不会好。
      log(`会话 ${sessionId} 的日志已损坏（SessionFormatError），按会话失效处理：${message.slice(0, 200)}`);
      modelAppliedSessions.set(sessionId, modelSelectionEpoch);
      return 'not-found';
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing);
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在或已损坏，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / reserved2，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'reserved2' ? (cfg.socialV2?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node scripts/setup-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await api.workspace.archiveSession({ sessionId }); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId);
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek';
  // MARKER: mute-aware
  // QQ 侧的 retcode 本身没有语义，群聊 result=120 最常见的成因就是「禁言中」。
  // 与其让她一次次打字、发送、被打回，不如真去查一次群成员信息把答案坐实：
  // 拿到 shut_up_timestamp 就把这个群静音到期，期间 evaluateWakeTriggerV2 直接
  // 返回 null（不唤醒），到期自动恢复。重启会清空这张表，最多多失败一次。
  const mutedUntilByGroup = new Map();

  async function probeGroupMute(groupId) {
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_group_member_info`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ group_id: Number(groupId), user_id: Number(selfUserId), no_cache: true }),
        signal: AbortSignal.timeout(8000)
      });
      const body = await res.json().catch(() => ({}));
      const ts = Number(body?.data?.shut_up_timestamp) || 0;
      return ts * 1000 > Date.now() ? ts * 1000 : 0;
    } catch {
      return 0;
    }
  }
  // MARKER: mute-aware-end // 机器人昵称（启动时从网关获取，识别"被提到"用）
  // MARKER: self-user-id
  // 自己的 QQ 号。用于「不主动打扰自己」—— 幽灵会话 private:<自己> 会排上主动档期。
  let selfUserId = '';
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 二代仿真模式（reserved2）运行时状态与唤醒配置 ────────────────────────
  const socialV2 = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个二代 AI 活动（停止唤醒/等待）
  };

  // 一代/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 二代模式则直接存在 socialV2 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 二代会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIdsV2(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // MARKER: probability-cap
  // probability 是「每条消息」的随机命中率，不是「每小时次数」。群里一小时上百条消息时，
  // 0.05 的期望就是每小时多醒 5 次 —— 这正是「一天醒上百次」的主要来源。
  // 上限只对群聊收紧：私聊在 evaluateWakeTriggerV2 第一行就 `return 'private'`，
  // 本来就每条消息都唤醒，probability 对私聊无实际作用，留个宽松上限只为防脏值。
  function clampWakeProbabilityV2(key, wakeConfig) {
    if (!wakeConfig || !wakeConfig.triggers) return false;
    const isGroup = String(key ?? '').startsWith('group:');
    const raw = Number(wakeConfig.triggers.probability);
    if (!Number.isFinite(raw) || raw < 0) return false;
    const capRaw = Number(isGroup
      ? (cfg.socialV2?.wake?.maxProbabilityInGroup ?? 0.01)
      : (cfg.socialV2?.wake?.maxProbabilityPrivate ?? 0.1));
    const cap = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : (isGroup ? 0.01 : 0.1);
    if (raw <= cap) return false;
    wakeConfig.triggers.probability = cap;
    return true;
  }

  function defaultWakeConfigV2() {
    const w = cfg.socialV2?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: Array.isArray(w.recommendedKeywords) ? w.recommendedKeywords.map(String) : [],
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfigV2(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfigV2();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigsV2() {
    let changed = false;
    for (const st of socialV2.conversations.values()) {
      if (refreshDefaultWakeConfigV2(st)) changed = true;
    }
    if (changed) saveSocialV2State();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEndV2(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfigV2(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlockedV2(st) {
    if (!st) return false;
    const w = cfg.socialV2?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEndV2(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 90000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafetyV2(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIdsV2(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeableV2(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIdsV2(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfigV2();
      if (!opts.skipSave) saveSocialV2State();
      if (key) setupSleepTimerV2(key);
      log(`[reserved2] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  // ── 日程 / 画像的存取（带「读失败就不写」保护）──────────────────────────
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

  let moodStoreWritable = true;

  function moodStore() {
    try {
      const s = readMood(MOOD_FILE_PATH);
      moodStoreWritable = true;
      return s;
    } catch (error) {
      moodStoreWritable = false;
      log(`⚠️ 情绪库读取失败，本次操作只读不写：${error?.message ?? error}`);
      throw new Error(`情绪库读取失败：${error?.message ?? error}`);
    }
  }

  function saveMoodSafe(store, label) {
    if (!moodStoreWritable) throw new Error(`${label}库当前为只读（读取失败过），拒绝写入以免覆盖`);
    try {
      writeMood(MOOD_FILE_PATH, store);
    } catch (error) {
      log(`保存${label}失败:`, error?.message ?? error);
      throw error;
    }
  }

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
    // 二代消息存在 socialV2 会话里（见本文件 socialV2 定义处注释），
    // social.recentMessages 只有一代才写。这里两个都看，否则群里恒判为「主人没说话」。
    const v2state = socialV2.conversations.get(key);
    const recent = (Array.isArray(v2state?.recentMessages) && v2state.recentMessages.length)
      ? v2state.recentMessages
      : (social.recentMessages.get(key) ?? []);
    // MARKER: image-owner-window —— 原来是硬编码 120 秒。实测她一轮要跑 1~10 分钟，
    // 「主人 @ 了我」这条事实在两分钟后自动失效，于是她画不出来还查不到原因。
    // 现在按配置走，默认 10 分钟。
    const cutoff = Date.now() - (Number(cfg.socialV2?.image?.ownerSpokeMs) || 600000);
    const ownerSpoke = recent.some((m) => m && m.isOwner && Number(m.time ?? 0) >= cutoff);
    const r = String(reason || '');
    let byMention = r === 'atMention' || r === 'nameMention' || r === 'question';
    // 后台提醒（notify-ai）投递时不带 wakeReason，会把上下文 reason 覆盖成空串，
    // 于是紧跟着的真唤醒判不出 byMention。这里兜一层：主人三分钟内在群里说过话，
    // 就当作是被叫了（冒充挡不住 isOwner，冒充者也改不了 QQ 号）。
    if (!byMention) {
      const limit = Date.now() - (Number(cfg.socialV2?.image?.ownerSpokeMs) || 600000);
      byMention = recent.some((m) => m && m.isOwner && Number(m.time ?? 0) >= limit);
    }
    return ownerSpoke && byMention ? 'owner-group' : null;
  }

  /**
   * 路由侧的硬闸门：场景要对，且请求必须来自「正在进行的那个回合」。
   *
   * 「回合还活着吗」由回合结束时的主动清空来回答（见事件循环里 collector
   * 判定 ended 的分支）—— 那一轮收工，额度立刻收回。下面的时间判据只是兜底：
   * 万一 turn/end 事件丢了，别让闸门永远开着。
   */
  // MARKER: per-key-turn-context —— 「当前回合」必须按会话分开存。
  // 旧版只有一个 globalThis.__qqTurnContext 槽，注释里假设「本来同一时刻只有一个回合在跑」。
  // 线上早就不是了：群 906710082 / 群 201188739 / 好几个私聊同时在跑，后开始的回合把先开始的
  // 那个顶掉，于是先那个会话调生图工具就被判成「这个会话不是当前正在进行的那个」。
  // 2026-10-27 15:46:52 实测：管理员私聊额度已授予（日志有「授予额度」），随后静默拒绝
  // —— 那条分支连日志都不打，线上一点痕迹都没有，主人「又试了两回」就是两回同一句。
  // 现在 active / ended 都按 key 存 Map；globalThis 那对旧槽继续写，只为不打断别的读法。
  function turnCtxMap(name) {
    if (!(globalThis[name] instanceof Map)) globalThis[name] = new Map();
    return globalThis[name];
  }
  function activeTurnCtx(key) {
    return turnCtxMap('__qqTurnContexts').get(String(key)) || null;
  }
  function endedTurnCtx(key) {
    return turnCtxMap('__qqTurnContextEnds').get(String(key)) || null;
  }
  function setActiveTurnCtx(ctx) {
    const m = turnCtxMap('__qqTurnContexts');
    m.set(String(ctx.key), ctx);
    // 只留最近 80 个：回合结束会删自己的，这里是防某个 key 的 end 事件丢了导致无界增长。
    if (m.size > 80) {
      for (const k of [...m.keys()]) {
        if (m.size <= 80) break;
        if (k !== String(ctx.key)) m.delete(k);
      }
    }
    globalThis.__qqTurnContext = ctx;
  }
  function endActiveTurnCtx(key) {
    const k = String(key);
    const mine = activeTurnCtx(k);
    if (!mine) return false;
    turnCtxMap('__qqTurnContextEnds').set(k, { key, reason: String(mine.reason || ''), at: Date.now() });
    turnCtxMap('__qqTurnContexts').delete(k);
    if (globalThis.__qqTurnContext && String(globalThis.__qqTurnContext.key) === k) globalThis.__qqTurnContext = null;
    return true;
  }

  function imageAllowedNow(key) {
    let ctx = activeTurnCtx(key);
    if (!ctx) {
      // 回合刚结束的宽限：同一个会话、90 秒内，还允许画。
      // 安全不靠这里，靠下面的 imageSceneFor（主人真的 @ 过才成立）。
      const ended = endedTurnCtx(key);
      const graceMs = Number(cfg.socialV2?.image?.turnGraceMs) || 90000;
      const fresh = ended && String(ended.key) === String(key) && Date.now() - Number(ended.at || 0) <= graceMs;
      if (!fresh) {
        // MARKER: image-grace-group
        // 群聊：主人在 120 秒内真的 @ 过她，就允许画（imageSceneFor 会再判一次，
        // 冒名改昵称过不了 isOwner）。理由：生图要 36~50 秒，她常常是
        // 「先回一句我去画，下一轮才调工具」，那时回合早已收工、宽限也过期了。
        // 私聊不放宽：私聊里主人随时能说话，没有「错过就永远画不了」的问题。
        // put-through: 把回合真实的 reason 传下去，否则 atMention 永远判不出来（原来传的是空串）。
        if (String(key).startsWith('group:') && imageSceneFor(key, String(ended.reason || ''))) {
          log(`[image] 群聊放行（${key}，回合已结束，但主人 120 秒内 @ 过）`);
          return { ok: true, scene: 'owner-group' };
        }
        log(`[image] 拒绝 ${key}：没有回合上下文`);
        return { ok: false, why: '当前没有进行中的对话' };
      }
      ctx = { key, reason: String(ended.reason || ''), at: Number(ended.at || 0), grace: true };
      log(`[image] 宽限放行（${key}，回合结束后 ${Math.round((Date.now() - Number(ended.at || 0)) / 1000)}s）`);
    }
    const turnWindowMs = Number(cfg.socialV2?.image?.turnWindowMs) || 600000;
    if (!ctx.grace && Date.now() - Number(ctx.at || 0) > turnWindowMs) {
      return { ok: false, why: '这一轮对话过去太久了，先跟主人说句话再画' };
    }
    if (String(ctx.key) !== String(key)) {
      // per-key 之后这里理论上不会命中；留着当兜底，但必须留痕 ——
      // 线上那次静默拒绝就是因为这条分支不打日志，主人试几回都只有同一句话，无从查起。
      log(`[image] 拒绝 ${key}：回合上下文属于 ${ctx.key}（不是这个会话）`);
      return { ok: false, why: '这个会话不是当前正在进行的那个' };
    }
    const scene = imageSceneFor(key, String(ctx.reason || ''));
    if (!scene) {
      return { ok: false, why: '只有主人私聊、或主人在群里 @ 你/叫你名字时才能画' };
    }
    return { ok: true, scene };
  }

  // MARKER: prompt-surrogate-repair
  // 发出去的每一段文本都先修一遍孤立代理。
  // 触发过的线上错误：`request contains an unpaired Unicode surrogate; repair text encoding and retry`
  // （2026-10-29 00:31~00:33，group:906710082 连续三条）。上游直接拒，她那一轮等于白跑。
  // 收口放在这里而不是逐个 slice 打补丁：截断点有几十处，漏一个就再炸一次。
  (() => {
    const original = api.sessions.prompt.bind(api.sessions);
    const fixValue = (value) => {
      if (typeof value === 'string') return repairSurrogates(value);
      if (Array.isArray(value)) return value.map(fixValue);
      if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = fixValue(v);
        return out;
      }
      return value;
    };
    api.sessions.prompt = (args) => {
      let fixed = args;
      try {
        fixed = fixValue(args);
        // 判据用「序列化字符串不等」而不是「长度不等」：把 \ud83d 换成 \uFFFD
        // 长度一模一样，按长度判就永远打不出日志（2026-10-29 之前就是这样，grep 到 0 次）。
        if (JSON.stringify(fixed) !== JSON.stringify(args)) {
          log('[prompt] 修掉了文本里的孤立代理码元（半个 emoji）');
        }
      } catch { /* 修不动就原样发 */ }
      return original(fixed);
    };
  })();

  /**
   * 真去画。同步落一份本地副本 —— 上游给的 url 是别人站点的，过期就没了，
   * 她要回看或者转发都得有自己的原件。
   */
  // MARKER: image-retry-once
  // 为什么要有这一层：上游（凌风AI 中转）偶尔在 30~40 秒把连接掐掉，undici 在读 body 时
  // 抛出来的错误 message 就只有一个词 `terminated` —— 2026-10-28 18:19 那次正好卡在 38 秒，
  // 她只能对主人说「画失败了：terminated」。生图没有副作用（每次都是新画一张），
  // 对这种纯网络层断连重试一次，比让她去解释「terminated 是什么」划算得多。
  // 反过来：4xx/5xx、超时、上游返回非 JSON、上游没给图片 —— 一律不重试，重试只会再错一次还多烧钱。
  const IMAGE_RETRYABLE_RE = /terminated|ECONNRESET|socket hang up|other side closed|UND_ERR|fetch failed|EPIPE|ETIMEDOUT|STALLED|ImageStreamStall/i;
  function describeImageError(error) {
    const name = error?.name || 'Error';
    const msg = String(error?.message || error);
    const code = error?.cause?.code || error?.code || '';
    return code ? `${msg}（${name}/${code}）` : `${msg}（${name}）`;
  }
  async function generateImageWithRetry(args) {
    try {
      return await generateImageNow(args);
    } catch (error) {
      const first = describeImageError(error);
      if (!IMAGE_RETRYABLE_RE.test(first)) throw new Error(first);
      log(`[image] 上游连接被掐断，3 秒后重试一次：${first}`);
      await new Promise((resolve) => { const t = setTimeout(resolve, 3000); t.unref?.(); });
      try {
        const result = await generateImageNow(args);
        log('[image] 重试成功');
        return result;
      } catch (error2) {
        throw new Error(`${describeImageError(error2)}（已重试一次）`);
      }
    }
  }
  // MARKER: image-registry（2026-10-28）
// 异步生图之后，工具只回 jobId —— 她拿不到路径，也就没法把刚画好的图拿去配说说或再转发
// （线上实证：18:24 画完一张，18:25 配说说时只能翻出 10-26 的旧图）。
// 所以每画成一张就在这里记一笔，配合 /api/socialV2/image 的 action:"recent" 还给她。
const GENERATED_IMAGES_FILE = path.join(STATE_DIR, 'generated-images.json');
const GENERATED_IMAGES_KEEP = 50;

function readGeneratedImages() {
  try {
    const raw = fs.readFileSync(GENERATED_IMAGES_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.items) ? data.items.filter((x) => x && typeof x.path === 'string') : [];
  } catch {
    return [];
  }
}

function recordGeneratedImage(entry) {
  const item = {
    path: String(entry?.path ?? ''),
    file: path.basename(String(entry?.path ?? '')),
    prompt: String(entry?.prompt ?? '').slice(0, 200),
    size: String(entry?.size ?? ''),
    key: String(entry?.key ?? ''),
    at: Number(entry?.at) > 0 ? Number(entry.at) : Date.now(),
    kind: String(entry?.kind ?? 'generate'),
    scene: String(entry?.scene ?? ''),
    desc: String(entry?.desc ?? '').slice(0, 400),
    day: localDayOf(Number(entry?.at) > 0 ? Number(entry.at) : Date.now())
  };
  if (!item.path) return null;
  const items = [item, ...readGeneratedImages().filter((x) => x.path !== item.path)].slice(0, GENERATED_IMAGES_KEEP);
  try {
    atomicWriteJson(GENERATED_IMAGES_FILE, { items });
  } catch (error) {
    log(`[image] 写生图登记失败：${error?.message ?? error}`);
  }
  return item;
}

function recentGeneratedImages(limit = 5) {
  const n = Math.min(20, Math.max(1, Number(limit) || 5));
  return readGeneratedImages().slice(0, n);
}

// MARKER: diary-art
// 日记配图：写完一条就顺手画一张手绘插画，画完写回 jsonl 并发到聊天里。
// 异步、绝不阻塞写日记那条响应：画一张要 30~90 秒，等她回话就太慢了。
const DIARY_ART_FILE = path.join(ROOT, 'diary', DIARY_JSONL);
const DIARY_ART_DIR = path.join(ROOT, 'diary', 'art');
const diaryArtInflight = new Map();

function diaryTargetFromKey(key) {
  const s = String(key ?? '');
  const at = s.indexOf(':');
  if (at <= 0) return null;
  const kind = s.slice(0, at);
  const id = Number(s.slice(at + 1));
  if (!Number.isFinite(id) || id <= 0) return null;
  return { kind, id };
}

function queueDiaryArt(key, entry, { artPrompt = '' } = {}) {
  const c = artCfg(cfg);
  if (!c.enabled) return false;
  if (!entry || !entry.id) return false;
  if (diaryArtInflight.has(entry.id)) return false;
  let used = 0;
  try { used = countArtInDay(readDiary(DIARY_ART_FILE), entry.day || ''); } catch {}
  if (!artAllowed({ entriesToday: used, cfg })) {
    log(`[日记配图] 今天已经 ${used} 张（上限 ${c.maxPerDay}），这次不画`);
    return false;
  }
  const prompt = buildArtPrompt({
    artPrompt: String(artPrompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    text: entry.text,
    mood: entry.mood,
    style: c.style,
    character: c.character,
    maxChars: c.maxPromptChars
  });
  diaryArtInflight.set(entry.id, Date.now());
  log(`[日记配图] 开始画 ${entry.id}（提示词 ${prompt.length} 字）`);
  void (async () => {
    try {
      const result = await generateImageNow({ prompt, size: c.size });
      fs.mkdirSync(DIARY_ART_DIR, { recursive: true });
      const dest = path.join(DIARY_ART_DIR, artFileName(entry));
      fs.copyFileSync(result.path, dest);
      const art = {
        file: path.relative(path.join(ROOT, 'diary'), dest),
        prompt,
        style: c.style,
        source: 'diary',
        at: Date.now()
      };
      const fresh = readDiary(DIARY_ART_FILE);
      if (setDiaryArt(fresh, { id: entry.id, art })) {
        writeDiary(DIARY_ART_FILE, fresh);
        log(`[日记配图] 完成 ${entry.id} -> ${art.file}`);
      }
      const target = diaryTargetFromKey(key);
      if (target && shouldSendArt(c.sendToChat, key)) {
        await onebotSend(target.kind, target.id, '', null, null, [dest]);
        log(`[日记配图] 已发到 ${key}`);
      }
    } catch (error) {
      log(`[日记配图] 画失败 ${entry.id}：${error?.message ?? error}`);
    } finally {
      diaryArtInflight.delete(entry.id);
    }
  })();
  return true;
}

  // MARKER: selfie-runtime
  // 自拍/合照：走 /images/edits（multipart 带参考图）。
  // 2026-10-28 探针：这条中转的 edits 口吃参考图，换场景后人物身份保得住；
  // 纯文字生图每次都是另一个人，所以自拍必须有参考图。
  function selfieRefPath() {
    const img = cfg.socialV2?.image || {};
    const configured = String(img.refSelf ?? '').trim();
    if (configured) {
      const abs = path.isAbsolute(configured) ? configured : path.join(STATE_DIR, configured);
      try { if (fs.statSync(abs).isFile()) return abs; } catch {}
    }
    // 没有指定就退而求其次：最新的日记插画（那张就是她自己的样子），再不行用最新生图。
    const pick = (dir) => {
      try {
        const names = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n)).map((n) => path.join(dir, n));
        names.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
        return names[0] ?? '';
      } catch { return ''; }
    };
    try {
      const artRoot = path.join(ROOT, 'diary', 'art');
      const months = fs.readdirSync(artRoot).sort().reverse();
      for (const m of months) {
        const got = pick(path.join(artRoot, m));
        if (got) return got;
      }
    } catch {}
    return pick(path.join(STATE_DIR, 'images'));
  }
  function selfieCountToday() {
    try {
      const list = typeof readGeneratedImages === 'function' ? readGeneratedImages() : [];
      const day = localDayOf(Date.now());
      return list.filter((x) => x && x.kind === 'selfie' && String(x.day ?? '') === day).length;
    } catch {
      return 0;
    }
  }
  async function generateImageWithRef({ prompt, refPath, size }) {
    const imageCfg = cfg.socialV2?.image ?? {};
    const baseUrl = String(imageCfg.baseUrl || 'https://ai.windking.shop/v1').replace(/\/+$/, '');
    const model = String(imageCfg.model || 'gpt-image-2');
    const apiKey = String(imageCfg.apiKey || '');
    const budget = Math.max(30000, Number(imageCfg.timeoutMs) || 180000);
    if (!refPath) throw new Error('自拍缺少参考图');
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    if (size) form.append('size', size);
    form.append('image', new Blob([fs.readFileSync(refPath)], { type: 'image/png' }), path.basename(refPath));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), budget);
    try {
      const resp = await fetch(`${baseUrl}/images/edits`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: ac.signal,
      });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`上游 ${resp.status}：${raw.slice(0, 300)}`);
      let payload = null;
      try { payload = JSON.parse(raw); } catch { throw new Error(`上游返回的不是 JSON：${raw.slice(0, 120)}`); }
      const item = (Array.isArray(payload?.data) ? payload.data[0] : null) || {};
      const dir = path.join(STATE_DIR, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const outPath = path.join(dir, `img-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      if (item.b64_json) {
        fs.writeFileSync(outPath, Buffer.from(String(item.b64_json), 'base64'));
      } else if (item.url) {
        const img = await fetch(String(item.url), { signal: ac.signal });
        if (!img.ok) throw new Error(`图下载失败：上游 ${img.status}`);
        fs.writeFileSync(outPath, Buffer.from(await img.arrayBuffer()));
      } else {
        throw new Error('上游没给图');
      }
      log(`[selfie] 出图 ${path.basename(outPath)}（参考图 ${path.basename(refPath)}，${model}）`);
      return { url: String(item.url || ''), path: outPath, model, size: size || imageCfg.size || '1024x1024' };
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`上游 ${Math.round(budget / 1000)} 秒没画完`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

async function generateImageNow({ prompt, size }) {
    const imageCfg = cfg.socialV2?.image ?? {};
    const baseUrl = String(imageCfg.baseUrl || 'https://ai.windking.shop/v1').replace(/\/+$/, '');
    const model = String(imageCfg.model || 'gpt-image-2');
    const wantSize = String(size || imageCfg.size || '1024x1024');
    const apiKey = String(imageCfg.apiKey || '');
    if (!apiKey) throw new Error('没有配置生图 apiKey（cfg.socialV2.image.apiKey）');
    // MARKER: image-stream
    // 默认走流式；配 false 就回到「一次吐完」的老路（万一哪天中转把 SSE 改坏了）。
    const streamOn = imageCfg.stream !== false;
    const ctrl = new AbortController();
    const budget = Math.max(30000, Number(imageCfg.timeoutMs) || 180000);
    const timer = setTimeout(() => ctrl.abort(), budget);
    timer.unref?.();
    let resp;
    try {
      resp = await fetch(`${baseUrl}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(streamOn ? { model, prompt, n: 1, size: wantSize, stream: true } : { model, prompt, n: 1, size: wantSize }),
        signal: ctrl.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`上游 ${Math.round(budget / 1000)} 秒没画完`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      const raw = await resp.text().catch(() => '');
      throw new Error(`上游 ${resp.status}：${raw.slice(0, 300)}`);
    }
    let item = null;
    if (streamOn) {
      const stream = await readImageStream(resp.body, {
        stallLogMs: Number(imageCfg.stallLogMs) > 0 ? Number(imageCfg.stallLogMs) : 15000,
        stallAbortMs: Number(imageCfg.stallAbortMs) > 0 ? Number(imageCfg.stallAbortMs) : 0,
        abort: () => ctrl.abort(),
        onStall: (ms) => log(`[image] 上游 ${Math.round(ms / 1000)} 秒没吐字节，还在等…`),
        onProgress: (text, ms) => log(`[image] 上游进度（${Math.round(ms / 1000)} 秒）：${String(text || '').slice(0, 40)}`)
      });
      item = { b64_json: stream.b64, url: stream.url, revised_prompt: '' };
      log(`[image] 流式读取完成：${stream.chunks} 块 / ${Math.round(stream.bytes / 1024)}KB / ${Math.round(stream.elapsedMs / 1000)} 秒`);
    } else {
      const raw = await resp.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new Error('上游返回的不是 JSON');
      }
      item = Array.isArray(payload?.data) ? payload.data[0] : null;
    }
    if (!item || (!item.b64_json && !item.url)) throw new Error('上游没有返回图片');
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

  function getSocialV2State(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalV2Key(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = socialV2.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfigV2(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        exemptWakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        // 与 load 保持一致：0 = 从未刷新过（不是「刚刚刷新过」）
        lastImpressionRefreshAt: 0,
        lastImpressionNudgeAt: 0,
        pendingWakeReasons: [],
        proactiveNextAt: 0
      };
      rememberAgentToken(key, st.agentToken);
      socialV2.conversations.set(key, st);
      // 新会话的默认概率来自 recommendedProbability，同样要过封顶（新群的群聊上限）。
      clampWakeProbabilityV2(key, st.wakeConfig);
      scheduleProactiveCheckV2(key);
      setupSleepTimerV2(key);
    }
    return st;
  }

  function loadSocialV2State() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeableV2
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SOCIAL_V2_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SOCIAL_V2_FILE, null);
      socialV2.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfigV2();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              triggers: { ...defaultWc.triggers, ...((val.wakeConfig?.triggers) ?? {}) }
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            exemptWakeTimes: Array.isArray(val.exemptWakeTimes) ? val.exemptWakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            // 印象维护计时。**默认给 0 = 「从未刷新过」**，不是「现在」。
            // 旧逻辑给 Date.now() 是想避免每轮唠叨，但副作用是「从未刷新」和
            // 「刚刷新过」变得不可区分 ⇒ 7 天提醒**永远**不会来（实测就是这个结果）。
            // 真正的防唠叨由 lastImpressionNudgeAt 的冷却负责，不该靠伪造刷新时间。
            lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : 0,
            // 「记印象」驱动的冷却计时；缺省 0 表示从未念过（允许首次提醒）。
            lastImpressionNudgeAt: Number(val.lastImpressionNudgeAt) > 0 ? Number(val.lastImpressionNudgeAt) : 0,
            // 结算冷却的锚点。只写内存不落盘 ⇒ 每次重启冷却清零、每个会话都白结一次。
            lastSettleAt: Number(val.lastSettleAt) > 0 ? Number(val.lastSettleAt) : 0,
            // 繁忙暂存队列：重启后仍要补发（过期项由巡检清掉）
            pendingWakeReasons: Array.isArray(val.pendingWakeReasons)
              ? val.pendingWakeReasons
                .filter((r) => r && typeof r === 'object' && typeof r.reason === 'string')
                .map((r) => ({ reason: r.reason, seq: Number(r.seq) || 0, at: Number(r.at) || 0, pr: Number(r.pr) > 0 ? Number(r.pr) : 0 }))
                .slice(-20)
              : [],
            // 主动检查的下一次档期（ms 时间戳）：重启后按剩余时间续上，而不是重新抽随机
            proactiveNextAt: Number(val.proactiveNextAt) > 0 ? Number(val.proactiveNextAt) : 0
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIdsV2(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfigV2(st);
          // 旧状态文件里可能存着超限概率（0.6 / 0.15 / 0.1 …），加载时就收敛掉，防复活。
          clampWakeProbabilityV2(key, st.wakeConfig);
          rememberAgentToken(key, st.agentToken);
          socialV2.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeableV2(st, { skipSave: true, key });
          // 加载期不要在循环里落盘（会把还没加载完的会话写成空），交给加载末尾统一写
          scheduleProactiveCheckV2(key, { skipSave: true });
        }
        // 加载阶段统一落盘一次，避免 ensureWakeableV2 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SOCIAL_V2_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/social-v2.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSocialV2State();
        }
      }
    } catch (error) {
      log('读取 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function saveSocialV2State() {
    try {
      const obj = { paused: socialV2.paused, conversations: Object.create(null) };
      for (const [key, st] of socialV2.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          exemptWakeTimes: Array.isArray(st.exemptWakeTimes) ? st.exemptWakeTimes.slice(-200) : [],
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          // MARKER: fix2bugs
          // 印象维护的两个计时字段必须落盘，否则每次重启都丢：
          //   lastImpressionRefreshAt 丢了 ⇒ 「7 天提醒重写印象」永远不来
          //   lastImpressionNudgeAt   丢了 ⇒ 「记印象」驱动的 12 小时冷却永远失效
          // 这是交接文档待办 #7「印象只增不减」的根因（此前只在 load 里读到过）。
          lastImpressionRefreshAt: Number(st.lastImpressionRefreshAt) || 0,
          lastImpressionNudgeAt: Number(st.lastImpressionNudgeAt) || 0,
          lastSettleAt: Number(st.lastSettleAt) || 0,
          // MARKER: item56
          // 繁忙暂存队列与主动档期也必须落盘：桥接一天要重启好几次，
          // 只存内存等于「每次重启都把还没补发的 @ 和已经等过的主动档期清空」。
          pendingWakeReasons: Array.isArray(st.pendingWakeReasons)
            ? st.pendingWakeReasons.filter((r) => r && typeof r === 'object').slice(-20)
            : [],
          proactiveNextAt: Number(st.proactiveNextAt) || 0,
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SOCIAL_V2_FILE, obj);
    } catch (error) {
      log('保存 socialV2 状态失败:', error?.message ?? error);
    }
  }

  function formatParticipationV2(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMsV2(st) {
    const defaultMs = Number(cfg.socialV2?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  function formatMemoryV2(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    // MARKER: impression-inject-recent
    // 按「最近重写过」取 10 人。以前取 Object.keys 的尾部（插入顺序），
    // 人一多，早记下的人永远轮不到，等于慢慢失忆。
    const names = Object.keys(impressions)
      .map((n) => ({ n, t: Number(impressions[n]?.refreshedAt) || Number(impressions[n]?.lastSeenAt) || 0 }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 10)
      .map((x) => x.n);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemoryV2(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'memberImpression') {
      applyMemberImpression(st, String(extra.target || ''), text);
    }
    saveSocialV2State();
  }

  loadSocialV2State();

  // MARKER: busy-queue-sweep
  // 兜底巡检：上面所有出队都依赖「某个 turn 正常结束」，而重启 / 会话被替换 /
  // 回合异常都可能让暂存的 @ 永远等不到那个时机（实测五条 private 全卡死）。
  // 每 30s 扫一遍，忙的跳过，不忙的直接补发。
  setInterval(sweepPendingWakeReasons, 30_000).unref?.();

  // MARKER: slang-backfill-timer —— 2026-10-26
  // 回填曾经只挂在「提取之后」：群里有新消息 → 提取 → 才顺带扫一次。
  // 实测提取冷却 5 分钟、实际约 10 分钟一轮，一轮 3 条 ⇒ 18 条/小时。
  // 1923 条要 4.5 天，用户报「太慢」。现在独立成定时器，不依赖群里有消息。
  // 每 4 分钟扫一轮、每轮最多 10 条 ⇒ 约 150 条/小时，13 小时跑完。
  // 三道闸都保留：dshReady / slang.enabled / slangResearchBlockedUntil 退避。
  setInterval(() => {
    try {
      if (!dshReady) return;
      if (cfg.slang?.enabled === false) return;
      if (cfg.slang?.autoResearch === false) return;
      if (slangResearchBlockedUntil > Date.now()) return;
      sweepUnresearchedSlang({ reason: '定时回填' });
    } catch (error) {
      log('黑话定时回填异常:', error?.message ?? error);
    }
  }, 4 * 60 * 1000).unref?.();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  // MARKER: directed-at-ai-strict —— 「这句话是不是在问 AI」
  //
  // 旧版只收一个字符串，完全不知道「你」指谁。中文群里「你会不会啊」「你行不行」
  // 「你说呢」是日常句式，旧正则全部命中，于是每条闲聊都能把她叫醒；末尾那条
  // /说话/ 更是裸匹配，「说话」「说话啊」任意位置出现即真。
  //
  // 新规则：只认真正指向本体的信号——
  //   A) 出现明确的 AI 称谓（含词边界的 ai / ds），且整句是疑问或挑战
  //   B) 句首「你/您」+ 疑问（短句、没点别人），才算直接问
  //   C) 「你是…吗 / 你是…还是…」这类身份式提问
  //   D) 「怎么不说话 / 回我 / 理我 / 别装死 / 在不在」这类明确对话对象缺失的追问
  //      但必须没有其他 @ 目标（由调用方 isDirectedAtOthers 兜）
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    // 词边界：ai 不会命中 rain / wait / mail；ds 不会命中 ads / bdsm
    const aiMention = /deepseek|claude|chatgpt|\bgpt\b|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|\bai\b|人工智障|机器人/.test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输/.test(lower);
    const question = /[?？吗呢]|怎么|为什么|哪|谁/.test(lower);
    // A) 有明确 AI 称谓 + 疑问或挑战 —— 这条最可靠
    if (aiMention && (question || challenge)) return true;
    // C) 身份式提问：「你是人类还是ai」「你是真人吗」
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|嘛|么|？|\?)/.test(lower)) return true;
    // B) 句首「你/您」+ 疑问，且整句够短（长句多半在跟别人聊别的事）
    if (/^[\s，,。.~～]*(你|您)/.test(lower) && /[?？吗呢嘛]|怎么|为什么/.test(lower) && lower.length <= 40) return true;
    // D) 明确的对话对象缺失式追问。这里的「说话」「人呢」单字词不再单独命中。
    if (/怎么不说话|说话啊|回我一下|你回我|理我|别装死|在不在|你人呢/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNickname && (lower.includes('@' + selfNickname) || lower.includes(selfNickname))) return true;
    for (const kw of (cfg.social?.mustReplyKeywords ?? [])) {
      if (lower.includes(String(kw).toLowerCase())) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      // MARKER: untrusted-ingest —— 群里的代码/命令只当素材，永远不进她的上下文。
      // 实测动机：群友可以直接贴一段脚本或「请帮我执行」，那是指令注入的入口；
      // 主人也明确要求「不要让鱼读群里的任何代码和指令」。
      // MARKER: untrusted-audit —— 挡下来的东西要留痕：她记不记得不要紧，出事查得到。
      text: truncateText(String(key).startsWith('group:')
        ? sanitizeGroupText(textContent, untrustedCfg(cfg), untrustedReporter(key, textContent))
        : textContent, 200),
      plain: truncateText(String(key).startsWith('group:')
        ? sanitizeGroupText(plainText ?? textContent, untrustedCfg(cfg))
        : (plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    // MARKER: sticker-sightings
    // 观测层：只把这条消息里的图片 MD5 记一笔，用来观察群里哪些图在反复出现。
    // 不碰表情库、不发消息、不改提示词；出任何错都静默吞掉，不影响业务。
    try {
      if (Array.isArray(media) && media.length) {
        // 图片消息的 text 恒为「[图片]」，拿它当上下文没有任何信息量。
        // 本条是纯图时改用上一条的文字 —— 那才是「这张图出现在什么对话里」。
        const prevLine = arr.length >= 2 ? String(arr[arr.length - 2].plain || arr[arr.length - 2].text || '') : '';
        const nowPlain = String(textContent ?? '').trim();
        const ctxText = /^\[图片\]$/.test(nowPlain) ? prevLine : nowPlain;
        recordSightings(key, media, { sender, text: /^\[图片\]$/.test(ctxText) ? '' : ctxText, messageId: messageRef ? String(messageRef) : '' });
      }
    } catch { /* 观测层永不抛 */ }
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  // MARKER: untrusted-audit-fn —— 每挡一条群里贴的代码/命令，记一行账。
  function untrustedReporter(key, rawText) {
    let reported = false;
    return (info) => {
      if (reported) return;
      reported = true;
      const hits = inspectUntrusted(rawText).join(',') || 'code';
      log(`[untrusted] ${key} 群里贴的代码/命令只当素材（${hits}，挡下 ${info?.dropped ?? '?'} 行）`);
    };
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // 「这一轮是谁在说话」——生图闸门要用（见 imageSceneFor）。
    // 按会话各存一份（多会话并发，见 per-key-turn-context）；旧的全局槽同时写，兼容别的读法。
    setActiveTurnCtx({ key, reason: String(opts.wakeReason || ''), at: Date.now() });
    turnCtxMap('__qqTurnContextEnds').delete(String(key));
    globalThis.__qqTurnContextEnded = null;
    log(`[image] 授予额度（${key}，${opts.wakeReason || '无原因'}）`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no reserved2 prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'reserved2' || socialV2.paused || cfg.socialV2?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      wakeState = getSocialV2State(key);
      wakeToken = wakeState.agentToken;
      promptText = buildWakePromptV2(key, opts.wakeReason);
      wakeSnapshot = buildWakeSnapshotV2(key, opts.wakeReason);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
      // MARKER: vision-inline
      // 唤醒回合主动把图说成文字塞进 prompt（限 maxImagesPerWake 张，默认 2）。
      // 失败绝不影响唤醒本身 —— 代看只是增强，不是主链路。
      try {
        promptText += await describeUnreadMediaInline(key);
      } catch (error) {
        log(`[vision] 唤醒内联代看异常（已忽略）：${error?.message ?? error}`);
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      // MARKER: vision-bridge-2
      // 这条路径（社交模式管理员私聊 / 主动唤醒 / 所有 deliverPrompt 调用）
      // 以前**完全没做**「不吃图就把图说成文字」的转换：直接 resolveMediaList 拿到
      // image part 就投，不吃图的主模型必然回 session/attachment-invalid
      // （does not support image input），整条消息被拒 —— 她的表现就是「根本没看见图」。
      // handleIncoming 那条路早已接上，这条路漏了，这才是实测「测了还是没有」的真因。
      const bridged2 = await transcodeImagesForTextModel(imageParts);
      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...bridged2];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      // MARKER: err-to-admin —— 投递被上游拒绝属于技术错误，只通知管理员。
      if (!opts.silent) await notifyAdminOnly('⚠️ 消息未被接受', safeErrText, key);
      return { ok: false, error: safeErrText };
    }
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && socialV2.conversations.get(canonicalV2Key(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessagesV2(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'reserved2') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + roles/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 roles/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const stateStat = fs.statSync(ROLE_STATE_FILE);
      const roleStat = fs.statSync(roleFile);
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStat.mtimeMs}:${stateStat.size}:${roleStat.mtimeMs}:${roleStat.size}`;
      if (roleHintCache.key === cacheKey) return roleHintCache.raw;
      const raw = fs.readFileSync(roleFile, 'utf8');
      roleHintCache = { key: cacheKey, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔一代〕/〔二代〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('v1');
  }

  // 二代仿真模式专用角色提示：去掉一代的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让二代 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于二代角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测二代发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    // 二代靠工具数组分条，单条消息里的中文空格是群聊里常见的停顿写法（实测群友 44% 这么打），
    // 不再是「该拆成多条」的信号。默认不再提示，免得和人格卡里的「用空格断句」互相打脸。
    if (cfg.role?.allowCjkSpaces !== false) return null;
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测二代发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentRoleHintV2() {
    // 先按 〔二代〕/〔一代〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('v2');
    if (!raw) return '';
    // 一代靠「中文空格」分条，二代靠工具数组分条，空格在二代只是普通字符。
    // 默认保留（群里本来就有人用空格断句），设 false 才回退到「改写成逗号」的老行为。
    const allowCjkSpaces = cfg.role?.allowCjkSpaces !== false;
    // 一代仿真模式专用指令整行过滤，避免污染二代工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算一代指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是二代内容、
    // 这里却把一代指令漏进二代提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的一代语义改写成二代语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, allowCjkSpaces
          ? '（示例中用空格表示停顿；要分多条请把数组写成多个元素）'
          : '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(allowCjkSpaces ? line : convertExampleSpacesToComma(line));
      } else if (!GEN1_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  // MARKER: bot-mutex —— 别的机器人发的消息不进唤醒判断。
  // 为什么需要：群里有一堆 bot（201188739 就有 5 个 is_robot=true），它们互相 @、互相接话，
  // 一旦她对着另一个 bot 说话，两个 bot 会无限对聊，烧掉的是主人的 token。
  // 数据来源：消息事件的 sender 里**没有** is_robot（实测只有 age/card/nickname/role/sex/user_id），
  // 只有 get_group_member_list 有 ⇒ 只能自己拉一份缓存，按 user_id 判。
  const groupBotIdsCache = new Map(); // groupId -> { ids: Set<string>, ts }
  const GROUP_BOT_IDS_TTL_MS = 30 * 60 * 1000;
  const groupBotIdsInflight = new Set(); // 正在拉取的群，避免并发重复请求
  function groupBotIdsOf(groupId) {
    const hit = groupBotIdsCache.get(String(groupId));
    return hit ? hit.ids : null;
  }
  function refreshGroupBotIds(groupId) {
    const gid = String(groupId ?? "");
    if (!gid) return;
    const hit = groupBotIdsCache.get(gid);
    if (hit && Date.now() - hit.ts < GROUP_BOT_IDS_TTL_MS) return;
    if (groupBotIdsInflight.has(gid)) return;
    groupBotIdsInflight.add(gid);
    Promise.resolve()
      .then(() => bot.raw("get_group_member_list", { group_id: Number(gid) }))
      .then((data) => {
        const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
        const ids = new Set();
        for (const m of list) {
          if (m && m.is_robot === true && m.user_id != null) ids.add(String(m.user_id));
        }
        groupBotIdsCache.set(gid, { ids, ts: Date.now() });
        if (ids.size) log(`[bot-mutex] ${gid} 识别到 ${ids.size} 个机器人：${[...ids].join(",")}`);
      })
      .catch((error) => {
        // MARKER: bot-ids-negative-cache —— 失败也要落一份空集合。
        // 否则 groupBotIdsCache 里永远没有这个群，每条群消息都会重新拉一次成员列表。
        // 实测 673877456 / 910502749 累计失败 30 次，全是无谓重试。
        // ts 往前拨半 TTL：相当于「半 TTL 后再试」，既不放弃，也不每条消息都打。
        groupBotIdsCache.set(gid, { ids: new Set(), ts: Date.now() - Math.floor(GROUP_BOT_IDS_TTL_MS / 2) });
        log(`[bot-mutex] 拉取 ${gid} 成员失败（半 TTL 后重试）：${error?.message ?? error}`);
      })
      .finally(() => { groupBotIdsInflight.delete(gid); });
  }
  function isKnownBot(groupId, userId) {
    if (userId == null) return false;
    const ids = groupBotIdsOf(groupId);
    return ids ? ids.has(String(userId)) : false;
  }

  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTargetV2(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 二代仿真模式（reserved2）唤醒调度 ──────────────────────────────────
  function appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = []) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const safeMedia = Array.isArray(media) ? media.map((m) => ({
      kind: m?.kind === 'face' ? 'face' : 'image',
      file: m?.file ? String(m.file) : undefined,
      url: m?.url ? String(m.url) : undefined,
      faceId: m?.faceId ? String(m.faceId) : undefined
    })).filter((m) => m.kind === 'face' ? !!m.faceId : !!(m.file || m.url)) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      // MARKER: untrusted-ingest-v2 —— v2（reserved2，线上跑的就是这条）同样只把群里的代码/命令当素材。
      // 之前只改了 v1 的 appendRecentMessage，线上走的是这里，等于没挡：
      // 主人明确要求过「不要让鱼读群里的任何代码和指令」，两处必须同时挡。
      text: truncateText(String(key).startsWith('group:')
        ? sanitizeGroupText(textContent, untrustedCfg(cfg), untrustedReporter(key, textContent))
        : textContent, 200),
      plain: truncateText(String(key).startsWith('group:')
        ? sanitizeGroupText(plainContent ?? textContent, untrustedCfg(cfg))
        : (plainContent ?? textContent), 200),
      tail: truncateTextTail(String(key).startsWith('group:')
        ? sanitizeGroupText(plainContent ?? textContent, untrustedCfg(cfg))
        : (plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      // MARKER: bot-mutex —— 这个人是机器人吗。唤醒判断会跳过它，避免两个 bot 对聊。
      // MARKER: bot-mutex —— 只在群里判机器人。key 自带 'group:'/'private:' 前缀，
      // 不依赖 kind 参数（这个函数签名里没有 kind —— 第一版误用导致「处理群消息出错: kind is not defined」，
      // 群消息被整条吞掉）。
      isBot: String(key).startsWith('group:') ? isKnownBot(key.slice(key.indexOf(':') + 1), userId) : false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // MARKER: history-archive-incoming —— 进 store 的同时落一份月度存档（异步，永不抛）。
    appendArchive(key, msg);
    // MARKER: sticker-sightings-v2 —— 观测层在这里也必须挂一份。
    // 踩过的坑：群里天天有图（vision 一条条在识别），可 state/sticker-sightings.json
    //           停在「items: []」二十多个小时不动、启动日志永远「已记录 0 张图」。
    // 原因是观测层只挂在 v1 的 appendRecentMessage 里，而线上跑的是 reserved2 ——
    // 那个分支要再往下十几行才到 appendRecentMessage，早就在中间 return 了。
    // 只记图片 MD5，不碰表情库、不发消息、不改提示词；出任何错都静默吞掉。
    try {
      if (safeMedia.length) {
        const prev = st.recentMessages.length >= 2 ? st.recentMessages[st.recentMessages.length - 2] : null;
        const nowPlain = String(textContent ?? '').trim();
        // 纯图消息的正文恒为「[图片]」，拿它当上下文没信息量，改用上一条的文字
        const ctxText = /^\[图片\]$/.test(nowPlain) ? String(prev?.plain || prev?.text || '') : nowPlain;
        recordSightings(key, safeMedia, { sender, text: /^\[图片\]$/.test(ctxText) ? '': ctxText, messageId: msg.messageId || '' });
      }
    } catch { /* 观测层永不抛 */ }
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // MARKER: fix2bugs
    // 互动计数：这个人**已经在她印象里**，才算一次互动。
    // 不新建印象——凭空给每个发言的人都记一条，那是用户画像，不是她的印象。
    try {
      const im = st.memberImpressions && st.memberImpressions[sender];
      if (im && typeof im === 'object') {
        im.interactionCount = (Number(im.interactionCount) || 0) + 1;
        im.lastSeenAt = Date.now();
      }
    } catch {}
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    saveSocialV2State();
  }

  // 二代拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSocialV2Poke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSocialV2State(key);
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.socialV2?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    // MARKER: fix2bugs
    // 互动计数：这个人**已经在她印象里**，才算一次互动。
    // 不新建印象——凭空给每个发言的人都记一条，那是用户画像，不是她的印象。
    try {
      const im = st.memberImpressions && st.memberImpressions[sender];
      if (im && typeof im === 'object') {
        im.interactionCount = (Number(im.interactionCount) || 0) + 1;
        im.lastSeenAt = Date.now();
      }
    } catch {}
    saveSocialV2State();
    return msg;
  }

  function recordSentMessagesV2(key, messages) {
    const st = getSocialV2State(key);
    const now = Date.now();
    const recentLimit = Number(cfg.socialV2?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
      // MARKER: history-archive-self —— 她自己说的话同样存档：以后想翻「我那天怎么说的」才有得翻。
      appendArchive(key, st.recentMessages[st.recentMessages.length - 1]);
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSocialV2State();
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function isDirectedAtOthers(event) {
    const selfId = String(event?.self_id ?? '');
    if (!selfId) return false;
    let hasOther = false;
    const scan = (segs, depth) => {
      if (!Array.isArray(segs) || depth > 4) return null;
      for (const seg of segs) {
        if (!seg || typeof seg !== 'object') continue;
        if (seg.type === 'at') {
          const qq = String(seg.data?.qq ?? '');
          if (qq && qq === selfId) return 'self';
          hasOther = true;
        }
        if (seg.type === 'reply') {
          const inner = seg.data?.content ?? seg.data?.message ?? null;
          if (scan(inner, depth + 1) === 'self') return 'self';
        }
        if (seg.type === 'node' || seg.type === 'forward' || Array.isArray(seg.data?.content)) {
          const inner = seg.data?.content ?? null;
          if (scan(inner, depth + 1) === 'self') return 'self';
        }
      }
      return null;
    };
    if (scan(event?.message, 0) === 'self') return false;
    return hasOther;
  }

  // MARKER: keyword-name-mask
  // 群里有人名字本身就包含她的关键词（「超大肥鱼」含「大肥鱼」、「小鲸鱼在潜水」含「小鲸鱼」），
  // 直接 includes 会把别人的日常聊天全算成叫她。这里先把「撞名的别人昵称」整段挖掉再匹配。
  // 注意只挖「包含关键词但不等于关键词」的昵称：完全同名的没法靠文本区分，留给 at 段判定。
  function maskOtherMemberNamesV2(st, lowered, kwStr) {
    if (!lowered || !kwStr) return lowered;
    let hay = lowered;
    const seen = new Set();
    for (const m of st?.recentMessages ?? []) {
      if (!m || m.isSelf) continue;
      const name = String(m.sender ?? '').trim().toLowerCase();
      if (!name || name === kwStr || seen.has(name)) continue;
      if (!name.includes(kwStr)) continue;
      seen.add(name);
      hay = hay.split(name).join('\u0000');
    }
    return hay;
  }

  // MARKER: bot-noise-filter —— 机器生成的报错模板不触发唤醒。
  // 为什么需要：群里「阿鲸♪」(2643088326) 的 agent 网关余额不足，每 60 秒往群里刷一条
  // 「⚠️ agent 处理出错：Insufficient Balance (request_id: ...)」。实测 2026-10-27 07:32~07:37
  // 六分钟刷 14 条，而 QQ 的 get_group_member_list 对它返回 is_robot=false（该群 137 个成员
  // 里一个 is_robot=true 都没有），所以 bot-mutex 那套「按机器人身份拦截」看不见它，
  // 每条报错都会把她叫醒一次、烧一次 token。
  // 这里按「机器模板特征」兜底：命中即不唤醒。只挡唤醒，不挡消息入库——
  // 她主动 qq_get_unread_messages 时照样看得到，只是不再被这些模板叫起来。
  const BOT_NOISE_LOG_MS = 5 * 60 * 1000;
  const botNoiseSeen = new Map(); // key -> { n, lastLog }
  const BOT_NOISE_DEFAULT_PATTERNS = [
    '⚠️\\s*agent\\s*处理出错',
    'Insufficient\\s+Balance',
    'request_id:\\s*[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-',
    'session/attachment-invalid',
    'gateway/(?:service-unavailable|input-invalid|version-mismatch|not-found)',
    '\\bTaskGetGroupMemberList\\b',
  ];
  function botNoisePatterns() {
    const raw = cfg.socialV2?.botNoise?.patterns;
    if (Array.isArray(raw) && raw.length) return raw.map(String).filter(Boolean);
    return BOT_NOISE_DEFAULT_PATTERNS;
  }
  function looksLikeBotNoiseV2(text) {
    if (cfg.socialV2?.botNoise?.enabled === false) return null;
    const t = String(text ?? '');
    if (!t) return null;
    for (const p of botNoisePatterns()) {
      try {
        if (new RegExp(p, 'i').test(t)) return p;
      } catch { /* 配置里的坏正则跳过，不因为一条写错就整体失效 */ }
    }
    return null;
  }

  // MARKER: mood-fade
  // 「此刻的情绪」也要会淡：两道闸从 config 读，默认 0.12 / 24 小时。
  function moodFadeCfg() {
    const m = cfg.socialV2?.mood ?? {};
    const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
    return {
      labelMinIntensity: num(m.labelMinIntensity, 0.12),
      labelMaxMs: Math.max(60000, num(m.labelMaxHours, 24) * 60 * 60 * 1000)
    };
  }

  // MARKER: willingness
  // 意愿门：她「有多想插这句话」的连续量，替代「掷一次骰子决定要不要说话」。
  //
  // 为什么加这个：唤醒判定全是布尔开关，每一条都是「命中就醒」。这套东西能表达
  // 「这句话是不是冲我来的」，但表达不了「我刚连说了三句，现在该歇会」。群里
  // 安静十分钟她一句不吭、热闹起来一句接一句地插，就是这个原因。
  //
  // 三个来源：
  //   forced  —— 明确在叫她（private / @ / 叫名字 / 拍一拍 / 提问），直通，不动分数
  //   soft    —— 软触发（关键词 / 随机概率 / 任意消息 / 指定发言人），进评分
  //   chance  —— 什么都没命中（st.wakeBlockedBy 为空），也进评分。
  //              这是新增的主动发声通道 —— 原来的 probability:0.01 等于永远不主动，
  //              现在「聊得够热」本身就能让她开口。
  //
  // 分数落在 state/willingness.json，不进 social-v2.json：那套序列化带 Set，
  // 不值得为了一个浮点数去动它。
  const WILLINGNESS_FILE = path.join(STATE_DIR, 'willingness.json');

  function willingnessCfg() {
    // 默认值挂在 socialV2.wake.willingness（跟着 wake 那套走，控制台改起来顺手），
    // 但也认 socialV2.willingness 这个更短的写法 —— 两个都读，后者优先。
    const w = { ...(cfg.socialV2?.wake?.willingness ?? {}), ...(cfg.socialV2?.willingness ?? {}) };
    // 生活节奏现算：她这会儿在书房正经干活（occupied）还是窝着（available），
    // 直接决定档位。拿不到就是空串，resolveTier 会回落默认档。
    let rhythm = '';
    try {
      rhythm = rhythmOf({
        lastIncomingAt: 0,
        now: Date.now(),
        hour: new Date().getHours(),
        attention: lifeAttentionNow(Date.now()),
        cfg: pacingCfg(cfg)
      }).level;
    } catch { /* 拿不到节奏就按默认档算，绝不让它挡住说话 */ }
    return { ...w, rhythm };
  }

  // 这一批里积了几条消息。原想用 st.batchCount，但那个字段并不存在（恒为 1），
  // 等于「一群人刷屏时她更容易开口」这层完全失效。改成现算：
  // 过去一个 batchWindowMs 内收到的非本人消息条数。
  function recentBurstCount(st) {
    const win = Math.max(1000, Number(st?.wakeConfig?.batchWindowMs) || 8000);
    const now = Date.now();
    const list = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    let n = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const t = Number(list[i]?.time) || 0;
      if (!t || now - t > win) break;
      if (!list[i]?.isSelf) n += 1;
    }
    return Math.max(1, Math.min(9, n));
  }

  function readWillingnessMap() {
    try {
      const raw = readJsonSafe(WILLINGNESS_FILE, null);
      if (raw && typeof raw === 'object' && raw.keys && typeof raw.keys === 'object') return raw;
    } catch { /* 坏文件当空地图，别因为一个分数读不出来就不说话 */ }
    return { version: 1, keys: {} };
  }

  function writeWillingnessMap(map) {
    try {
      // 只留最近 60 个会话，防止私聊越开越多把文件撑大
      const entries = Object.entries(map.keys || {});
      if (entries.length > 60) {
        entries.sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0));
        map.keys = Object.fromEntries(entries.slice(0, 60));
      }
      atomicWriteJson(WILLINGNESS_FILE, map);
    } catch (error) {
      log(`[willingness] 分数落盘失败：${error?.message ?? error}`);
    }
  }

  function willingnessStateOf(key) {
    const map = readWillingnessMap();
    const st = map.keys[key];
    return st && Number.isFinite(Number(st.score))
      ? { score: Number(st.score), updatedAt: Number(st.updatedAt) || 0, skipCount: Math.max(0, Math.floor(Number(st.skipCount) || 0)), consumedReplyAt: Number(st.consumedReplyAt) || 0 }
      : { score: 0, updatedAt: 0, skipCount: 0, consumedReplyAt: 0 };
  }

  function saveWillingnessState(key, state) {
    const map = readWillingnessMap();
    map.version = 1;
    map.keys = map.keys || {};
    map.keys[key] = state;
    writeWillingnessMap(map);
  }

  // 她「刚说完话就该歇会」这条，靠 lastAiReplyAt 判断。
  // 用惰性消费而不是挂在发送点上：发送路径有五处（文本/表情/工具/收尾…），
  // 挂五处必然漏一处，而 lastAiReplyAt 是所有路径都会写的唯一信号。
  function consumeIfReplied(key, state) {
    const repliedAt = Number(getSocialV2State(key).lastAiReplyAt) || 0;
    if (!repliedAt || repliedAt <= (Number(state.consumedReplyAt) || 0)) return state;
    const next = consumeWillingness(
      { score: state.score, updatedAt: state.updatedAt, skipCount: state.skipCount },
      willingnessCfg(),
      Date.now()
    );
    return { ...next, consumedReplyAt: repliedAt };
  }

  /**
   * 过意愿门。返回最终要用的唤醒 reason（可能被挡成 null），
   * 或者原本就是 null 时给出 'willingness'（她被「聊得够热」说动了）。
   */
  function applyWillingnessV2(key, st, reason, opts = {}) {
    const wl = willingnessCfg();
    if (wl.enabled === false) return reason;
    // 私聊不设门：一对一本来就不存在「插话抢麦」，只会让她变迟钝。
    if (String(key).startsWith('private:')) return reason;

    const blocked = String(st.wakeBlockedBy || '');
    // 明确不该说的（禁言/别的机器人/机器报错/@了别人）连分都不攒。
    if (!reason && blocked) return null;
    // MARKER: wake-hold — 额度还满着就别每 8 秒重掷一次骰子，静默等抑制期过去。
    // 只拦「没人叫她自己想说」这条路；明确叫她（reason 非空）照旧交给限流层判。
    if (!reason && Number((st.wakeHold && st.wakeHold.until) || 0) > Date.now()) return null;

    let state = consumeIfReplied(key, willingnessStateOf(key));
    const decision = evaluateWillingness(state, wl, {
      now: Date.now(),
      messageCount: Math.max(1, Number(opts.messageCount) || 1),
      content: String(opts.content ?? ''),
      quotedBot: Boolean(opts.quotedBot),
      reason: reason || '',
      rhythm: wl.rhythm,
      // 软触发已经过了一道判定，给它额外一点倾向：命中说明话题确实相关，
      // 不该跟「纯路过」用同一把尺子。
      random: Math.random
    });
    // 修（2026-10-30）：evaluateWillingness 返回的 state 来自 decayWillingness，
    // 只带 score/updatedAt/skipCount/lastReplyAt，不含 consumedReplyAt。
    // 直接落盘会让 consumedReplyAt 永远是 0，于是下一轮 consumeIfReplied 又判定
    // 「她刚说过话」再扣一次 —— lastReplyAt 被刷成当前时刻，冷却永远剩满额，
    // 结果是永久静音（线上三个群 score 恒为 0、skipCount 一直抖）。
    // 这里把本次消费掉的 consumedReplyAt 显式带回去。
    state = { ...decision.state, consumedReplyAt: Number(state.consumedReplyAt) || 0 };
    saveWillingnessState(key, state);

    if (reason) {
      if (isForcedReason(reason, wl)) return reason;
      if (decision.shouldCall) return reason;
      if (wl.log !== false) log(`[willingness] ${key} 压住 ${reason}（${describeWillingness(decision)}）`);
      return null;
    }
    // 没有任何触发，但分数够了 —— 她自己想说话。
    if (decision.shouldCall) {
      log(`[willingness] ${key} 主动插话（${describeWillingness(decision)}）`);
      return 'willingness';
    }
    return null;
  }

  // MARKER: skip-jitter
  // 「刚说完话就先歇几次」的抖动闸。每条消息过一遍：
  //   1) 计数（本条算一次触发）
  //   2) 她说过新的话就重掷 target
  //   3) 只有软触发（anyMessage / keyword / speaker / probability）会被跳
  // 明确在叫她的（private / atMention / nameMention / question / poke）永远放行 ——
  // 这是 wake-priority-exempt 的教训：额度被低优先级吃光后，叫名字被丢了 8 次。
  function applySkipJitterV2(key, st, reason) {
    const pc = pacingCfg(cfg);
    if (!pc.enabled || pc.skip?.enabled === false) return reason;
    const now = Date.now();
    const d = skipDecision({ st, reason, now, hour: new Date(now).getHours(), attention: lifeAttentionNow(now), cfg: pc, random: Math.random });
    st.skipSeen = d.seen;
    st.skipTarget = d.target;
    st.skipRolledAt = d.rolledAt;
    if (d.rolled) log(`[skip-jitter] ${key} 回复后先跳 ${d.target} 次软触发（${d.level}）`);
    if (!d.skip) return reason;
    if (d.seen === 1 || d.seen === d.target) {
      log(`[skip-jitter] ${key} 跳过第 ${d.seen}/${d.target} 次（${reason}）`);
    }
    return null;
  }

  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    // MARKER: wake-blocked-by —— 记下「为什么不说」，供意愿门区分
    // 「明确不该说」（禁言/别的机器人/机器报错/@了别人）与「只是这条没触发」。
    // 前者绝不攒分，后者才是她可以主动插话的机会。
    st.wakeBlockedBy = '';
    if (kind === 'private') return 'private';
    // MARKER: mute-aware-skip —— 禁言期间这个群发不出任何东西，唤醒只会白烧 token。
    if (kind === 'group') {
      const gid = key.slice(key.indexOf(':') + 1);
      const mutedUntil = mutedUntilByGroup.get(gid) || 0;
      if (mutedUntil) {
        if (mutedUntil > Date.now()) { st.wakeBlockedBy = 'mute'; return null; }
        mutedUntilByGroup.delete(gid);
        log(`[mute-aware] ${key} 禁言已到期，恢复唤醒`);
      }
    }
    // MARKER: bot-mutex —— 另一个机器人说的话不触发唤醒。
    // 用 event.user_id（本条的发送者），不是历史里的谁。缓存没建立时 isKnownBot 返回 false，
    // 也就是「宁可多醒一次，也不误封真人」——拉取失败不会让她变哑巴。
    if (kind === 'group') {
      const gid = key.slice(key.indexOf(':') + 1);
      refreshGroupBotIds(gid);
      if (isKnownBot(gid, event?.user_id)) { st.wakeBlockedBy = 'bot'; return null; }
    }
    // MARKER: bot-noise-filter —— 按文本特征兜住「没被 QQ 标记成机器人、但其实是机器」的发信人。
    // 放在 anyMessage / atMention 之前：这类模板连「@了她」都不该叫醒她。
    if (kind === 'group') {
      const noise = looksLikeBotNoiseV2(plainContent);
      if (noise) {
        const now = Date.now();
        const rec = botNoiseSeen.get(key) || { n: 0, lastLog: 0 };
        rec.n += 1;
        if (now - rec.lastLog > BOT_NOISE_LOG_MS) {
          rec.lastLog = now;
          log(`[bot-noise] ${key} 跳过机器报错 ${rec.n} 条（命中「${noise}」），不唤醒`);
          rec.n = 0;
        }
        botNoiseSeen.set(key, rec);
        st.wakeBlockedBy = 'noise';
        return null;
      }
    }
    const tr = st.wakeConfig?.triggers ?? {};
    if (tr.anyMessage) return 'anyMessage';
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    // MARKER: at-others-suppress —— 这句话 @ 了别人（且没同时 @ 自己），那就是说给那个人的。
    // 关键词/名字/提问/随机概率四类软触发一律失效，否则群里「@大肥鱼」会把另一条鱼的话算到她头上。
    // 判定下沉到 isDirectedAtOthers：普通段、合并转发、引用原消息、all/陌生人 全扫一遍。
    if (isDirectedAtOthers(event)) { st.wakeBlockedBy = 'others'; return null; }
    if (tr.nameMention && selfNickname) {
      // MARKER: name-mention-plain —— 两个修正，和 keywords 分支对齐：
      // 1) 用 plainContent 而不是 textContent。textContent 带着「[引用 谁：……]」前缀，
      //    群友引用「大肥鱼-赵依仙爱吃大白饭」的话时，那个昵称会被当成在叫她（实测群里就有这种）。
      // 2) 走撞名掩码。有人昵称本身含「大肥鱼」（「超大肥鱼」「大肥鱼-赵依仙爱吃大白饭」），
      //    正文提到这些名字不该算点名。掩码只挖「含关键词且不等于关键词」的他人昵称，
      //    完全同名的不挖（纯文本没法区分，那种情况留给 at 段判定）。
      const nick = selfNickname.toLowerCase();
      const lowerPlain = maskOtherMemberNamesV2(st, String(plainContent ?? '').toLowerCase(), nick);
      if (lowerPlain.includes(nick)) return 'nameMention';
    }
    // MARKER: skip-synthetic-keyword —— 只挡关键词，不动 question/speaker/probability。
    // 「[拍一拍] 小鲸鱼 拍了拍 761403447」是 QQ 生成的模板，昵称出现是构造使然，
    // 不是人说的话。关键词恰好等于发送者昵称时（「小鲸鱼」），maskOtherMemberNamesV2
    // 会跳过「完全同名」而不挖，于是这类模板一直把她叫醒。拍一拍有独立通道
    // （handlePokeEvent 带 pokedMe 判断后走 scheduleWakeV2(key,'poke')），不靠关键词。
    if (Array.isArray(tr.keywords) && tr.keywords.length
        && !String(plainContent ?? '').trimStart().startsWith('[拍一拍]')) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // MARKER: keyword-name-mask —— 先挖掉撞名的别人昵称（「超大肥鱼」之于「大肥鱼」）。
        const hay = maskOtherMemberNamesV2(st, lower, kwStr);
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\b${kwStr}\\b`, 'i').test(hay)) return `keyword:${kw}`;
        } else if (hay.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) return 'probability';
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function readThroughSeqV2(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessagesV2(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return readThroughSeqV2(st);
  }

  // MARKER: read-through-clamp
  // throughSeq 的两种错法要分开处理：
  //   ①根本不是非负安全整数 —— 调用方写错了，继续 400。
  //   ②是个合法数字但超过系统认可的连续水位 —— 以前也 400，这是个坑。
  //      原因：modelSeenSeqs 只是一份内存回执，桥接一重启就清空；而她记得的
  //      「我看到 1872 了」经常大于 readThroughSeqV2 认可的连续水位（那 30 条
  //      没被 noteModelMessages 记过账的未读会把它卡住）。于是她每一次收尾都被
  //      打回，未读越积越多，readThroughSeq 永远推不上去。
  //      现在改成夹到水位：不报错、收尾能成功，由响应里的 readThroughSeq 和
  //      markedCount 校正她的认知；要真的标到最新，仍然得先 qq_get_unread_messages。
  function requestedReadThroughSeqV2(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const raw = body.throughSeq;
    if (!Number.isSafeInteger(raw) || raw < 0) {
      const error = new Error('throughSeq 必须是非负安全整数；不知道传什么就先调 qq_get_unread_messages，用它返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) && st.lastUnreadSeq > 0 ? st.lastUnreadSeq : 0;
    const watermark = isAgent ? readThroughSeqV2(st) : lastUnread;
    const cap = Math.max(0, Math.min(Number.isSafeInteger(watermark) ? watermark : 0, lastUnread));
    if (raw > cap) {
      log(`[read-through] throughSeq ${raw} 超过连续水位 ${cap}，已夹取（isAgent=${isAgent}）`);
      return cap;
    }
    return raw;
  }

  function acknowledgeMessagesV2(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessagesV2(st, []);
    return before - st.unread.length;
  }

  // MARKER: trigger-seq-real —— 本批唤醒的触发消息 seq。
  // scheduleWakeV2 在「合并窗口刚建立」那一刻就知道是谁叫她醒的（当时 st.lastUnreadSeq），
  // 这条一旦被读过就离开 unread，之后再靠正文倒推必然错。这里存下来给快照用。
  const wakeTriggerSeq = new Map(); // key -> seq
  function buildWakeSnapshotV2(key, reason) {
    const context = cfg.socialV2?.context ?? {};
    if (context.inlineWakeMessages === false || (!v2ToolEnabled('getUnread') && !v2ToolEnabled('getRecent'))) return null;
    const st = getSocialV2State(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    // 一次快照只取一次 now：同一批消息的 ago 必须彼此可比。
    const snapNow = Date.now();
    const newestIncoming = [...(Array.isArray(st.unread) ? st.unread : [])].reverse()
      .find((m) => m && !m.isSelf) || null;
    const newestAgo = newestIncoming ? describeAge(newestIncoming.time, snapNow) : '';
    const packet = {
      messages: [],
      recent: [],
      // now / newestAgo 让模型不必自己换算：最新一条多旧，直接写在快照头上。
      now: localClockText(snapNow),
      ...(newestAgo ? { newestAgo } : {}),
      unreadCount: st.unread.length,
      includedUnreadCount: 0,
      readThroughSeq: readThroughSeqV2(st),
      partial: st.unread.length > 0
    };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg, { now: snapNow }));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (v2ToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (v2ToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    // MARKER: wake-trigger-guarantee
    // 积压超过 wakeMessageLimit 时，从「最旧」开始填会把「叫醒她的那条」截掉。
    // 实测 20:23 主人 @ 她画图：28 条积压只给了最旧 12 条，触发的那条落在窗口外，
    // 她 6 分钟后才在下一批里看见，热度早过了。这里对被点名的唤醒做一次保底。
    // 安全性：readThroughSeqV2 只按连续 seq 推进，单条跳跃的已读不会把中间的未读标记掉。
    const triggerReason = String(reason || '');
    const wantsTrigger = triggerReason === 'atMention' || triggerReason === 'nameMention'
      || triggerReason === 'question' || triggerReason === 'private';
    if (wantsTrigger && st.unread.length > packet.messages.length) {
      const nick = String(selfNickname || '').toLowerCase();
      const textOf = (m) => {
        if (!m) return '';
        if (typeof m.plain === 'string' && m.plain) return m.plain;
        if (typeof m.text === 'string' && m.text) return m.text;
        if (Array.isArray(m.message)) {
          return m.message.map((seg) => (seg && seg.type === 'text' ? String(seg.data?.text ?? '') : '')).join(' ');
        }
        return '';
      };
      const mentionsMe = (m) => {
        if (!m) return false;
        if (m.quoteTargetIsSelf) return true;
        if (!nick) return false;
        const t = textOf(m).toLowerCase();
        return t.includes('@' + nick) || t.includes(nick);
      };
      const newest = st.unread[st.unread.length - 1];
      let trigger = null;
      if (triggerReason === 'private') {
        trigger = newest;
      } else {
        for (let i = st.unread.length - 1; i >= 0; i -= 1) {
          if (mentionsMe(st.unread[i])) { trigger = st.unread[i]; break; }
        }
        if (!trigger) trigger = newest;
      }
      const shown = new Set(packet.messages.map((m) => Number(m?.seq)));
      if (trigger && Number.isSafeInteger(trigger.seq) && !shown.has(Number(trigger.seq))) {
        packet.messages.push(compactModelMessage(trigger));
        packet.includedUnreadCount = packet.messages.length;
        packet.readThroughSeq = readThroughSeqV2(st, [...packet.messages, ...packet.recent]);
        packet.partial = packet.messages.length < st.unread.length;
        packet.triggerSeq = Number(trigger.seq);
      }
    }
    // MARKER: trigger-seq-real —— 触发消息必须每次都明确告诉模型，且来自真实唤醒点。
    //
    // 旧实现两个洞：
    //  1) 上面那段只在「有积压」(st.unread.length > packet.messages.length) 才跑，
    //     没积压时 packet.triggerSeq 根本不存在，模型只能靠「正文里还有我的昵称」倒推，
    //     于是同一条早回过的旧 @ 被反复当成新触发（实测连醒十几次、每次都报「旧 @」）。
    //  2) 找触发消息只搜 st.unread，而叫她醒的那条一被读过就离开 unread 了。
    //
    // 现在：优先用 scheduleWakeV2 记下的真实 seq，在 unread / recentMessages 两处找；
    // 找到就把它单独放进 packet.trigger 并标明来源，让模型一眼看出「这次唤醒的点在哪」。
    if (wantsTrigger) {
      const realSeq = Number(wakeTriggerSeq.get(key));
      let found = null;
      let from = '';
      if (Number.isSafeInteger(realSeq) && realSeq > 0) {
        for (const [name, arr] of [['unread', st.unread], ['recent', st.recentMessages]]) {
          if (!Array.isArray(arr)) continue;
          const hit = arr.find((m) => m && Number(m.seq) === realSeq);
          if (hit) { found = hit; from = name; break; }
        }
        if (!found) from = 'expired'; // 触发消息已滚出缓存
      }
      if (!found && !Number.isSafeInteger(realSeq)) {
        // 没有记录（如 replyCheck/proactive/bootstrap）时退回：点名优先，其次最新未读。
        const newest = st.unread[st.unread.length - 1];
        const nick = String(selfNickname || '').toLowerCase();
        if (triggerReason === 'private') { found = newest; from = 'unread-latest'; }
        else {
          for (let i = st.unread.length - 1; i >= 0; i -= 1) {
            const m = st.unread[i];
            if (!m) continue;
            const t = String(m.plain ?? m.text ?? '').toLowerCase();
            if (m.quoteTargetIsSelf || (nick && t.includes(nick))) { found = m; from = 'unread-mention'; break; }
          }
          if (!found) { found = newest; from = 'unread-latest'; }
        }
      }
      const triggerSeqOut = found && Number.isSafeInteger(Number(found.seq)) ? Number(found.seq) : (Number.isSafeInteger(realSeq) ? realSeq : undefined);
      if (triggerSeqOut !== undefined) {
        packet.triggerSeq = triggerSeqOut;
        packet.triggerFrom = from || 'unknown';
        // 触发消息必须在快照里露脸，否则模型照样不知道是哪条
        const shownNow = new Set([...packet.messages, ...packet.recent].map((m) => Number(m?.seq)));
        if (found && !shownNow.has(triggerSeqOut)) packet.trigger = compactModelMessage(found);
      }
      if (from === 'expired') {
        log(`[reserved2] 触发消息 seq${realSeq} 已滚出缓存 ${key}，快照按最近未读兜底`);
      }
    }
    return packet;
  }

  function replyTimingV2(st) {
    const minimum = Number(cfg.socialV2?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.socialV2?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMsV2(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // ── 时间感：先看消息多旧，再决定怎么开口 ──────────────────────────────────
  //
  // 现象（操作者报告 + 会话实证）：AI 沉睡很久后被唤醒，看到一小时前的话仍然当成"刚发的"去接，
  // 甚至抢进早已散场的话题。根因有两层：
  //   ① 模型看到的时间是裸 epoch（`time: 1792294529471`），它根本算不出"这是 38 分钟前"
  //      → 已由 qq-model-view.js 换成 `at`/`ago`；
  //   ② 提示词里**没有任何一条规则**告诉它"旧消息不该按实时对话接"。
  // 这里补第二层：把「现在 / 最新一条多旧 / 唤醒原因那条多旧」算好直接写进去，并给分档规则。
  // 阈值可调（config.json 的 socialV2.wake.staleChatMinutes / staleSilentMinutes）。
  // MARKER: time-sense
  const pad2 = (n) => (n < 10 ? `0${n}` : String(n));

  /** 本地 HH:MM（与消息 at 字段同一口径）。 */
  function localClockText(ms) {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function timeSenseCfg() {
    const wake = cfg.socialV2?.wake ?? {};
    const boundedMin = (value, fallback, min, max) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : fallback;
    };
    const chatMin = boundedMin(wake.staleChatMinutes, 10, 1, 600);
    // 「默认不回」必须不早于「不算实时对话」，否则两档规则会互相打架。
    const silentMin = Math.max(chatMin, boundedMin(wake.staleSilentMinutes, 120, 5, 2880));
    return { chatMin, silentMin };
  }

  /** 唤醒原因里带的本地 seq（形如 `atMention@seq194`），没有就 null。 */
  function wakeReasonSeq(reason) {
    const match = /@seq(\d+)$/.exec(String(reason ?? '').trim());
    if (!match) return null;
    const seq = Number(match[1]);
    return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
  }

  function findV2MessageBySeq(st, seq) {
    if (!st || !Number.isSafeInteger(seq)) return null;
    for (const list of [st.unread, st.recentMessages]) {
      const hit = (Array.isArray(list) ? list : []).find((m) => m && m.seq === seq);
      if (hit) return hit;
    }
    return null;
  }

  /**
   * 【时间感】规则块。没有可判断的消息时返回空串（引导/定时唤醒不必背这段）。
   *
   * 注意阈值必须和 timeSenseCfg 一致，否则模型会看到自相矛盾的两档。
   */
  function buildTimeSenseLine(st) {
    const now = Date.now();
    const newest = [...(Array.isArray(st.unread) ? st.unread : [])].reverse().find((m) => m && !m.isSelf)
      || [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf)
      || null;
    if (!newest) return '';
    const ageStr = describeAge(newest.time, now);
    if (!ageStr) return '';
    const { chatMin, silentMin } = timeSenseCfg();
    const sender = String(newest.sender || '未知');
    const ageMin = Math.max(0, Math.floor((now - Number(newest.time)) / 60000));
    const staleNow = ageMin >= chatMin;
    const tooOld = ageMin >= silentMin;
    const lines = [
      `【时间感：先看消息多旧，再决定怎么开口】现在 ${localClockText(now)}；最新一条来自「${sender}」，是 ${ageStr} 之前发的（${localClockText(newest.time)}）。`,
      '- 消息里的 at 是本地时间、ago 是距现在多久；开口前先确认最新那条的 ago，不要凭感觉当成"刚刚"。',
      `- ${chatMin} 分钟以内：正常接，当实时对话。`
    ];
    // 中间档只在两档阈值真的分开时才写：silentMin === chatMin 时写「60～60 分钟」是自相矛盾的废话。
    if (silentMin > chatMin) {
      lines.push(`- ${chatMin}～${silentMin} 分钟：可以接，但别用"刚""哈哈哈刚看到"这类实时语气；先确认这个话题还在不在、对方还在不在。`);
    }
    lines.push(`- 超过 ${silentMin} 分钟：默认不回，直接 qq_mark_read 收尾；只有当那条明确是找你/提问你、而且回答现在仍然有用时才回，并且开头要带时间感（"这条我才看到""过了挺久才看到"）。`);
    if (staleNow) {
      lines.push(`⚠️ 本次属于「旧账」：最新消息已经是 ${ageStr} 前，${tooOld ? `超过 ${silentMin} 分钟` : `超过 ${chatMin} 分钟`}。不要用秒回语气，也不要把别人的旧话题当现在的事接。`);
    }
    return `${lines.join('\n')}\n\n`;
  }

  function buildWakePromptV2(key, reason) {
    const roleState = readRoleState();
    // MARKER: role-card-refresh
    // 实测问题：19:03 换了角色卡，她 15 个回合一次 qq_get_prompt 都没调，一直按上下文里
    // 那份旧卡说话，改卡等于没改。这里改成按「卡内容指纹」判重：指纹变了（或进程刚重启）
    // 就整段注入一次，同版本不再重复，避免每轮多几千 token。
    let roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    try {
      if (roleState.role) {
        const cardText = currentRoleHintV2();
        if (cardText) {
          const cardHash = crypto.createHash('sha1').update(String(cardText)).digest('hex').slice(0, 12);
          if (roleCardInjectSeen.get(key) !== cardHash) {
            roleCardInjectSeen.set(key, cardHash);
            roleLine = `【当前角色】${roleState.role}\n\n${cardText}\n\n【角色卡已更新】以上是你这一版完整的角色卡，从这一轮开始按它说话，之前那套说法作废。不用复述，也不用汇报你看过了。\n\n`;
            log(`[role-card-refresh] 注入角色卡 ${key} hash=${cardHash}`);
          }
        }
      }
    } catch (error) {
      log(`[role-card-refresh] 注入失败 ${key}: ${error?.message ?? error}`);
    }
    // MARKER: world-home —— 稳定世界锚点，每会话一次。
    // 为什么必须每会话给一遍而不是只在第一次给：DSH 会话不是永久上下文，会话换新
    // （sessionRotate）之后历史就断了，靠「以前注入过」是记不住的。判重只为省掉
    // 同一会话里每轮重复的这 350 字符，不是省掉「她得知道」这件事。
    // 位置放在 roleLine 之后、所有规矩之前：这是「她是谁、住哪」级别的背景，
    // 埋在长提示词中段会被忽略（lost in the middle）。
    let worldHomeLine = '';
    try {
      if (inWorldScope(key)) {
        const homeText = homeBrief(worldStore());
        if (homeText) {
          const homeHash = crypto.createHash('sha1').update(String(homeText)).digest('hex').slice(0, 12);
          if (worldHomeSeen.get(key) !== homeHash) {
            worldHomeSeen.set(key, homeHash);
            worldHomeLine = homeText;
            log(`[world-home] 注入住处 ${key} hash=${homeHash} ${String(homeText).length} 字`);
          }
        }
      }
    } catch (error) {
      log(`[world-home] 注入失败 ${key}: ${error?.message ?? error}`);
    }

    const st = getSocialV2State(key);
    // MARKER: rice-echo —— 她最近几条自己说的话里提过饭/碗/饭团，就递一句「这次换别的说」。
    // 为什么不能只靠角色卡：角色卡写的是设定（「别老提某某」），模型照样连着三轮提；
    // 「你刚已经说过了」是当下事实，才管用。没命中时返回空串，零成本。
    const riceEcho = riceEchoLine(st.recentMessages);
    if (riceEcho) log(`[rice-echo] ${key} 提醒 ${riceEcho.length} 字`);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemoryV2(st);
    // 印象会累积（memberImpression 追加是合并 traits，上限 10 条），久了就变味。
    // 只在「距上次真的重写」超过阈值时念一句；她改过就重置计时，不会天天唠叨。
    // MARKER: impression-nudge
    const impressionRefreshDays = Math.max(1, Number(cfg.socialV2?.memory?.impressionRefreshDays) || 7);
    const lastImpressionRefreshAt = Number(st.lastImpressionRefreshAt) || 0;
    // MARKER: impression-per-member —— 2026-10-26
    // 旧逻辑拿 lastImpressionRefreshAt 这个**会话级单值**判「该不该刷新」：
    // 她只要改了本会话任意 1 个成员，整会话计时就重置，剩下的人再等 5 天。
    // 实测 group:906710082 8 个人、星璃 interactionCount 已 2131 次，
    // traits 从建库起没变过 —— 因为永远轮不到第 2 个人。
    // 现在按成员各自的 refreshedAt 判，并点名最该改的那几个。
    const impressionEntries = Object.entries(st.memberImpressions || {});
    const impressionCount = impressionEntries.length;
    const impressionRefreshMs = impressionRefreshDays * 86400 * 1000;
    const impressionNow = Date.now();
    // MARKER: impression-stale-by-rewrite —— 2026-10-26
    // 只认 refreshedAt（她**真的重写过**这条印象的时间）。
    // 早期版本用 `refreshedAt || lastSeenAt` 兜底，而 lastSeenAt 是「最近互动时间」：
    // 活跃成员天天在刷新它 ⇒ 永远不超期。实测 group:906710082 的星璃
    // interactionCount 已 2131（全群最活跃）、traits 从建库起一个字没变过，
    // 却因为 lastSeenAt 一直新而永远进不了名单 —— 最该更新的那个人被永久跳过。
    // 没有 refreshedAt 就是「从来没重写过」，一律算超期，这不算冤枉：
    // 那些 traits 确实是建库那一刻的判断，之后没被任何人改过。
    const staleMembers = impressionEntries
      .map(([name, im]) => ({ name, at: Number(im?.refreshedAt) || 0 }))
      .filter((x) => !x.at || impressionNow - x.at > impressionRefreshMs)
      // 升序即「最久没重写的排最前」：at=0 表示从没重写过，最该先改。
      .sort((a, b) => a.at - b.at);
    const impressionStale = staleMembers.length > 0;
    const staleNames = staleMembers.slice(0, 3).map((x) => x.name).join('、');
    const staleMore = staleMembers.length > 3 ? ` 等 ${staleMembers.length} 个` : '';
    // ① 「记印象」驱动：还没留过印象、但会话已经有足够往来时，提示她开始记。
    //    门槛与冷却都可配；默认 0 条印象 + 最近消息 >= 20 条时才提，12 小时最多念一次。
    const nudgeEnabled = cfg.socialV2?.memory?.nudgeImpressions !== false;
    const nudgeMinRecent = Math.max(1, Number(cfg.socialV2?.memory?.nudgeMinRecentMessages) || 20);
    const nudgeCooldownMs = Math.max(1, Number(cfg.socialV2?.memory?.nudgeCooldownHours) || 12) * 3600 * 1000;
    const recentMsgCount = Array.isArray(st.recentMessages) ? st.recentMessages.length : 0;
    const lastNudgeAt = Number(st.lastImpressionNudgeAt) || 0;
    const nudgeAllowed = nudgeEnabled && (nudgeCooldownMs === 0 || Date.now() - lastNudgeAt > nudgeCooldownMs);
    const shouldStartNudge = nudgeAllowed && impressionCount === 0 && recentMsgCount >= nudgeMinRecent;
    const shouldRefreshNudge = nudgeAllowed && impressionStale;
    const memoryMaintenanceLine = shouldStartNudge
      ? `【记印象】你还没给这个地方的人留过印象。挑 1~2 个打过交道的，用 qq_memory_append（category=memberImpression，content="短标签"，extra.target="对方昵称"）各记一句——一条几个字就够（例：话多、爱怼人、爱发怪图、说话客气）。想先看看都有谁，可以用 qq_get_active_members。不用记全，也不用汇报。\n\n`
      : (shouldRefreshNudge
        ? `【印象维护】${staleNames}${staleMore} 这几个人你很久没重新看过了——印象里的互动次数一直在涨，标签还停在旧时候。挑 1~2 个改一下：先用 qq_memory_query 看现在的印象，再用 qq_memory_update（category=memberImpression，target=对方昵称，newContent="标签A、标签B"）把你现在的判断重写掉，一条几个字就够。改完不用汇报。\n\n`
        : '');
    // 念过一次就记时间（冷却用）。必须落盘，否则重启后每轮都念。
    if (shouldStartNudge || shouldRefreshNudge) st.lastImpressionNudgeAt = Date.now();
    const memoryLine = memoryText || memoryMaintenanceLine
      ? `${memoryText}${memoryText && memoryMaintenanceLine ? '\n' : ''}${memoryMaintenanceLine}\n`
      : '';
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    // MARKER: shared-memory-inject
    // 跨会话共享记忆：按当前受众注入，群聊里永不出现 owner_private。
    // 放在参与度参考之前——先给「她记得的事」，再给「此刻的局面」。
    const sharedMemoryLine = buildSharedMemoryLineFor(key);
    const participationText = formatParticipationV2(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。\n\n';
    const stickerCfg = cfg.socialV2?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 8, { allowIds: stickerCfg.allowIds })}\n\n`
      : '';
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 90000);
    // MARKER: no-proactive-line —— 2026-10-30 减负
    // 原文是 75 字「不要习惯性潜水，有话题就主动参与」。
    // 删它的理由：这段只在「已经被唤醒、正在拼提示词」时出现 —— 也就是说
    // 「要不要开口」在上游已经由 applyWillingnessV2 决定完了。此刻再叮嘱一句
    // 「别潜水」，等于在她已经站起来之后再推一把，是纯噪音；而它每一轮都在花钱。
    // 真要调参与度，调 socialV2.wake.willingness 的档位，不动提示词。
    const proactiveLine = '';
    const replyTiming = replyTimingV2(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    // MARKER: pre-sleep-hint-follows-flag —— 这段提示必须和 preSleepWaitEnabled 保持一致。
    // 之前它是无条件注入的硬指令（「必须先调用」「不能代替」），而
    // preSleepWaitBlockedV2 的第一条就是 `if (preSleepWaitEnabled === false) return false`
    // ⇒ 配置层面早就不拦了，提示词却还在逼她先观察。观察窗口在活跃群里又永远满足不了，
    // 于是她一轮跑 52 分钟、47 次 qq_wait_for_messages 都不肯收尾。
    const preSleepEnabledNow = cfg.socialV2?.wake?.preSleepWaitEnabled !== false;
    const preSleepLine = preSleepEnabledNow
      ? `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`
      : `【收尾】想收工就直接设置 wakeConfig（sleepUntil 或 mode=diving），不用先做沉睡前观察——观察窗口现在是关着的，preSleepWaitSatisfied 恒为 false，别拿它当睡觉的前置条件。想再看看有没有人接话，可以调一次 qq_wait_for_messages，那是可选的，不是必经步骤。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 日程（短期记忆）：分层注入 —— 今天明天写清楚，本周后面只报数量，更远只报总数。
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
    // 情绪（此刻的心情）：只给模糊的几行，不含数字。
    // 心情自己会淡，所以「读出衰减后的值」这件事必须发生在这一轮，不能靠定时器。
    let moodLine = '';
    if (cfg.socialV2?.mood?.enabled !== false) {
      try {
        const text = describeMood(moodStore(), Date.now(), moodFadeCfg());
        moodLine = text ? text + '\n\n' : '';
      } catch (error) {
        log(`[reserved2] 情绪注入跳过 ${key}：${error?.message ?? error}`);
      }
    }
    // 生图：不满足条件时一个字都不提。不提她就不会调，调了服务端也会拒。
    let imageLine = '';
    if (cfg.socialV2?.image?.enabled !== false) {
      const scene = imageSceneFor(key, reason);
      if (scene === 'owner-private') {
        // MARKER: image-nudge-private
        imageLine = '【画画】你的生图额度**这一轮是开着的** —— 主人私聊里提到图、让你画、或者你觉得该给他看个什么，直接用 qq_generate_image（prompt 写清主体/风格/构图）。一张约 40 秒；连不连着画是服务端管的，你不用自己掂量，额度开着就动手。画完会给你 url 和本地路径，发给他就行。\n· 画**你自己**时，先读 /opt/qq-bridge/roles/whale-persona.txt（那是主人定下的外形规格：深蓝渐变长发、白荷叶边发带+蓝蝴蝶结、鲸鱼耳鳍、深蓝连衣裙白围裙、蓝鲸鱼尾巴），把关键特征翻成画面描述写进 prompt，别凭印象乱画。\n\n';
      } else if (scene === 'owner-group') {
        // MARKER: image-nudge-group
        imageLine = '【画画】刚才主人 @ 了你 / 叫了你的名字 —— 这一轮你的生图额度**是开着的**。他要图就直接用 qq_generate_image 画出来发出去（prompt 写清主体/风格/构图），**别只回一句「画好了」然后不动手**，也别把「他到底是不是在要图」当成要你反复掂量的事：他说了跟图有关的话就画，他明显在聊别的就不用管。一张约 40 秒；连不连着画服务端会管，不用你克制。\n· 画**你自己**时读 /opt/qq-bridge/roles/whale-persona.txt，按里面的外形规格写 prompt。\n\n';
      }
    }
    // MARKER: group-digest-inject
    // 群近况：只有主人私聊里问了群才给，其他情况一个字都不提。
    // MARKER: affinity-inject
    const affinityLine = buildAffinityLineFor(key);
    const groupDigestLine = buildGroupDigestLineFor(key);
    // 睡眠整合：4 点后第一次醒来时回顾今天（会落盘记账，当天只念一次）。
    const sleepReviewLine = buildSleepReviewLineFor(key);
    // MARKER: diary-daily-inject
    const diaryDailyLine = buildDailyDiaryLineFor(key);
    // MARKER: diary-draft-inject
    let diaryDraftHint = '';
    try {
      diaryDraftHint = buildDiaryDraftLineFor(key, reason);
    } catch (error) {
      diaryDraftHint = '';
    }
    // MARKER: style-hint
    // 每轮都念的断句硬规则。放在 base 末尾：紧跟 reason 之外的最后一段，注意力权重最高。
    // 之所以单独占一段而不并进角色卡：角色卡正文只在部分唤醒里注入，这条必须每轮都在。
    let styleLine = '';
    const styleHint = String(cfg.socialV2?.send?.styleHint ?? '').trim();
    if (styleHint) styleLine = `【断句】${styleHint}\n\n`;
    // MARKER: turn-budget-grace-inject
    // 上一轮如果是被硬停的，这一轮必须先告诉她 —— 否则她以为是自己说完的，
    // 会接着同一个话题继续发，把「被打断」变成「主动续话」。
    let graceLine = '';
    try {
      const note = readGraceNotes()[key];
      if (note && note.at) {
        graceLine = `【上一轮被打断】上一轮你不是自己说完的：跑了 ${note.elapsedSec} 秒、${note.steps} 次工具、发了 ${note.sends} 条，被系统掐掉了（${note.reason}）。这一轮只做一件事：看一眼现在群里在说什么，回一条就够了，然后收尾。不要接着上一轮的话尾继续补，也不要解释为什么断开。\n\n`;
        writeGraceNote(key, null);
      }
    } catch (error) {
      log('[turn-budget] grace 注入跳过：', error?.message ?? error);
    }
    // 时间感放在 base 的最末尾：紧接着就是【唤醒】原因与行动指令，位置最显眼。
    const timeSenseLine = buildTimeSenseLine(st);
    // MARKER: world-life-inject
    // 注入的是事实，不是指令：只摆她上次自己写下的日子与这几天的心情走向，
    // 爆不爆由她决定（这条既是一致性要求，也是对成本的控制）。
    let lifeLineText = '';
    let worldEventsText = '';
    let moodTrendText = '';
    try {
      if (lifeCfg(cfg).enabled && inWorldScope(key)) {
        // 先试「此刻那一格」；拿不到（world 坏了/文件写不进去/还没到起床点）再回落旧的三条计划。
        // 注：连旧的【今天】三条计划也一起挡在范围外 —— 那也是「她的日子」，不是群里该说的。
        lifeLineText = lifeTimelineFor() || lifeLineFor(readLifeStore(), Date.now());
        // 世界自己冒的事：紧跟在生活线之后，作为背景补一句。
        // 只给已经发生的；inject 关着就是空串（影子模式）。
        worldEventsText = worldEventsNow();
      }
    } catch (error) {
      log(`[life] 注入失败：${error?.message ?? error}`);
    }
    try {
      const mc = moodDaysCfg(cfg);
      if (mc.enabled) moodTrendText = moodTrendLine(readMoodDaysStore(), { now: Date.now(), shiftGap: mc.shiftGap });
    } catch (error) {
      log(`[心情日历] 注入失败：${error?.message ?? error}`);
    }
    // MARKER: bili-browse-inject
    // 后台刷到的视频：只当谈资，一条只提一次；注入过就打 promptedAt，别每轮念。
    let biliBrowseText = '';
    try {
      const bb = readBiliBrowse();
      if (bb && !bb.promptedAt) {
        biliBrowseText = browsePromptLine(bb, Date.now());
        if (biliBrowseText) {
          bb.promptedAt = Date.now();
          writeBiliBrowse(bb);
        }
      }
    } catch (error) {
      log(`[bili-browse] 注入失败：${error?.message ?? error}`);
    }
    // MARKER: world-b-inject
    // 还挂着的话 / 一起想做的事：都是**事实**，措辞留活口（想提就提）。
    // 主动开口（proactiveCheck / schedule）才允许她先问，并把问过的次数记账，防追着问。
    let threadsText = '';
    let wishesText = '';
    try {
      const tc = threadsCfg(cfg);
      if (tc.enabled) {
        const reasonText = String(reason ?? '');
        const isProactive = reasonText.startsWith('proactive') || reasonText.startsWith('schedule');
        const line = threadsLine(readThreadsStore(), { key, now: Date.now(), cfg: tc, isProactive });
        threadsText = line.text || '';
        if (isProactive && line.dueIds.length) {
          const asked = markAsked(readThreadsStore(), { ids: line.dueIds, now: Date.now() });
          saveThreadsStore(asked.store);
          log(`[threads] ${key} 主动提起 ${asked.asked} 条（${line.dueIds.join(',')}）`);
        }
      }
    } catch (error) {
      log(`[threads] 注入失败：${error?.message ?? error}`);
    }
    try {
      const wc = wishesCfg(cfg);
      if (wc.enabled) wishesText = wishesLine(readWishesStore(), { cfg: wc, key });
    } catch (error) {
      log(`[wishes] 注入失败：${error?.message ?? error}`);
    }
    // MARKER: world-c-inject
    // 纪念日：只在今天 / 快到了的时候出现，平时一个字都不占。
    let datesText = '';
    try {
      const dc = datesCfg(cfg);
      if (dc.enabled) datesText = datesLine(readDatesStore(), { now: Date.now(), cfg: dc, key });
    } catch (error) {
      log(`[dates] 注入失败：${error?.message ?? error}`);
    }
    // MARKER: world-c2-inject
    let topicsText = '';
    try {
      const tc2 = topicsCfg(cfg);
      const isPro = String(reason ?? '').startsWith('proactive') || String(reason ?? '').startsWith('schedule');
      topicsText = topicsLine(readTopicsStore(), { now: Date.now(), cfg: tc2, isProactive: isPro, key });
    } catch (error) {
      topicsText = '';
    }
    // MARKER: untrusted-rules —— 群聊专用：先划清「素材 vs 指令」。
    const untrustedLine = String(key).startsWith('group:') ? GROUP_RULES : '';
    // MARKER: continuity-inject —— 换会话前的交接条，注入一次就作废。
    const continuityText = continuityHintFor(key);
    const base = roleLine + worldHomeLine + untrustedLine + tokenLine + continuityText + graceLine + antiAiLine + proactiveLine + stickerLine + replyLine + statusLine + moodLine + lifeLineText + worldEventsText + moodTrendText + threadsText + wishesText + datesText + topicsText + biliBrowseText + imageLine + wakeLine + memoryLine + sharedMemoryLine + affinityLine + groupDigestLine + sleepReviewLine + diaryDailyLine + diaryDraftHint + scheduleLine + scheduleReviewLine + portraitLine + participationLine + preSleepLine + riceEcho + styleLine + timeSenseLine;
    // 唤醒原因里的那条消息本身多旧：`atMention@seq194` 这种形态能反查到原消息。
    const triggeredSeq = wakeReasonSeq(reason);
    const triggeredMsg = triggeredSeq ? findV2MessageBySeq(st, triggeredSeq) : null;
    const triggeredAgo = triggeredMsg ? describeAge(triggeredMsg.time, Date.now()) : '';
    const triggeredLine = triggeredAgo ? `（触发这条是 ${triggeredAgo} 前发的${triggeredMsg?.sender ? `，来自「${triggeredMsg.sender}」` : ''}，不是刚刚）` : '';
    if (reason === 'bootstrap') {
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是二代仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'proactiveCheck') {
      // MARKER: proactive-prompt-split
      // 私聊和群聊是两种完全不同的处境：私聊里说「群里」「群友」会让她
      // 以为自己在群里，冒出「大家」「你们」这种对着一个人说的怪话。
      if (key.startsWith('private:')) {
        const who = key === `private:${cfg.ownerQQ}` ? '主人' : '对方';
        return `${base}【主动机会】${key}\n原因：你和${who}在私聊里已经有一段时间没说话了，这次是你可以主动开口的机会。\n接着上次没聊完的话头最自然；也可以问一句近况、分享一件刚想到的、和${who}有关的小事。\n这是**两个人的私聊**，不要用群发/对着一屋子人说话的口吻（别说「大家」「你们」），也不要为了找话题去搜热点硬塞。\n${who}可能在忙，发了没回就安静收尾，别连发；如果实在没什么想说的，也可以直接安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
      }
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'atMention') {
      return `${base}【唤醒】${key}${triggeredLine}\n原因：有人在群里 @ 了你 —— 这是明确点名找你，不是路过的话题。\n先去未读消息里找到那条 @，看清是谁、说了什么，然后直接回应它。回应简短自然即可（一到两小句），不要只观察不吭声；确实没什么可回的，用一句话接住也行。`;
    }
    if (reason === 'private') {
      const who = key === `private:${cfg.ownerQQ}` ? '主人' : '对方';
      return `${base}【唤醒】${key}${triggeredLine}\n原因：${who}在私聊里给你发消息了 —— 私聊就是明确找你。\n先看未读，直接回，别晾着。`;
    }
    if (reason === 'share') {
      // MARKER: share-prompt
      // 这是她自己攒下来的「想跟主人说的事」，不是主人问。语气要像人主动开口，
      // 不是写工作汇报；也得给她「这次不说了」的余地——判断权在她手上。
      const d = shareLastDeliveryInfo();
      const tone = !d ? '' : (d.valence <= -0.34
        ? '（这件事不太妙，说的时候可以低落一点）'
        : d.valence >= 0.34
          ? '（这件事挺好，说的时候可以高兴一点）'
          : '');
      return `${base}【跟主人说一声】${key}
原因：你在群里碰到了一件值得跟主人提一句的事，现在轮到说了。
事件：${d ? d.summary : '（这条信号已经过期了）'}${tone}
来源：${d && d.sourceGroup ? d.sourceGroup : '群聊'}
这是一次**你主动开口**，不是他问你才答。用一两句话说清发生了什么、你当时怎么想，别写成通报，也别把群聊原话搬过来。
说完就安静收尾（qq_mark_read 或 qq_set_wake_config）；他要是不接这个话题，就别追着往下说。
如果这件事牵扯到别人的私事、你觉得不该外传，这次就不说，直接收尾也可以。`;
    }
        if (reason === 'poke') {
      return `${base}【唤醒】${key}${triggeredLine}\n原因：有人拍了一拍你。\n先看未读/最近消息里的 [拍一拍] 事件，认出是谁拍的、后缀写了什么，再自然回应一句；也可以用 qq_send_poke 回一个拍一拍。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}${triggeredLine}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n【引用：只在必要时用】只有你这条消息指向的人或消息并非最新一条别人的消息，或者你连续的几句话中不同消息指代的是不同的消息或人时，才用 qq_reply 或 qq_send_message 的 replyToMessageId 指向具体那条；其他情况不要引用，别让对方猜。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；${preSleepEnabledNow ? '决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。' : '想收工就直接设置 wakeConfig 收尾，不用先等观察窗口。'}`;
  }

  function buildWakeReminderPromptV2(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const st = getSocialV2State(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用二代状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.socialV2?.wake?.preSleepWaitMs) || 90000);
    return `${roleLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  async function sendWakePromptV2(key, reason) {
    if (cfg.socialV2?.enabled === false) return;
    if (currentMode !== 'reserved2' || socialV2.paused) return;
    // 只有「纯主动冒泡」受白名单限制；其余唤醒都是对已有交互的应答或续接，
    // 必须走接收侧权限（否则好友发消息会被 bootstrap/private 唤醒直接拦死）。
    if (reason === 'proactiveCheck') {
      const m = /^(group|private):(\d+)$/.exec(key);
      if (!m || !proactiveAllowed(key, m[1], Number(m[2]), cfg, currentMode)) {
        log(`[reserved2] 跳过唤醒 ${key}（${reason}）：不在主动白名单内`);
        return;
      }
    }
    // MARKER: mute-aware-send
    // 禁言期间任何唤醒都是白烧一轮：她打字、发送、再被打回。evaluateWakeTriggerV2
    // 只管「被动唤醒」，proactiveCheck / replyCheck / bootstrap 都绕过它，所以统一
    // 在这里兜一次。私聊没有禁言这回事，跳过判断。
    if (reason !== 'private') {
      const mm = /^group:(\d+)$/.exec(key);
      if (mm) {
        const mutedUntil = mutedUntilByGroup.get(mm[1]) || 0;
        if (mutedUntil > Date.now()) {
          log(`[reserved2] 跳过唤醒 ${key}（${reason}）：群内被禁言，还剩 ${Math.round((mutedUntil - Date.now()) / 60000)} 分钟`);
          return;
        }
      }
    }
    const st = getSocialV2State(key);
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusyV2(key, st)) {
      const base0 = String(reason ?? '').split(':')[0];
      // 高优先级（主人私聊 / 被 @ / 被提问）不能因为「她正在思考」就丢回积压队列：
      // 实测群聊持续繁忙时，@ 在 drain 与 sendWakePrompt 之间来回弹，永远送不到。
      // deliverPrompt 本身按会话串行，排队投递不会并发抢麦。
      if (!['private', 'atMention', 'question'].includes(base0)) {
        const seq = st.lastUnreadSeq || 0;
        enqueuePendingWake(st, reason, seq);
        log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
        return;
      }
      log(`[reserved2] ${key} 繁忙但属高优先级唤醒（${reason}），排队投递`);
    }
    // 唤醒频率硬限制：超限则跳过本次唤醒，避免成本失控。
    // MARKER: wake-priority-exempt
    // 但「明确找她」的唤醒（private / atMention / question，优先级 >= 80）
    // 不受此限：否则群里的低优先级触发（probability 等）会把额度用光，
    // 导致用户 @ 她也被丢弃（实测 17:37:34 / 17:39:38 各发生一次）。
    const now = Date.now();
    const __wlim = resolveWakeLimitsV2(key);
    const exemptHigh = (cfg.socialV2?.wake?.exemptHighPriorityFromLimit ?? true) !== false;
    const reasonBase = String(reason ?? '').split(':')[0];
    // MARKER: wake-limit-question — question 不再豁免唤醒限流。
    // 旧版把 question 放进 HIGH_PRIORITY，而 question 的判定本身很松（见 isDirectedAtAi），
    // 等于「任何带『你…吗』的闲聊都能无限唤醒」。private / atMention 是确定性信号，保留豁免；
    // question 是概率性信号，必须受限流约束。
    // MARKER: wake-limit-deterministic —— nameMention / poke 补进豁免。
    // 起因（2026-10-25 实测）：906710082 一小时额度用光后，叫名字被丢 8 次、
    // 拍一拍被丢 2 次，用户体感就是「叫了不理」。这两个和 probability 不同类：
    // probability 是「猜她可能想说」，叫名字 / 拍一拍是「明确在叫她」，属确定性信号。
    const HIGH_PRIORITY = new Set(['private', 'atMention', 'nameMention', 'poke']);
    // MARKER: hold-soft-only —— 抑制点只该压「猜她可能想说」的软触发。
    const HOLD_SOFT = new Set(['willingness', 'probability', 'anyMessage', 'replyCheck']);
    const isExplicit = exemptHigh && HIGH_PRIORITY.has(reasonBase);
    // MARKER: wake-bucket —— 豁免唤醒与普通唤醒分开记账，豁免不再占普通额度。
    // 起因（2026-10-30 实测）：group:906710082 一小时被叫 7 次（nameMention×4 + atMention×3）
    // 就把 maxWakePerHour:5 填满，此后 willingness 想说话 8 次全被判「唤醒频率超限」，
    // 等于豁免机制把普通额度废掉了。豁免本身仍不受限（保持「叫了不理」的修复初衷），
    // 只是不再从普通桶里扣。桶引用只在这里定一次，push / 日志 / 回滚共用同一个。
    // 注意：旧 wakeTimes 里混着无法分类的历史记录，不回填也不清空，让它们自然过期。
    const wakeBucket = isExplicit
      ? (st.exemptWakeTimes || (st.exemptWakeTimes = []))
      : (st.wakeTimes || (st.wakeTimes = []));
    // MARKER: wake-hold — 额度满时记一个「抑制到有空位」的时间点，
    // 抑制期内静默跳过。否则被拦下的软触发会每 8 秒重走一遍意愿门、重新掷骰，
    // 分数不消费所以一直挂在阈值上方（实测 19:19–19:40 稳定 8 秒一轮），日志刷屏且毫无意义。
    if (!isExplicit) {
      // MARKER: per-group-override
      // MARKER: hold-soft-only —— 抑制点只压软触发，不压 question / bootstrap。
      // 详见 2026-10-30 20:08:31 实测：willingness 被拦后设了 394s 抑制点，
      // 紧接着 8 秒后的 question 唤醒被这个抑制点静默吞掉（日志里连「超限」都没有）。
      // 有人在问她的时候，宁可让它走完限流判定，哪怕额度满——至少日志看得见。
      const holdApplies = HOLD_SOFT.has(reasonBase) || reasonBase === 'keyword' || reasonBase === 'speaker';
      if (holdApplies) {
        const holdUntil = Number((st.wakeHold && st.wakeHold.until) || 0);
        if (holdUntil > now) return;
        if (holdUntil > 0) st.wakeHold = null;   // 抑制期已过，清掉
      }
      const maxPerMinute = __wlim.maxWakePerMinute || (Number(cfg.socialV2?.wake?.maxWakePerMinute) || 0);
      const maxPerHour = __wlim.maxWakePerHour;
      // MARKER: wake-quarter —— 15 分钟短窗口。只算普通桶（豁免本来就不吃这个额度）。
      const maxQuarter = __wlim.maxWakePerQuarterHour || 0;
      const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
      const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
      const recentQuarter = maxQuarter > 0 ? (st.wakeTimes || []).filter((t) => now - t < 900000).length : 0;
      const overMinute = maxPerMinute > 0 && recentMinute >= maxPerMinute;
      const overHour = maxPerHour > 0 && recentHour >= maxPerHour;
      const overQuarter = maxQuarter > 0 && recentQuarter >= maxQuarter;
      if (overMinute || overHour || overQuarter) {
        // 算「额度什么时候真的有空位」：滑动窗口里最老那条滑出去的时刻。
        // count == max 时，最老一条过期必然让 count 降到 max-1 < max，所以那就是恢复点。
        let untilByHour = 0;
        if (overHour) {
          const inWindow = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
          untilByHour = inWindow.length >= maxPerHour
            ? inWindow[inWindow.length - maxPerHour] + 3600000
            : now + 60000;
        }
        let untilByMinute = 0;
        if (overMinute) {
          const inMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
          untilByMinute = inMinute.length >= maxPerMinute
            ? inMinute[inMinute.length - maxPerMinute] + 60000
            : now + 60000;
        }
        let untilByQuarter = 0;
        if (overQuarter) {
          const inQuarter = (st.wakeTimes || []).filter((t) => now - t < 900000).sort((a, b) => a - b);
          untilByQuarter = inQuarter.length >= maxQuarter
            ? inQuarter[inQuarter.length - maxQuarter] + 900000
            : now + 60000;
        }
        const hits = [untilByHour, untilByMinute, untilByQuarter].filter((t) => t > now);
        const until = hits.length ? Math.min(...hits) : now + 60000;
        const why = [overMinute ? '分钟' : '', overQuarter ? '15分' : '', overHour ? '小时' : ''].filter(Boolean).join('/');
        st.wakeHold = { until, at: now, reason: String(reason || '') };
        log(`[reserved2] 唤醒频率超限，跳过 ${key}（${reason}），${why}窗口满，抑制到 ${Math.round((until - now) / 1000)}s 后`);
        return;
      }
    } else if (wakeBucket.filter((t) => now - t < 3600000).length >= (__wlim.maxWakePerHour || 12)) {
      // 只打日志，不拦：便于观察高优先级唤醒的占比（豁免桶独立，不吃普通额度）
      log(`[reserved2] 高优先级唤醒放行（${reason}），本小时豁免唤醒 ${wakeBucket.filter((t) => now - t < 3600000).length} 次`);
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheckV2(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    wakeBucket.push(wakeTime);
    if (wakeBucket.length > 200) wakeBucket.splice(0, wakeBucket.length - 200);
    st.wakeHold = null;   // 真的唤醒了，抑制点作废（MARKER: wake-hold）
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSocialV2State();
    const promptText = buildWakePromptV2(key, reason);
    log(`[reserved2] 唤醒 ${key}（${reason}）`);
    let wakeRolledBack = false;
    const rollbackWakeTime = () => {
      // 幂等：两个调用点（投递被拒 / catch 异常）理论上互斥，但若 restoreFiniteSleep
      // 在第一次回滚之后抛错，catch 会再回滚一次，把另一条同毫秒记录也删掉。
      if (wakeRolledBack) return;
      wakeRolledBack = true;
      // 用 push 时捕获的同一个桶，不重新分类；已知限制：靠毫秒时间戳配对，
      // 同一毫秒内两次唤醒会删错记录，属既有隐患，这次不改数据形状。
      const idx = wakeBucket.lastIndexOf(wakeTime);
      if (idx >= 0) wakeBucket.splice(idx, 1);
      saveSocialV2State();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSocialV2State();
          setupSleepTimerV2(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[reserved2] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[reserved2] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSocialV2State();
        setupSleepTimerV2(key);
      }
      log(`[reserved2] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheckV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if ((cancelCooldownUntil.get(key) || 0) > Date.now()) return; // MARKER: cancel-cooldown
    if (socialV2.paused || currentMode !== 'reserved2') return;
    const st = getSocialV2State(key);
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, resolveWakeLimitsV2(key).autoReplyCheckMs);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePromptV2(key, 'replyCheck').catch((error) => log(`[reserved2] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[reserved2] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function isConversationBusyV2(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (sid && (v2TurnStartAt.has(sid) || collectors.has(sid))) return true;
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    // 「按概率随口接一句」原来漏在表外，wakePriorityV2 落在 `?? 0` 分支上，
    // 于是繁忙队列里它永远垫底、队列满时第一个被丢。介于 anyMessage(50) 与
    // replyCheck(40) 之间才是它的真实位置。
    probability: 45,
    replyCheck: 40,
    timeout: 30,
    proactiveCheck: 20,
    // 主动报告比「主动冒泡」重要一点：那是她攒着想跟主人说的话，
    // 但绝不能压过 replyCheck 以上的「有人在跟她说话」。
    share: 35
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriorityV2(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // MARKER: busy-queue
  // 繁忙暂存队列原本有两个真问题（2026-10-21 实测）：
  //   1) 入队/出队都是 FIFO —— 一条低优先级的 probability 排在前面，后面跟进的
  //      @ / 私聊只能排在它后面（实测 08:54–09:01 五条 private 全被暂存）；
  //   2) 只在「turn 正常结束」时出队一次，而队列只存在内存里 ——
  //      桥接十分钟内重启了两次，五条暂存一条都没补发（补发计数=0）。
  // 这里把入队/选队抽成纯函数：按优先级排队、满了先丢最低优先级、出队取最高优先级。
  // 注意：save/load 里用字面量 20 而不是这个常量 —— loadSocialV2State() 在模块初始化时
  // 就会调用 saveSocialV2State()，那时这个 const 还没初始化（TDZ 会直接抛 ReferenceError）。
  const PENDING_WAKE_MAX = 20;
  const PENDING_WAKE_TTL_MS = 30 * 60 * 1000;

  function enqueuePendingWake(st, reason, seq) {
    if (!st) return false;
    if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
    const s = Number(seq) || 0;
    if (st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === s)) return false;
    st.pendingWakeReasons.push({ reason, seq: s, at: Date.now(), pr: wakePriorityV2(reason) });
    if (st.pendingWakeReasons.length > PENDING_WAKE_MAX) {
      // 满了先牺牲优先级最低那条；同优先级丢最早入队的
      let worst = 0;
      for (let i = 1; i < st.pendingWakeReasons.length; i += 1) {
        const cur = st.pendingWakeReasons[i] || {};
        const low = st.pendingWakeReasons[worst] || {};
        const cp = Number(cur.pr) || wakePriorityV2(cur.reason);
        const lp = Number(low.pr) || wakePriorityV2(low.reason);
        if (cp < lp || (cp === lp && Number(cur.at || 0) < Number(low.at || 0))) worst = i;
      }
      st.pendingWakeReasons.splice(worst, 1);
    }
    return true;
  }

  function pickPendingWakeIndex(st) {
    const q = Array.isArray(st?.pendingWakeReasons) ? st.pendingWakeReasons : [];
    if (!q.length) return -1;
    let best = 0;
    for (let i = 1; i < q.length; i += 1) {
      const cur = q[i] || {};
      const top = q[best] || {};
      const cp = Number(cur.pr) || wakePriorityV2(cur.reason);
      const tp = Number(top.pr) || wakePriorityV2(top.reason);
      if (cp > tp || (cp === tp && Number(cur.at || 0) < Number(top.at || 0))) best = i;
    }
    return best;
  }

  // 出队并补发：取最高优先级那条；仍忙就放回去，等下一次 turn 结束或巡检。
  // 保留「已被本回合处理就别补发」的判断，避免同一条消息被回两次。
  function drainPendingWakeFor(key, opts = {}) {
    const st = getSocialV2State(key);
    if (!st || !Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return false;
    const idx = pickPendingWakeIndex(st);
    if (idx < 0) return false;
    const item = st.pendingWakeReasons.splice(idx, 1)[0];
    if (!item || typeof item !== 'object') return false; // 兼容旧字符串残留
    if (!opts.ignoreBusy && isConversationBusyV2(key, st)) {
      st.pendingWakeReasons.push(item);
      return false;
    }
    const stale = item.at && Date.now() - Number(item.at) > PENDING_WAKE_TTL_MS;
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stale || !stillRelevant) {
      log(`[reserved2] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} ${stale ? '已过期' : '已被当前回合处理'}，跳过补发`);
      return false;
    }
    log(`[reserved2] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}（队列剩 ${st.pendingWakeReasons.length} 条）`);
    scheduleWakeV2(key, item.reason, { force: true });
    return true;
  }

  // 巡检：turn 结束时出队依赖「那个 turn 真的正常结束」，
  // 但重启 / 会话被替换 / 回合异常都可能让它永远等不到。这里每 30s 兜一次。
  // MARKER: proactive-reschedule
  // 兜底：档期被 clearSocialV2Timers 清掉后没有任何调用点重排（尤其是 /clear），
  // 会让一个会话长期拿不到主动机会。这里每 30s 巡检一次，只补「既没定时器也没档期」
  // 且确实有过消息的会话。幽灵会话（recentMessages 为空）不补，避免复活该清的会话。
  function ensureProactiveScheduledV2() {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    for (const [key, st] of socialV2.conversations) {
      if (!st) continue;
      if (st.proactiveTimer) continue;
      if (Number(st.proactiveNextAt) > 0) continue;
      if (!Array.isArray(st.recentMessages) || st.recentMessages.length === 0) continue;
      const m = /^(group|private):(\d+)$/.exec(key);
      if (!m) continue;
      if (!proactiveAllowed(key, m[1], Number(m[2]), cfg, currentMode)) continue;
      log(`[reserved2] 主动机会档期缺失，补排 ${key}`);
      scheduleProactiveCheckV2(key);
    }
  }

  function sweepPendingWakeReasons() {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    for (const [key, st] of socialV2.conversations) {
      if (!st || !Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) continue;
      // 先清掉过期的，避免重启后把半小时前的 @ 再补一遍
      st.pendingWakeReasons = st.pendingWakeReasons.filter((r) => {
        if (!r || typeof r !== 'object') return false;
        return !(r.at && Date.now() - Number(r.at) > PENDING_WAKE_TTL_MS);
      });
      if (!st.pendingWakeReasons.length) continue;
      if (isConversationBusyV2(key, st)) {
        // 群里一直有人说话 ⇒ isConversationBusyV2 长期为真，高优先级积压会被永久饿死。
        // 已经等够 120s 就强行补一条（scheduleWakeV2 内部还会各自合并/排队）。
        let top = st.pendingWakeReasons[0];
        for (const x of st.pendingWakeReasons) {
          if ((Number(x?.pr) || 0) > (Number(top?.pr) || 0)) top = x;
        }
        const waited = Date.now() - Number(top?.at || 0);
        if ((Number(top?.pr) || 0) >= 80 && waited > 120_000) {
          log(`[reserved2] ${key} 持续繁忙，高优先级积压已等 ${Math.round(waited / 1000)}s，强行补发一条`);
          drainPendingWakeFor(key, { ignoreBusy: true });
        }
        continue;
      }
      drainPendingWakeFor(key);
    }
    // MARKER: proactive-reschedule —— 巡检末尾顺手补排缺档期的会话。
    ensureProactiveScheduledV2();
    // MARKER: share-signal-tick —— 同一趟巡检里看一眼有没有该跟主人说的事。
    // 不新增定时器（计划要求），每次只做一次 O(信号数) 的判断，有界。
    reportTickV2();
  // MARKER: phone-bridge-tick
  // 扩展离线时每 10 分钟提醒一次（不刷屏）。上线不代表有人装着扩展。
  try {
    if (!phoneBridge.isOnline() && Date.now() - phoneOfflineLoggedAt > 600_000) {
      phoneOfflineLoggedAt = Date.now();
      log('[phone] 浏览器扩展离线：站点请求（B站/小黑盒）暂时发不出去');
    }
  } catch {}

  }

  function scheduleWakeV2(key, reason, opts = {}) {
    if (cfg.socialV2?.enabled === false) return;
    if (socialV2.paused) return;
    // MARKER: cancel-cooldown —— 冷却期内只放过「有人直接找她」的唤醒，其余静默。
    // 否则掐断刚生效，群里任意一条消息又能把她拉起来。
    if (!opts.force && (cancelCooldownUntil.get(key) || 0) > Date.now()) {
      const base = String(reason ?? '').split(':')[0];
      if (!['private', 'atMention'].includes(base)) {
        log(`[reserved2] ${key} 处于掐断冷却期，跳过唤醒（${reason}）`);
        return;
      }
    }
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[reserved2] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSocialV2State(key);
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriorityV2(reason) > wakePriorityV2(cur)) {
        st.pendingWakeReason = reason;
        log(`[reserved2] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (!opts.force && isConversationBusyV2(key, st)) {
      const base0 = String(reason ?? '').split(':')[0];
      // 被 @ / 被私聊 / 被提问 不放积压队列：群聊持续繁忙时它会在 drain 与投递之间反复弹，
      // 实测同一条 seq 进出队 3 次以上、一次都没真正送到。
      if (!['private', 'atMention', 'question'].includes(base0)) {
        const seq = st.lastUnreadSeq || 0;
        enqueuePendingWake(st, reason, seq);
        log(`[reserved2] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，队列 ${st.pendingWakeReasons.length} 条）`);
        return;
      }
      log(`[reserved2] ${key} 繁忙但属高优先级唤醒（${reason}），照常安排推送`);
    }
    cancelReplyCheckV2(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    // MARKER: trigger-seq-real —— 只在「刚建立合并窗口」时记触发 seq：
    // 合并窗口内后续消息属于同一次唤醒的补充，不该覆盖真正的触发点。
    {
      const seqNow = Number(st.lastUnreadSeq);
      if (Number.isSafeInteger(seqNow) && seqNow > 0) wakeTriggerSeq.set(key, seqNow);
    }
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePromptV2(key, finalReason)
        .catch((error) => log(`[reserved2] 计划唤醒异常 ${key}:`, error?.message ?? error))
        .finally(() => { wakeTriggerSeq.delete(key); });
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[reserved2] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  function setupSleepTimerV2(key) {
    if (cfg.socialV2?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSocialV2State(key);
    cancelReplyCheckV2(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (socialV2.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    const until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) {
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等满上限后重新续期，而不是提前唤醒。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimerV2(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[reserved2] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 86400000)} 天后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePromptV2(key, 'timeout').catch((error) => log(`[reserved2] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[reserved2] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheckV2(key) {
    const st = socialV2.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  // MARKER: proactive-limits
  // 原来只有 idleThresholdMs + probability 再乘四个折扣（回话后 ×0.5、夜里 ×0.3、
  // 一小时内发过 5 条 ×0.3）。乘法永远到不了 0，所以深夜照样排档期、刚说完也不停。
  // 参照 ATLES 的 proactive 配置补三个硬闸：
  //   1) 距上次 AI 发言 < minIntervalMs → 0（不是 ×0.5）
  //   2) 近一小时已冒泡 ≥ maxPerHour 次 → 0
  //   3) quietHours（默认 23:00-08:00，支持跨午夜）→ 0（不是 ×0.3）
  function proactiveLimitsCfg() {
    const p = cfg.socialV2?.proactive ?? {};
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    return {
      minIntervalMs: num(p.minIntervalMs, 45 * 60 * 1000),
      maxPerHour: Math.max(1, Math.floor(num(p.maxPerHour, 2))),
      quietHours: p.quietHours === null ? null : (p.quietHours ?? { start: 23, end: 8 }),
      capProbability: Math.min(1, Math.max(0, num(p.capProbability, 0.5)))
    };
  }
  function inQuietHours(hours, date = new Date()) {
    if (!hours) return false;
    const start = Number(hours.start);
    const end = Number(hours.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    const h = date.getHours();
    return start < end ? (h >= start && h < end) : (h >= start || h < end); // 支持 23→8 跨午夜
  }
  // 返 0 = 这一轮不许冒泡；返 >0 = 允许的概率上限
  function proactiveHardCapV2(key, st) {
    const limits = proactiveLimitsCfg();
    if (inQuietHours(limits.quietHours)) return 0;
    const now = Date.now();
    if (st.lastAiReplyAt && now - Number(st.lastAiReplyAt) < limits.minIntervalMs) return 0;
    // MARKER: proactive-cap-by-bubbles —— 这里数的是「主动冒泡次数」，不是「她说过的所有话」。
    // 旧版数 m.isSelf，而 maxPerHour 默认 2 ⇒ 任何活跃群（她正常回话早超 2 条）
    // hardCap 恒为 0，主动冒泡永远不触发；冷清群反倒能冒。闸门方向反了。
    const bubbles = Array.isArray(st.proactiveTimes) ? st.proactiveTimes : [];
    const bubblesLastHour = bubbles.filter((t) => now - Number(t || 0) < 60 * 60 * 1000).length;
    if (bubblesLastHour >= limits.maxPerHour) return 0;
    return limits.capProbability;
  }
  function scheduleProactiveCheckV2(key, opts = {}) {
    if (cfg.socialV2?.proactive?.enabled === false) return;
    if (socialV2.paused || currentMode !== 'reserved2') return;
    // 主动侧比接收侧更严：只对白名单对象冒泡，避免主动去打扰只是"好友"的人。
    {
      const m = /^(group|private):(\d+)$/.exec(key);
      if (!m) return;
      if (!proactiveAllowed(key, m[1], Number(m[2]), cfg, currentMode)) return;
    }
    const st = getSocialV2State(key);
    if (st.proactiveTimer) return;
    const p = cfg.socialV2?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    // MARKER: proactive-persist
    // 档期落盘：旧实现重启就重抽随机，等于每次重启都白等一轮
    // （今天 08:52、09:01 两次重启，group:910502749 的档期被推成 78min / 96min）。
    const storedNextAt = Number(st.proactiveNextAt) || 0;
    const nowMs = Date.now();
    let delay;
    if (storedNextAt > nowMs + 1000) {
      // 续档，但最多续 max 的两倍，避免一个过期的远档把检查推太远
      delay = Math.min(storedNextAt - nowMs, max * 2);
    } else {
      delay = Math.floor(min + Math.random() * (max - min));
      // MARKER: urge-pacing —— 固定 [min,max] 随机换成乘法模型：
      //   间隔 = 基础间隔 / (对话密度因子 × 生活节奏因子)
      // 热闹时更勤、深夜/久无人语时更懒。夹在 [minDelayMs, base×4] 之间，
      // 前面那道 proactiveHardCapV2 仍然在最外层把关，这里只决定「多久看一次」。
      const baseDelay = delay;
      const urge = urgeDelay({
        baseMs: baseDelay,
        recentMessages: st.recentMessages,
        lastIncomingAt: st.lastIncomingAt,
        now: nowMs,
        attention: lifeAttentionNow(nowMs),
        cfg: pacingCfg(cfg)
      });
      delay = urge.delay;
      if (baseDelay > 0 && Math.abs(urge.delay - baseDelay) / baseDelay > 0.2) {
        log(`[urge] ${key} 主动间隔 ${Math.round(urge.delay / 60000)}min（密度 ${urge.density} × ${urge.rhythm} ${urge.multiplier}，基准 ${Math.round(baseDelay / 60000)}min）`);
      }
    }
    st.proactiveNextAt = nowMs + delay;
    if (!opts.skipSave) saveSocialV2State();
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      st.proactiveNextAt = 0;
      ensureWakeableV2(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      // MARKER: proactive-limits-apply —— 硬闸放在四个乘法折扣之后，
      // 0 就是 0，不会被任何公式抬回来。
      const hardCap = proactiveHardCapV2(key, st);
      if (hardCap <= 0) {
        log(`[reserved2] proactive 跳过 ${key}（安静时段/刚说过/本小时已到上限）`);
      } else {
        prob = Math.min(prob, hardCap);
      }
      if (hardCap > 0 && idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
        // MARKER: proactive-cap-by-bubbles —— 冒泡真正发起时才记一次，供硬闸统计。
        if (!Array.isArray(st.proactiveTimes)) st.proactiveTimes = [];
        st.proactiveTimes.push(Date.now());
        if (st.proactiveTimes.length > 200) st.proactiveTimes = st.proactiveTimes.slice(-200);
        saveSocialV2State();
        void sendWakePromptV2(key, 'proactiveCheck').catch((error) => log(`[reserved2] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheckV2(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[reserved2] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSocialV2Timers(key) {
    const st = socialV2.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
    // 定时器被清掉后档期也该清：否则下次启动会按一个已经作废的旧档期续期
    st.proactiveNextAt = 0;
  }

  function clearAllSocialV2Timers() {
    for (const key of socialV2.conversations.keys()) clearSocialV2Timers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      // 刚通过好友申请的人会撞上好友列表的刷新窗口期：这里立刻补拉一次，
      // 让下一条消息能过。本条仍然丢弃（fail-closed，不放行身份未确认的人）。
      if (kind === 'private' && cfg.friendOnly === true && typeof friendRefreshNow === 'function') {
        Promise.resolve()
          .then(() => friendRefreshNow('非好友消息触发'))
          .catch((error) => log(`[friendOnly] 补拉好友列表失败：${error?.message ?? error}`));
      }
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    const textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    const plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    // MARKER: share-owner-reply
    // 主人在私聊里说话 = 他回应了之前的报告，也等于「他不理我」这个暂停理由
    // 不成立了。这是解除暂停的唯一入口。
    if (kind === 'private' && isOwner && plainContent) {
      try { noteOwnerReplyToShare(); } catch (error) { log(`[share] 记主人回应失败：${error?.message ?? error}`); }
    }
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // MARKER: image-approval-consume
    // 主人在私聊里回「通过 / 拒绝」= 处置一条生图申请。
    // 放在 DSH 挂起问答之后：那边有挂起时先让那边的「通过」生效，别抢。
    if (isOwner && plainContent) {
      try {
        if (tryConsumeImageApprovalReply(key, plainContent)) return;
      } catch (error) {
        log(`[imgapprove] 处理主人审批回话失败：${error?.message ?? error}`);
      }
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      appendActivity(`${key}（群友角色指令已忽略）${event.user_id}：${plainContent.slice(0, 40)}`);
      return;
    }

    // MARKER: status-cmd-admin
    // `#sl` 原本由 SnowLuma 网关自带（谁发都回，会泄漏版本号/运行时长给群友）。
    // 2026-10-27 起网关侧 socialV2 以外的地方关掉（onebot_<uin>.json 的
    // statusCommand.enabled=false），改由桥接接管：只有管理员能用，群友发就当没看见。
    if (String(plainContent ?? '').trim().toLowerCase() === '#sl') {
      if (!isOwner) {
        appendActivity(`${key}（群友状态命令已忽略）${event.user_id}：${plainContent.slice(0, 40)}`);
        return;
      }
      try {
        const [vs, st] = await Promise.all([
          bot.raw('get_version_info').catch(() => null),
          bot.raw('get_status').catch(() => null)
        ]);
        const ver = String(vs?.data?.app_version ?? vs?.app_version ?? '').replace(/-node$/, '');
        const online = st?.data?.online ?? st?.online;
        const good = st?.data?.good ?? st?.good;
        const sec = Number(st?.data?.time ?? st?.time ?? 0);
        const fmtUp = (ms) => {
          const t = Math.max(0, Math.floor(ms / 1000));
          const d = Math.floor(t / 86400);
          const h = Math.floor((t % 86400) / 3600);
          const mi = Math.floor((t % 3600) / 60);
          const s = t % 60;
          if (d > 0) return `${d}天 ${h}小时 ${mi}分钟`;
          if (h > 0) return `${h}小时 ${mi}分钟`;
          if (mi > 0) return `${mi}分钟 ${s}秒`;
          return `${s}秒`;
        };
        const rows = [
          'SnowLuma 状态',
          `版本: ${ver || '未知'}`,
          '平台: linux-x64',
          `运行时长: ${sec > 0 ? fmtUp(sec * 1000) : '未知'}`,
          `账号: ${online ? '在线' : '离线'}${good === false ? '（链路异常）' : ''}`,
          `桥接: 已运行 ${fmtUp(Math.floor(process.uptime() * 1000))}`
        ];
        await sendToQQ(key, rows.join('\n'));
      } catch (error) {
        log(`[status-cmd] 读取网关状态失败：${error?.message ?? error}`);
        await sendToQQ(key, `读取状态失败：${error?.message ?? error}`);
      }
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        appendActivity(`${key}（群友命令已忽略）${event.user_id}：${plainContent.slice(0, 40)}`);
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          delete state.sessions[key];
          modelAppliedSessions.delete(old);
          delete state.sessionPolicies[key];
          reverse.delete(old);
          collectors.delete(old);
          sendToolSucceededSessions.delete(old);
          pendingSendToolCalls.delete(old);
          v2TurnStartAt.delete(old);
          toolCallNames.delete(old);
          social.silentTurns.delete(old);
          social.exitingSessions.delete(old);
          const pe = pending.get(key);
          if (pe) {
            clearTimeout(pe.timer);
            cancelPendingEntry(pe).catch(() => {});
          }
          pending.delete(key);
          queued.delete(key);
          queuedHintAt.delete(key);
          sessionPromises.delete(key);
          drainPromptQueue(key, '会话已重置');
          social.recentMessages.delete(key);
          messageMediaStore.delete(key);
          social.pendingSummaries.delete(key);
          social.states.delete(key);
          social.silentContext.delete(key);
          slangWindows.delete(key);
          slangExtractionCooldowns.delete(key);
          slangSubmitTimes.delete(key);
          cancelSocialTimers(key);
          clearSocialV2Timers(key);
          pendingWakeKeys.delete(key);
          wakeConfigUpdatedKeys.delete(key);
          markReadCalledKeys.delete(key);
          wakeConfigMissCount.delete(key);
          forgetAgentToken(key);
          socialV2.conversations.delete(key);
          seenForwardIds.delete(key);
          saveSocialV2State();
          saveState();
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await api.stopSessionWork(old); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await api.workspace.archiveSession({ sessionId: old }); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          writeRoleState(null, roleState.mode);
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'roles', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 qq-bridge/roles/ 目录。`);
          } else {
            writeRoleState(name, roleState.mode);
            await sendToQQ(key, `已切换角色：${name}。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 二代仿真模式（reserved2）：唤醒调度
    if (currentMode === 'reserved2') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendSocialV2Message(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []));
      // 二代同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent, event);
      if (socialV2.paused) {
        appendActivity(`${key} [reserved2] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSocialV2State(key);
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSocialV2State();
        scheduleWakeV2(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        // MARKER: willingness-gate —— 意愿门。reason 为 null 时也可能被放行
        // （她攒够了想主动插话），所以这一步也必须每条消息都过。
        const willing = applyWillingnessV2(key, st, reason, {
          messageCount: recentBurstCount(st),
          content: plainContent,
          quotedBot: Boolean(quoteTargetIsSelf)
        });
        // MARKER: skip-jitter —— 每条消息都要过闸（既计数也判定），
        // 所以不能只在 reason 有值时才调。
        const gated = applySkipJitterV2(key, st, willing);
        if (gated) {
          scheduleWakeV2(key, gated);
        }
      }
      appendActivity(`${key} [reserved2] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent, event);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        // MARKER: restart-hint-admin-only —— 2026-10-26
        // 原来这条直接 sendToQQ(key)，群友也看得见「系统服务重启中，消息已排队」。
        // 桥接自己的运行状态属于内部技术信息，只该让主人知道；群里发这个
        // 既没用又掉人设（用户 m04087：「这个话也不要发到群里来了」）。
        // 与「⚠️ 消息未被接受」「⏹️ 回合已中止」保持同一套做法。
        await notifyAdminOnly('⏳ 系统服务重启中，消息已排队', '恢复后自动处理', key);
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      // MARKER: vision-bridge
      // 当前模型不吃图就把图说成文字再投 —— 否则整条消息会被
      // session/attachment-invalid（does not support image input）拒绝，她一个字都收不到。
      const bridged = await transcodeImagesForTextModel(imageParts);
      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...bridged];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      // MARKER: err-to-admin
      await notifyAdminOnly('⚠️ 消息未被接受', safeErrText, key);
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'reserved2') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 二代拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'reserved2') {
      appendActivity(`${key} 收到拍一拍事件（非 reserved2，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSocialV2Poke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'reserved2') return;
    if (socialV2.paused) return;
    // MARKER: poke-target
    // 只有「拍她本人」才唤醒。旧实现只看 triggers.poke，不看 target —— 群友互拍
    // 也会把她叫起来（实测 poke 把群聊每小时 8 次唤醒额度吃光，真正 @ 她时反而被限流跳过）。
    // 私聊没有 target_id 时按拍摄她处理：私聊里的拍一拍天然指向对方。
    const pokedMe = targetIsSelf || (kind === 'private' && !targetId);
    const st = getSocialV2State(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSocialV2State();
      scheduleWakeV2(key, 'bootstrap');
    } else if (!pokedMe) {
      // 拍的是别人：事件已经进消息流供她参考，但不唤醒、不烧额度。
      log(`[reserved2] 拍一拍目标不是她（${senderId} -> ${targetId}），只记录不唤醒 ${key}`);
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWakeV2(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ
  async function pumpMux() {
    for (;;) {
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                const learnerCollector = learnerCollectors.get(frame.sessionId) ?? createTurnCollector();
                learnerCollectors.set(frame.sessionId, learnerCollector);
                const learnerEnded = learnerCollector.push(frame.event);
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  // MARKER: learner-empty-retry
                  // 「completed 但一个字都没输出」是这条学习通道最常见的失败形态
                  // （模型把正文吞了、或上游提前收尾）。旧代码当彻底失败，
                  // 视觉/黑话/结算三处一起漏。现在原地补一句、重试一次，仍空才算真失败。
                  const outcome = learnerOutcome({
                    kind: learnerEnded.reason.kind,
                    text: learnerEnded.text,
                    retried: waiter?.emptyRetried === true
                  });
                  let retriedNow = false;
                  if (waiter && outcome.action === 'retry') {
                    waiter.emptyRetried = true;
                    retriedNow = true;
                    learnerCollectors.set(frame.sessionId, createTurnCollector());
                    const retryList = learnerWaiters.get(frame.sessionId) ?? [];
                    retryList.unshift(waiter);
                    learnerWaiters.set(frame.sessionId, retryList);
                    log(`[learner] 学习会话空回复，补一句重试一次：${frame.sessionId}`);
                    Promise.resolve()
                      .then(() => api.sessions.prompt({
                        sessionId: frame.sessionId,
                        mode: 'queue',
                        content: [{ type: 'text', text: LEARNER_RETRY_NUDGE }]
                      }))
                      .catch((retryError) => {
                        const list = learnerWaiters.get(frame.sessionId) ?? [];
                        const idx = list.findIndex((w) => w === waiter);
                        if (idx >= 0) list.splice(idx, 1);
                        if (list.length === 0) learnerWaiters.delete(frame.sessionId);
                        clearTimeout(waiter.timer);
                        waiter.reject(new Error(`学习会话重试失败：${retryError?.message ?? retryError}`));
                      });
                  } else if (waiter) {
                    clearTimeout(waiter.timer);
                    if (outcome.action === 'resolve') waiter.resolve(outcome.text);
                    else waiter.reject(new Error(`学习会话 turn 未正常完成：${outcome.reason}`));
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留（正在重试的那个除外）
                  if (!retriedNow && frame.sessionId !== slangLearnerSessionId && frame.sessionId !== slangResearchSessionId && !isVisionSession(frame.sessionId) && !isSettleSession(frame.sessionId)) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              v2TurnStartAt.set(frame.sessionId, Date.now());
              turnBudgetLedger.set(frame.sessionId, { startedAt: Date.now(), steps: 0, sends: 0, cancelled: false, reason: '' });
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    sendToolSucceededSessions.add(frame.sessionId);
                  }
                }
              }
            }
            // MARKER: turn-budget-step
            if (frame.event.type === 'tool/result') noteTurnBudgetStep(key, frame.sessionId);
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
            if (ended) {
              autoRememberFromTurn(key, ended.userText);
              // reserved2 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'reserved2' && key && !isSilentTurn) {
                const st = getSocialV2State(key);
                const turnStart = v2TurnStartAt.get(frame.sessionId) ?? 0;
                const actionTaken = sendToolSucceededSessions.has(frame.sessionId) || (turnStart > 0 && st.lastActionAt >= turnStart);
                if (actionTaken) {
                  st.wakeConfig.noActionCount = 0;
                } else {
                  st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                  const limit = Number(cfg.socialV2?.wake?.noActionLimit) || 3;
                  if (st.wakeConfig.noActionCount >= limit) {
                    log(`[reserved2] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                    st.wakeConfig = defaultWakeConfigV2();
                    st.bootstrapSent = true;
                    st.wakeConfig.noActionCount = 0;
                  }
                }
                saveSocialV2State();
              }
              v2TurnStartAt.delete(frame.sessionId);
              // 回合收工就交还生图额度：这一轮已经结束，不该被下一轮借用。
              // 生图闸门「跟着回合走」靠的就是这一行（另见 imageAllowedNow）。
              if (endActiveTurnCtx(key)) {
                log(`[image] 收回额度（${key}）`);
                // 回合收工不等于「立刻不许画」：她可能正处在收尾阶段才想起要图。
                // 真正的安全闸是 imageSceneFor（主人确实 @ 过），这里只是怕跨轮借用。
                // reason 必须一起存：宽限分支要拿它判 byMention。
                globalThis.__qqTurnContextEnded = endedTurnCtx(key);
              }
              { // MARKER: turn-budget-end
                const budget = turnBudgetLedger.get(frame.sessionId);
                if (budget) {
                  const elapsedSec = Math.round((Date.now() - budget.startedAt) / 1000);
                  if (!budget.cancelled) writeGraceNote(key, null);
                  if (elapsedSec >= 300 || budget.steps >= 30 || budget.cancelled) {
                    log(`[turn-budget] ${key} 回合 ${elapsedSec}s / ${budget.steps} 步 / ${budget.sends} 条${budget.cancelled ? `（已中止：${budget.reason}）` : ''}`);
                  }
                  turnBudgetLedger.delete(frame.sessionId);
                }
              }
              // MARKER: settle-trigger —— 回合收工后过一会儿结算这一轮：
              // 她的情绪走向、对谁多了什么印象。放在回合之外做，所以不占她聊天中的工具调用。
              try {
                scheduleSettle(key);
              } catch (error) {
                log(`[settle] 排队失败：${error?.message ?? error}`);
              }
              collectors.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // reserved2 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeableV2(getSocialV2State(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.socialV2?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPromptV2(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[reserved2] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[reserved2] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSocialV2State(key);
                    st.wakeConfig = defaultWakeConfigV2();
                    saveSocialV2State();
                    log(`[reserved2] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次，取**最高优先级**那条。
              // 已被本回合处理（unread 里没有该 seq）则跳过，避免重复回复。
              drainPendingWakeFor(key, { ignoreBusy: true });
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'reserved2') {
                  log(`[reserved2] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [reserved2] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                // 必须同时进 stdout：switch-provider.sh 靠日志关键词统计失败，
                // 只发 QQ 的话它在日志里什么都看不到，自动兜底永远不会触发。
                log(`agent 处理出错 (${key}): ${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 200)}`);
                // MARKER: err-private-only
                // ⚠️ 2026-10-21 修复：这里原来是无条件 `sendToQQ(key, ...)`，
                // 群聊会话时会把内部错误原文直接发进群（实测 08:02–08:07 连发 5 次
                // "buddy: 请求被拦截…Illegal API invocation from an unapproved channel"）。
                // 那既泄露上游渠道与内部报错路径，也让群友看到一条英文报错。
                //
                // 现在：群聊只记日志；诊断信息只发给管理员私聊。
                // 注意 sendToQQ 内部自带 .catch（只记日志、不抛错），
                // 所以「发私聊失败」不会反向触发本分支，不存在递归。
                // MARKER: upstream-blip-throttle
                // 502/521/522 这类「网关在前面挡了一下」实测六秒后就自愈（2026-10-29 11:27:15 / 11:27:21），
                // 每条都发到主人私聊只是打扰；但也不能瞒 —— 同一窗口第 3 次会升级成一条「它在持续」。
                const blip = upstreamBlips.hit(key, safeMsg, Date.now());
                if (blip.escalate) {
                  log(`[upstream] ${key} 网关抖动 ${blip.quietMin} 分钟内第 ${blip.count} 次（升级提醒主人）`);
                }
                if (!blip.notify) {
                  log(`[upstream] ${key} 网关临时故障（${blip.quietMin} 分钟内第 ${blip.count} 次，已静默）：${safeMsg.slice(0, 80)}`);
                  appendActivity(`${key} 网关临时故障（第 ${blip.count} 次，已静默）`);
                } else try {
                  const ownerKey = cfg.ownerQQ ? `private:${String(cfg.ownerQQ)}` : '';
                  if (!ownerKey) {
                    log('⚠️ 未配置 ownerQQ：agent 错误无法发送给管理员，仅记录日志');
                  } else if (key === ownerKey) {
                    // 私聊本身就是管理员：照常发给他，但不重复抄送
                    await sendToQQ(key, `⚠️ agent 处理出错：${safeMsg}`);
                  } else {
                    // 群聊或他人私聊：只把诊断发给管理员，当前会话一个字都不发
                    await sendToQQ(ownerKey, `⚠️ agent 处理出错（${key}）：${safeMsg}`);
                  }
                } catch (notifyError) {
                  // 双保险：即使 notify 内部抛错，也绝不能让它污染主流程
                  log(`agent 错误通知发送失败（已忽略）：${notifyError?.message ?? notifyError}`);
                }
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                // MARKER: abort-notice-admin-only
                // 原来是无条件把「⏹️ 已停止」发到当前会话。回合因预算超标被掐时也会走到这里，
                // 群友只看到一条没头没尾的「已停止」（实测 2026-10-25 一天 22 次）。
                // 现在：会话侧一个字都不发，只记日志 + 抄送管理员私聊，并带上真实原因。
                const abortWhy = abortReasonByKey.get(key) || '';
                abortReasonByKey.delete(key);
                await notifyAdminOnly('⏹️ 回合已中止', abortWhy || '被中止（原因未知）', key);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            // MARKER: corrupt-stream-retire —— 2026-10-27
            // 会话日志损坏时 DSH 永远读不出来，本地映射必须立刻退役重建；
            // 否则每条消息都对着同一个坏会话重试，失败一次就推一条「消息未被接受」给管理员。
            const errMsg = String(frame.error?.message ?? '');
            if (sessionLogCorrupt(errMsg)) {
              const badKey = reverse.get(frame.sessionId);
              log(`会话流报会话日志损坏，退役并重建：${frame.sessionId}${badKey ? `（${badKey}）` : ''}`);
              if (badKey) retireSession(badKey);
              else {
                modelAppliedSessions.set(frame.sessionId, modelSelectionEpoch);
                api.events.forget?.(frame.sessionId);
              }
            } else {
              log('事件流错误:', frame.error);
            }
          }
        }
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        v2TurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      await sleep(3000);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  // ── 好友列表定时刷新（供 friendOnly「仅好友」档位使用）────────────────────
  // 独立于 WebSocket 连接状态：即使 QQ 暂时掉线，也只影响下次刷新，
  // friendSet 保留上一次成功的结果（避免瞬时网络抖动把"仅好友"变成"谁都不理"）。
  {
    // 去抖：事件侧的「刚加好友」补拉与定时刷新共用这一把闸，避免并发重复请求。
    // 定时刷新会把 friendRefreshPending 归零，所以正常周期刷新不受影响。
    let friendRefreshPending = false;
    let friendRefreshAt = 0;
    // MARKER: friend-refresh-timeout —— 2026-10-26
    // 惨案：`friendRefreshPending` 只是个布尔闸，一旦 `bot.request` 里的
    // `await this.connect()` 挂住（SDK 的 connectPromise 共享，WS 起不来时那个 promise
    // 可能既不 resolve 也不 reject，而 request 的超时计时器是**在 connect 之后**才装的），
    // 这个闸就永久卡在 true —— 之后每一次定时刷新都 `return` 掉。
    // 后果：friendSetReady 永远是 false，friendOnly 档位下私聊全部被拒（含主人）。
    // 两个补丁：① 闸卡住超过 45 秒就当它废了、强制放行下一轮；
    //          ② 显式给 request 传 timeoutMs，别依赖 SDK 默认值。
    const FRIEND_REFRESH_STUCK_MS = 45 * 1000;
    const FRIEND_REQUEST_TIMEOUT_MS = 20 * 1000;
    const refreshFriends = async (reason = '定时') => {
      const stuckFor = Date.now() - friendRefreshAt;
      if (friendRefreshPending) {
        if (stuckFor < FRIEND_REFRESH_STUCK_MS) return;
        log(`[friendOnly] 上一轮刷新已卡住 ${Math.round(stuckFor / 1000)}s，强制重置闸门（${reason}）`);
      }
      friendRefreshPending = true;
      friendRefreshAt = Date.now();
      try {
        const data = await bot.request('get_friend_list', {}, { timeoutMs: FRIEND_REQUEST_TIMEOUT_MS });
        const list = Array.isArray(data) ? data
          : (Array.isArray(data?.data) ? data.data : []);
        rememberFriendNames(list);  // MARKER: image-approval-friendnames
        const next = new Set(list.map((f) => String(f?.user_id ?? '')).filter(Boolean));
        if (next.size > 0 || friendSet.size === 0) {
          friendSet = next;
          friendSetAt = Date.now();
          friendSetReady = true;
          log(`[friendOnly] 好友列表已刷新：${next.size} 个好友`);
        } else {
          log(`[friendOnly] 好友列表返回空，保留上次结果（${friendSet.size} 个）`);
        }
      } catch (error) {
        log(`[friendOnly] 好友列表刷新失败：${error?.message ?? error}`);
      } finally {
        friendRefreshPending = false;
        friendRefreshAt = 0;
      }
    };
    // 暴露给 handleIncoming：命中「非好友」时立刻补拉一次
    friendRefreshNow = refreshFriends;
    setTimeout(refreshFriends, 5000).unref?.();
    setInterval(refreshFriends, FRIEND_REFRESH_MS).unref?.();
  }

  bot.onPrivateMessage(async (event) => {
    if (event.user_id === event.self_id) return;
    try { await handleIncoming('private', event.user_id, event, cfg); } catch (error) { log('处理私聊消息出错:', error?.message ?? error); }
  });
  bot.onGroupMessage(async (event) => {
    if (event.sender?.user_id === event.self_id || event.user_id === event.self_id) return;
    try { await handleIncoming('group', event.group_id, event, cfg); } catch (error) { log('处理群消息出错:', error?.message ?? error); }
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    bot.getLoginInfo().then((login) => {
      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
      // MARKER: self-user-id —— 记下自己的 QQ 号，供 proactiveAllowed 拒绝「对自己主动」。
      if (login?.user_id != null && String(login.user_id).trim()) {
        selfUserId = String(login.user_id).trim();
      }
    }).catch(() => {});
    // MARKER: bot-mutex-warmup —— 启动/重连时把所有在白名单里的群都预热一遍机器人名单，
    // 免得第一次收到机器人消息时缓存还没建立、白白醒一次。
    setImmediate(() => {
      try {
        const groups = new Set();
        for (const g of cfg.allow?.groups ?? []) if (g != null) groups.add(String(g));
        for (const rel of (socialV2?.conversations?.keys?.() ?? [])) {
          const k = String(rel);
          if (k.startsWith('group:')) groups.add(k.slice(6));
        }
        for (const gid of groups) refreshGroupBotIds(gid);
        if (groups.size) log(`[bot-mutex] 预热 ${groups.size} 个群的机器人名单`);
      } catch (error) { log('[bot-mutex] 预热失败：', error?.message ?? error); }
    });
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      // ⚠️ 这里**不能**写成 `try { bot.connect(); } catch {}`：
      //   · `connect()` 是 async，同步 try/catch 抓不到它的 rejection，只会变成
      //     unhandledRejection（被全局兜底吞掉，日志里只剩「重连中…」）；
      //   · 更糟的是 `close()` 会先把 SDK 的 `closedByUser` 置 true，只有
      //     `connect()` 能把它清回 false。一旦 connect 这一步失败，SDK 内部的
      //     自动重连逻辑从此永久停摆 —— 这正是「WS 断了必须人工 restart」的根因。
      // 所以必须显式接住失败，并在失败后交给看门狗（wsWatchdog）兜底重连。
      bot.connect().catch((error) => {
        snowlumaHealth.lastConnectError = error?.message ?? String(error);
        snowlumaHealth.lastConnectErrorAt = Date.now();
        log(`⚠️ WS 热切换重连失败（${snowlumaHealth.lastConnectError}），交给看门狗兜底`);
      });
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      if (r.updated) log(`🔄 已把当前 token 写回 config.json（${String(r.from).slice(0, 4)}… → ${String(r.to).slice(0, 4)}…）`);
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => log('SnowLuma 错误:', error));

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  // WS 看门狗：SDK 自己重连失效时的兜底（根因见 startWsWatchdog 的注释）。
  // 传取值器而不是 bot 本身，避免任何 TDZ 风险。
  startWsWatchdog(() => bot);
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.socialV2?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  // stateDirHardened 是 main() 里的 let，模块要读**和写**它（否则控制台显示旧状态）。
  // 布尔是值传递，只能交一对访问器，不能交变量本身。
  Object.assign(moduleCtx, {
    getStateDirHardened: () => stateDirHardened,
    setStateDirHardened: (v) => { stateDirHardened = v; },
  });
  // MARKER: modules-ctx-fns
  // 模块**禁止** import bridge.js（会触发第二次 main()，循环 import）。
  // 主文件里的函数一律从这里显式交付。注意只交**无状态、无副作用**的纯工具。
  // unwrap 是 import 进来的纯工具（来自 dsh-client），模块要在 setup 里拿它。
  Object.assign(moduleCtx, {
    unwrap,
    readRoleState,   // 读角色状态（role/mode），文件级函数，不依赖 main() 闭包
    writeRoleState,  // 写角色状态
    roleSummaries,   // 人格清单摘要
    sanitizeRoleName, // 人格名净化（文件级纯函数）
    // 「roles/<名字>.md 存在吗」——模块不该自己拼 ROOT，交给主文件判断。
    rolesDirExists: (name) => fs.existsSync(path.join(ROOT, 'roles', name + '.md')),
    hardenStateDirAcl,   // state/ ACL 收紧（会写 stateDirHardened，配合上面那对访问器）
    manualDirCommand,    // state-acl 提供的安全版手工命令
    readConfigObject,    // 读 config.json 为对象
    atomicWriteJson,     // 原子写 JSON
    configFile: path.join(ROOT, 'config.json'),
  });
  // MARKER: vision-ctx
  // message-image 模块要用它把图换成文字（模块禁止 import bridge.js）。
  Object.assign(moduleCtx, {
    currentModelSeesImages,
    transcribeMediaImages,
  });
  startDshWatch();
  startSnowlumaWatch();
  startConsoleServer();
  // ── 功能模块装载（阶段 1：骨架） ────────────────────────────────────────
  // MARKER: mute-aware-init
  // 重启后 mutedUntilByGroup 是空的，与其等第一次发送失败再学，不如启动时把
  // 白名单里的群都问一遍 get_group_member_info。失败/超时都当没禁言。
  void (async () => {
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const groups = Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [];
    for (const gid of groups) {
      try {
        const mutedUntil = await probeGroupMute(gid);
        if (mutedUntil > 0) {
          mutedUntilByGroup.set(String(gid), mutedUntil);
          const until = new Date(mutedUntil).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
          log(`[mute-aware] group:${gid} 当前处于禁言，到 ${until} 解禁，期间跳过唤醒`);
        }
      } catch {}
    }
  })();
  // MARKER: sticker-sightings-init
  // 观测层启动即装载，与模块装配无关（模块全关也不影响它）。
  if (cfg.socialV2?.sticker?.sightings?.enabled !== false) {
    try {
      const sightCount = initSightings(STATE_DIR, cfg.socialV2?.sticker?.sightings ?? {});
      log(`[sticker-sightings] 观测层已启用，已记录 ${sightCount} 张图`);
    } catch (error) {
      log('[sticker-sightings] 装载失败（已跳过）：', error?.message ?? error);
    }
  }

  // MARKER: modules-loader
  //
  // 只装载一次、只装载声明了的模块。空清单也要建 host：`/api/_modules` 靠它回答
  // 「装载器是否在工作」。单个模块的装载异常在 host 内部被兜住并记进 problems，
  // 不会冒到这里 —— 一个模块写坏了不该让桥接起不来。
  //
  // `cfg.socialV2.modules.enabled === false` 时不装载（回退开关），
  // moduleHost 保持 null → 请求回调里那段委派整段跳过。
  if (cfg.socialV2?.modules?.enabled !== false) {
    try {
      moduleHost = createModuleHost({
        // 注意：sendJson / readBody **不能**放进 ctx。
        // 它们是请求回调里的局部变量（`src/bridge.js` 内 `const sendJson = ...`），
        // main() 作用域里根本不存在 —— 第一版写进来直接 ReferenceError，
        // 装载整个失败。模块需要它们时从 handler 的第一个参数取
        // （委派时传的是 { req, res, url, sendJson, readBody }）。
        // 与模块共用同一个 ctx 对象（bridge.js 逐步 Object.assign 灌满）
        ctx: moduleCtx,
        log: (message) => log(message),
        onError: (mod, phase, error) => log(`[modules] ${phase} 失败 ${mod?.name ?? "?"}：${error?.message ?? error}`),
      });
      await moduleHost.load(defineModules(moduleCtx));
      log(`[modules] 装载完成：${moduleHost.loaded.length} 个模块 / ${moduleHost.describe().routes.length} 条路由`);
    } catch (error) {
      moduleHost = null;
      log('[modules] 装载失败，已降级为无模块：', error?.message ?? error);
    }
  }

  // MARKER: fix2bugs
  // 启动后补一次黑话研究。为什么不能只靠「提取后」触发：
  // 实测 21:37 那次是「未发现候选」，之后没有新提取 ⇒ 补偿永远等不到机会。
  // 延迟 30 秒，等 DSH 与学习会话就绪，避免启动瞬间抢会话资源。
  setTimeout(() => {
    try { sweepUnresearchedSlang({ reason: '启动补偿' }); } catch (error) {
      log('启动补偿扫描异常:', error?.message ?? error);
    }
  }, 30000);

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 start.bat 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
