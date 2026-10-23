#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
patch-phone-bridge-wire.py —— 把浏览器桥接进 bridge.js（第一期，只读）

落点（五个）：
  1. import phone-bridge / site-bili
  2. 状态文件：state/phone-token
  3. 接线层：phoneBridge 单例 + 在线判定 + BiliClient 工厂 + 令牌校验
  4. 三个 HTTP 端点：/api/phone/poll、/api/phone/result、/api/phone/status
  5. 巡检日志：扩展离线时每 10 分钟提醒一次（不刷屏）

安全边界（写进代码注释，也写进主人能看到的文档）：
  - 令牌校验失败一律 401，且**不区分**「没带」和「带错」
  - /api/phone/poll 与 /api/phone/result 只对携带正确令牌的扩展开放
  - 出口 URL 由 bridge 决定（白名单在 phone-bridge.js 里写死），扩展无法指定
  - 服务器不接收、不转发 Cookie（sanitizeHeaders 结构性剥离）

用法：
  python3 patch-phone-bridge-wire.py --target /opt/qq-bridge
  python3 patch-phone-bridge-wire.py --target /tmp/pbv --dry-run
"""

import argparse
import os
import sys

# 注意：默认值只是兜底，实际路径由 --target 决定。
# 之前写死 /opt/qq-bridge 导致在隔离副本里跑时改了线上文件（踩过）。
DEFAULT_TARGET = os.environ.get('TARGET', '/opt/qq-bridge')

MARK_IMPORT = '// MARKER: phone-bridge-import'
MARK_FILE = '// MARKER: phone-bridge-file'
MARK_WIRE = '// MARKER: phone-bridge-wire'
MARK_ROUTES = '// MARKER: phone-bridge-routes'
MARK_TICK = '// MARKER: phone-bridge-tick'


IMPORT_ANCHOR = "} from './image-approval-store.js';"
IMPORT_ADD = r"""} from './image-approval-store.js';

// MARKER: phone-bridge-import
import { PhoneBridge } from './phone-bridge.js';
import { BiliClient } from './site-bili.js';"""

FILE_ANCHOR = "const IMAGE_APPROVAL_FILE = path.join(STATE_DIR, 'image-approval.json');"
FILE_ADD = r"""const IMAGE_APPROVAL_FILE = path.join(STATE_DIR, 'image-approval.json');

// MARKER: phone-bridge-file
// 浏览器扩展的访问令牌。首次启动自动生成，改这个文件后重启生效。
const PHONE_TOKEN_FILE = path.join(STATE_DIR, 'phone-token');"""


WIRE_ANCHOR = "  function v2ToolEnabled(flag) {"
WIRE_ADD = r"""
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
  function biliClient() {
    if (!biliClientCache) {
      biliClientCache = new BiliClient({
        phone: phoneBridge,
        log: (msg) => log(msg)
      });
    }
    return biliClientCache;
  }

  /** 给别的模块用：现在能不能刷站（扩展在线吗）。 */
  function phoneOnline() {
    return phoneBridge.isOnline();
  }
"""


# 控制台有个集中鉴权关卡（所有请求都要 x-console-token）。
# /api/phone/* 必须成为例外：浏览器扩展不可能持有管理台令牌。
# 放行点放在 Host 校验之后、控制台鉴权之前 —— 这样 DNS rebinding 防护仍然生效。
HOST_ANCHOR = """      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      if (!allowedHosts.includes(hostHeader.toLowerCase())) {"""
HOST_ADD = r"""      const allowedHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`];
      // MARKER: phone-bridge-host-exempt
      // 浏览器扩展从主人电脑访问公网地址，Host 不可能是回环。
      // DNS rebinding 在这一路上被扩展令牌抵消（令牌只存在扩展里，不出本机），
      // 且扩展只能发白名单 origin 的 GET、不带 Cookie（见 phone-bridge.js 的 HEADER_ALLOW）。
      const phoneHostExempt = url.pathname.startsWith('/api/phone/');
      if (!allowedHosts.includes(hostHeader.toLowerCase()) && !phoneHostExempt) {"""

MARK_HOST = '// MARKER: phone-bridge-host-exempt'

EXEMPT_ANCHOR = """      if (consoleToken && !tokenMatches) {"""
EXEMPT_ADD = r"""      // MARKER: phone-bridge-exempt
      // 浏览器扩展走自己的令牌（x-phone-token），不持有管理台令牌。
      // 这里只跳过**控制台令牌**这一关；上面已经过了 Host 校验，
      // 下面每个 /api/phone/ 分支自己校验 phoneTokenOk()。
      const phonePathExempt = url.pathname.startsWith('/api/phone/');
      if (consoleToken && !tokenMatches && !phonePathExempt) {"""

MARK_EXEMPT = '// MARKER: phone-bridge-exempt'

ROUTES_ANCHOR = "        // ── 日程 / 画像：角色的短期记忆与长期认识"
ROUTES_ADD = r"""        // MARKER: phone-bridge-routes
        // ── 浏览器桥：扩展来领任务 / 回传结果 / 看状态 ──
        // 这三个端点**不走 console token**，而是走扩展自己的令牌：
        // 它们要暴露给浏览器（跨域），不该把管理台令牌摊出去。
        if (req.method === 'OPTIONS' && rawPath.startsWith('/api/phone/')) {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': 'content-type, x-phone-token',
            'access-control-allow-methods': 'POST, GET, OPTIONS',
            'access-control-max-age': '600'
          });
          res.end();
          return;
        }
        if (rawPath.startsWith('/api/phone/')) {
          res.setHeader('access-control-allow-origin', '*');
          res.setHeader('access-control-allow-headers', 'content-type, x-phone-token');
          res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
        }

        if (rawPath === '/api/phone/poll' && req.method === 'POST') {
          if (!phoneTokenOk(req.headers['x-phone-token'])) {
            sendJson({ ok: false, error: '令牌无效' }, 401);
            return;
          }
          const task = await phoneBridge.poll();
          sendJson({ ok: true, task });
          return;
        }

        if (rawPath === '/api/phone/result' && req.method === 'POST') {
          if (!phoneTokenOk(req.headers['x-phone-token'])) {
            sendJson({ ok: false, error: '令牌无效' }, 401);
            return;
          }
          // 注意：console server 里没有全局 body —— 每个路由都自己 readBody()。
          const resultBody = await readBody();
          const r = phoneBridge.submitResult(resultBody ?? {});
          sendJson(r, r.ok ? 200 : 400);
          return;
        }

        if (rawPath === '/api/phone/status' && req.method === 'GET') {
          if (!phoneTokenOk(req.headers['x-phone-token'])) {
            sendJson({ ok: false, error: '令牌无效' }, 401);
            return;
          }
          sendJson({ ok: true, ...phoneBridge.status() });
          return;
        }

        // ── 日程 / 画像：角色的短期记忆与长期认识"""


TICK_ANCHOR = "  reportTickV2();"
TICK_ADD = r"""  reportTickV2();
  // MARKER: phone-bridge-tick
  // 扩展离线时每 10 分钟提醒一次（不刷屏）。上线不代表有人装着扩展。
  try {
    if (!phoneBridge.isOnline() && Date.now() - phoneOfflineLoggedAt > 600_000) {
      phoneOfflineLoggedAt = Date.now();
      log('[phone] 浏览器扩展离线：站点请求（B站/小黑盒）暂时发不出去');
    }
  } catch {}
"""

TICK_DECL_ANCHOR = "  let shareStateCache = null;"
TICK_DECL_ADD = r"""  // MARKER: phone-bridge-offline-decl
  let phoneOfflineLoggedAt = 0;
"""


def ensure(cond, msg):
    if not cond:
        print(f'FAIL: {msg}')
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default=DEFAULT_TARGET)
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    bridge = os.path.join(args.target, 'src', 'bridge.js')
    ensure(os.path.isfile(bridge), f'找不到 {bridge}')

    with open(bridge, 'r', encoding='utf-8') as f:
        src = f.read()
    before_len = len(src)

    # 前置条件：依赖的文件必须已经部署（否则 import 会炸）
    for need in ('phone-bridge.js', 'site-bili.js'):
        ensure(
            os.path.isfile(os.path.join(args.target, 'src', need)),
            f'src/{need} 还没部署到 {args.target}/src/'
        )

    changed = []

    def apply(mark, anchor, addition, label, before=True):
        nonlocal src
        if mark in src:
            print(f'  - {label}: 已装，跳过')
            return
        n = src.count(anchor)
        ensure(n == 1, f'{label} 锚点命中 {n} 次（应为 1）：{anchor[:60]}')
        src = src.replace(anchor, (addition + anchor) if before else addition, 1)
        changed.append(label)

    # 1. import：锚点是 shared/site import 的收尾行，新 import 插在它**后面**
    if MARK_IMPORT in src:
        print('  - import: 已装，跳过')
    else:
        n = src.count(IMPORT_ANCHOR)
        ensure(n == 1, f'import 锚点命中 {n} 次（应为 1）')
        src = src.replace(IMPORT_ANCHOR, IMPORT_ADD, 1)
        changed.append('import')

    # 2. 状态文件常量
    apply(MARK_FILE, FILE_ANCHOR, FILE_ADD, '状态文件常量', before=False)

    # 3. 接线层
    apply(MARK_WIRE, WIRE_ANCHOR, WIRE_ADD, '接线层')

    # 4. HTTP 端点
    # routes 的 addition 自己带了「日程/画像」那行注释（它是靠后的普通注释，不像函数签名那样敏感），
    # 所以用替换语义、不让 apply 再放回锚点，否则那行会重复。
    apply(MARK_ROUTES, ROUTES_ANCHOR, ROUTES_ADD, 'HTTP 端点', before=False)

    # 4a. Host 头校验放行 /api/phone/*（扩展从公网地址访问）
    apply(MARK_HOST, HOST_ANCHOR, HOST_ADD, 'Host 放行', before=False)

    # 4b. 控制台鉴权放行 /api/phone/*（必须在 routes 之前，因为它改的是关卡本身）
    apply(MARK_EXEMPT, EXEMPT_ANCHOR, EXEMPT_ADD, '鉴权放行', before=False)

    # 5a. 离线提醒的变量声明
    apply('  let phoneOfflineLoggedAt = 0;', TICK_DECL_ANCHOR, TICK_DECL_ADD, '离线提醒声明')

    # 5b. 巡检里挂上离线提醒
    apply(MARK_TICK, TICK_ANCHOR, TICK_ADD, '巡检离线提醒', before=False)

    # ── 锚点存活断言（防「替换语义」把锚点吃掉）──
    ensure("} from './image-approval-store.js';" in src, 'image-approval import 尾巴被吃掉了')
    ensure("} from './phone-bridge.js';" in src, 'phone-bridge import 尾巴被吃掉了')
    ensure("import { BiliClient } from './site-bili.js';" in src, 'BiliClient import 丢了')
    ensure("const PHONE_TOKEN_FILE = path.join(STATE_DIR, 'phone-token');" in src, 'PHONE_TOKEN_FILE 常量丢了')
    ensure(src.count('new PhoneBridge(') == 1, 'PhoneBridge 实例化次数不对')
    # 锚点不能被吞进注释：函数声明前必须有换行
    ensure(chr(10) + '  function v2ToolEnabled(flag) {' in src, 'v2ToolEnabled 被吞掉了（插入内容开头少了换行）')
    ensure(src.count('function phoneTokenOk(') == 1, 'phoneTokenOk 定义次数不对')
    ensure(src.count('/api/phone/poll') == 1, '/api/phone/poll 出现次数不对')
    ensure(src.count('/api/phone/result') == 1, '/api/phone/result 出现次数不对')
    ensure(src.count('/api/phone/status') == 1, '/api/phone/status 出现次数不对')
    ensure('phoneBridge.submitResult(' in src, 'submitResult 调用丢失')
    ensure(src.count('const phonePathExempt = url.pathname.startsWith(\'/api/phone/\');') == 1, '鉴权放行变量丢了')
    ensure('consoleToken && !tokenMatches && !phonePathExempt' in src, '鉴权关卡没改成例外')
    ensure(src.count('const phoneHostExempt = url.pathname.startsWith(\'/api/phone/\');') == 1, 'Host 放行变量丢了')
    ensure('!allowedHosts.includes(hostHeader.toLowerCase()) && !phoneHostExempt' in src, 'Host 校验没改成例外')
    ensure('!allowedHosts.includes(hostHeader.toLowerCase())) {' not in src, 'Host 旧校验残留（替换没生效）')
    # 关键：例外必须只覆盖 phone 路径，别把整个控制台放开
    ensure(src.count('if (consoleToken && !tokenMatches) {') == 0, '还有没放行的旧关卡残留（说明替换没生效）')

    if not changed:
        print('没有改动（全部已装）')
        return

    print(f'改动：{", ".join(changed)}')
    print(f'bridge.js: {before_len} → {len(src)} 字节（{len(src) - before_len:+d}）')

    if args.dry_run:
        print('[dry-run] 不写盘')
        return

    bak = bridge + '.bak-phone-' + __import__('time').strftime('%Y%m%d-%H%M%S')
    with open(bak, 'w', encoding='utf-8') as f:
        with open(bridge, 'r', encoding='utf-8') as g:
            f.write(g.read())
    with open(bridge, 'w', encoding='utf-8') as f:
        f.write(src)
    print(f'已写盘，备份：{bak}')


if __name__ == '__main__':
    main()
