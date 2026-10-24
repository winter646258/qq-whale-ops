// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// ── 安全设计（沿用 v0.2，没有放松）────────────────────────────────────────
// - 只暴露只读工具：搜网页、读网页正文。没有任何本地文件/命令执行/写操作。
// - 所有出网请求都走 safe-fetch：禁内网/环回/链路本地/CGNAT，DNS 解析结果逐个校验，
//   每一跳重定向重新校验，响应体按字节流限量读取。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
//
// ── v0.3 改了什么，以及为什么 ────────────────────────────────────────────
//
// 1）只有 Bing，而且不提供引擎选项。
//    实测云上到 duckduckgo / google / searx / api.duckduckgo 全部不可达（HTTP 000），
//    只有 cn.bing.com 是 200 且 0.2s。给一个「选引擎」的参数只会让她选了也白选。
//
// 2）描述不再写「仅用于理解网络用语/梗/黑话的含义」。
//    那是老版本的自我设限，后果是：这个工具上线至今被调用 0 次
//    （grep web_search /var/log/qqbridge.log = 0）。工具本身是好的 —— 实测同一段
//    解析逻辑能从 Bing 稳定拿到 10 条带标题/URL/摘要的结果，是说明书把它关起来了。
//
// 3）新增 count / freshness / site。
//    时效过滤用的是 Bing 的一组魔数（filters=ex1:"ez1" 这类），含义别去猜，
//    照抄即可 —— 实测 ex1:"ez1" 返回 200 且 10 条结果。
//
// 4）web_fetch 返回剥干净的正文，不再是 HTML 原文。
//    一个 100KB 的页面里经常 80KB 是 script/style，对模型是纯噪声、还烧 token。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

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

async function bingSearch(query, { count = 8, freshness, site } = {}) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', site ? `site:${site} ${query}` : query);
  if (freshness && FRESHNESS[freshness]) url.searchParams.set('filters', FRESHNESS[freshness]);
  // 搜索页比普通网页肥得多，给 512K 字符的额度；正文解析只取前 20 条。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const limit = Math.min(Math.max(1, Number(count) || 8), 20);
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= limit) break;
  }
  return { query, engine: 'bing', count: results.length, results };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.3.0' });

server.tool(
  'web_search',
  '上网搜索。想知道什么都没问题：实事、新闻、天气、人物、作品、概念、价格、教程、某句话的出处。返回若干条标题 + 链接 + 摘要；摘要不够就挑一条用 web_fetch 打开细看。搜索是有延迟的，别用连续搜索代替思考。',
  {
    query: z.string().describe('搜索词，正常写字就行（和你在搜索框里打的一样）'),
    count: z.number().optional().describe('要几条结果，1~20，默认 8'),
    freshness: z.enum(['day', 'week', 'month', 'year']).optional().describe('只要最近这段时间的：day/week/month/year。问「最近」「今天」这类时效问题时就带上'),
    site: z.string().optional().describe('只在某个站里搜，填域名，例：zhihu.com、github.com、bilibili.com'),
  },
  async ({ query, count, freshness, site }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '搜索词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean, { count, freshness, site: sanitizeQuery(site) });
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
