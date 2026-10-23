/**
 * 鲸鱼刷站助手 —— 后台服务脚本
 *
 * 干的活：长期轮询服务器，领到「请求某个 URL」的活，去 fetch，把
 * **只用响应体**回传。整个过程不碰 document.cookie，也不读 chrome.cookies，
 * 所以它永远不知道你登录没登录 —— 服务器那边也因此不可能拿到登录态。
 *
 * 为什么要它：服务器（阿里云）的 IP 被 B 站风控了。
 *   x/web-interface/view  → -412 request was banned
 *   x/v2/reply           → 被重定向成 HTML
 * 同一个请求从本机发出是 200。所以请求必须借这台机器的 IP 发。
 */

const DEFAULT_ENDPOINT = 'http://121.40.52.115:3100';
const POLL_WAIT_MS = 20000;
const HEARTBEAT_ALARM = 'whale-browse-heartbeat';

/** 运行状态，popup 里显示。 */
const state = {
  running: false,
  endpoint: '',
  token: '',
  lastPollAt: 0,
  lastTaskAt: 0,
  lastError: '',
  doneCount: 0,
  failCount: 0
};

async function loadConfig() {
  const got = await chrome.storage.local.get(['endpoint', 'token', 'enabled']);
  state.endpoint = String(got.endpoint ?? DEFAULT_ENDPOINT).replace(/\/+$/, '');
  state.token = String(got.token ?? '');
  return got.enabled !== false;
}

async function setState(patch) {
  Object.assign(state, patch);
  try {
    await chrome.storage.local.set({ _state: { ...state } });
  } catch {
    /* 忽略 */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 领任务。长轮询，服务器最多挂 20 秒。 */
async function pollOnce() {
  const url = `${state.endpoint}/api/phone/poll`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-phone-token': state.token
    },
    body: '{}'
  });
  if (res.status === 401) throw new Error('令牌不对（服务器返回 401）');
  if (!res.ok) throw new Error(`poll 失败 HTTP ${res.status}`);
  const json = await res.json();
  return json?.task ?? null;
}

/** 执行一个任务并回传。 */
async function runTask(task) {
  let payload;
  try {
    const init = {
      method: task.method || 'GET',
      // 关键：不写 credentials:'include'，也完全不碰 cookie
      credentials: 'omit',
      headers: task.headers || {}
    };
    if (init.method === 'POST' && task.body != null) init.body = task.body;

    const res = await fetch(task.url, init);
    const text = await res.text();
    payload = {
      id: task.id,
      status: res.status,
      body: text.slice(0, 2 * 1024 * 1024),
      headers: {
        'content-type': res.headers.get('content-type') || ''
      }
    };
  } catch (err) {
    payload = { id: task.id, error: String(err?.message ?? err).slice(0, 300) };
  }

  await fetch(`${state.endpoint}/api/phone/result`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-phone-token': state.token
    },
    body: JSON.stringify(payload)
  }).catch(() => {});

  if (payload.error) {
    await setState({ failCount: state.failCount + 1, lastError: payload.error });
  } else {
    await setState({ doneCount: state.doneCount + 1, lastError: '' });
  }
}

/** 主循环：死循环长轮询。Service Worker 被回收后由 alarm 唤醒重启。 */
async function loop() {
  if (state.running) return;
  state.running = true;
  await setState({ running: true });

  const enabled = await loadConfig();
  if (!enabled) {
    await setState({ running: false });
    return;
  }

  while (true) {
    const stillEnabled = await loadConfig();
    if (!stillEnabled) break;

    try {
      await setState({ lastPollAt: Date.now() });
      const task = await pollOnce();
      if (task) {
        await setState({ lastTaskAt: Date.now() });
        runTask(task); // 不等它，立刻回去领下一个
      }
    } catch (err) {
      const msg = String(err?.message ?? err);
      await setState({ lastError: msg.slice(0, 200) });
      // 服务器不可达时退避，别把 CPU 打满
      await sleep(3000);
    }
  }

  await setState({ running: false });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  loop();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  loop();
});

function ensureAlarm() {
  chrome.alarms.get(HEARTBEAT_ALARM, (a) => {
    if (!a) chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== HEARTBEAT_ALARM) return;
  // Service Worker 活过来就确认循环还在跑
  if (!state.running) loop();
});

// 启动即开跑
loop();

// popup 查询状态
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'get-state') {
    sendResponse({ ...state });
    return true;
  }
  if (msg?.type === 'restart') {
    state.running = false;
    setTimeout(() => loop(), 100);
    sendResponse({ ok: true });
    return true;
  }
  return false;
});
