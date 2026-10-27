// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// ── 安全设计（沿用 v0.2，没有放松）────────────────────────────────────────
// - 只暴露只读工具：搜网页、读网页正文。没有任何本地文件/命令执行/写操作。
// - 所有出网请求都走 safe-fetch：禁内网/环回/链路本地/CGNAT，DNS 解析结果逐个校验，
//   每一跳重定向重新校验，响应体按字节流限量读取。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
//
// ── v0.4 合并了什么，以及为什么 ──────────────────────────────────────────
//
// 两边的实现各有各的好，合并而不是二选一：
//
// 1）搜索主干改用 **DSH 同一路 DeepSeek 联网搜索**（src/web-search.js）。
//    远程版这么做的理由是对的：结果更准，而且不把群里的词原样发给搜索引擎广告网络。
//    凭据链 config → 环境变量 → DSH 的 .credentials.yaml，实测服务器上走第三条能通
//    （2026-10-27 实测：4.6s 返回 8 条结果）。DeepSeek 不可用时自动回退 Bing。
//
// 2）保留本地版的 count / freshness / site 三个参数。
//    DeepSeek 的服务端搜索工具不支持这三个，但本地 Bing 版支持 —— 特别是 freshness
//    用的那组魔数（filters=ex1:"ez1" 这类）实测可用，问「最近」「今天」时缺它就废了。
//    所以：给了 site 或 freshness 就直接走 Bing（只有它能表达这两个条件），
//    否则走 DeepSeek 优先路径。
//
// 3）web_fetch 保留本地版的正文提取（stripToText）。
//    一个 100KB 的页面里经常 80KB 是 script/style，对模型是纯噪声、还烧 token。
//
// 4）搜索词上限本地 200 字符 / 远程 120。取后者更长的那个：中文查询按字符算，
//    120 有时不够描述一个具体的梗。
import path from 'node:path';
import { safeFetch } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把 HTML 压成能读的正文。
 *
 * 先整块干掉 script/style/noscript/注释 —— 顺序很重要，必须在逐标签剥离之前做，
 * 否则脚本里的 `<` 会被当成标签、而脚本内容本身会漏进正文。
 */
function stripToText(html) {
  return String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Bing 的时效过滤。这四个值实测可用，别改写成别的形式。
const FRESHNESS = Object.freeze({
  day: 'ex1:"ez1"',
  week: 'ex1:"ez2"',
  month: 'ex1:"ez3"',
  year: 'ex1:"ez4"',
});

/**
 * 统一搜索入口。
 *
 * 不再自己抓 Bing HTML —— 那份解析原本和 `web-search.js` 里的是两份实现，
 * Bing 一改版就只能修一处，另一处静默返回空（看起来像「搜不到」）。
 * 现在 site / freshness 已下沉到 `web-search.js` 的统一搜索里。
 */
async function search(query, { count, freshness, site } = {}) {
  const limit = Math.min(Math.max(1, Number(count) || 8), 20);
  // site / freshness 只有 Bing 能表达，直接指定 provider，不做无谓的 DeepSeek 尝试。
  // 注意：条数走 config.maxResults，不是顶层 count —— webSearch 只读 config。
  const result = await webSearch(query, {
    provider: site || freshness ? 'bing' : undefined,
    config: { maxResults: limit },
    ...(site ? { site } : {}),
    ...(freshness ? { freshness } : {}),
    root: projectRoot()
  });
  const results = Array.isArray(result?.results) ? result.results.slice(0, limit) : [];
  return {
    ...result,
    results,
    ...(results.length ? {} : { note: result?.note || '没有搜到结果（可以直接说搜不到，或换个说法再试一次）' })
  };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.4.0' });

server.tool(
  'web_search',
  '上网搜索。想知道什么都没问题：实事、新闻、天气、人物、作品、概念、价格、教程、某句话的出处。优先走 DeepSeek 联网搜索（结果更准、不把查询词发给搜索引擎广告网络），不可用时自动回退 Bing。返回若干条标题 + 链接 + 摘要；摘要不够就挑一条用 web_fetch 打开细看。搜索是有延迟的，别用连续搜索代替思考。',
  {
    query: z.string().describe('搜索词，正常写字就行（和你在搜索框里打的一样）'),
    count: z.number().optional().describe('要几条结果，1~20，默认 8'),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('只要最近这段时间的：day/week/month/year。问「最近」「今天」这类时效问题时就带上（此时走 Bing）'),
    site: z.string().optional().describe('只在某个站里搜，填域名，例：zhihu.com、github.com、bilibili.com（此时走 Bing）'),
  },
  async ({ query, count, freshness, site }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '搜索词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await search(clean, { count, freshness, site: sanitizeQuery(site) });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '打开一个网页，读它的正文（已经去掉了脚本和样式，返回可读文本）。用来把某条搜索结果看清楚、或读一篇具体文章。禁止访问内网/本机地址。',
  {
    url: z.string().describe('要打开的 http(s) 链接，通常是 web_search 结果里的某一条'),
    maxChars: z.number().optional().describe('最多读多少字符，默认 50000。长文章可以调大，但调太大会很占上下文'),
  },
  async ({ url, maxChars }) => {
    try {
      const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 50000;
      const result = await safeFetch(url, limit);
      const text = stripToText(result.body);
      const out = {
        url: result.url,
        statusCode: result.statusCode,
        truncated: result.truncated,
        chars: text.length,
        text,
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
