
import {resolve, sep} from 'node:path';
import {existsSync, readFileSync} from 'node:fs';
import {type Server, createServer} from 'node:http';
import type {ToolDefinition} from './tool-registry.js';
import TurndownService from 'turndown';
import {lookup} from 'mrmime';


export const fetchUrlTool: ToolDefinition = {
  name: 'fetch_url',
  description: '抓取指定 URL 的网页内容并转换为纯文本（自动剥离 HTML 标签）',
  parameters: {
    type: 'object',
    properties: {
      url: {type: 'string', description: '完整 URL，必须以 http:// 或 https:// 开头'},
    },
    required: [ 'url' ],
    additionalProperties: false,
  },
  isConcurrencySafe: true,    // 只读、可并发——抓多个 URL 时直接并行
  isReadOnly: true,
  maxResultChars: 1500,        // 网页通常很长，截断兜底
  execute: async ({url}: {url: string}) => {
    try {
      const res = await fetch(url, {
        headers: {'User-Agent': 'Mozilla/5.0 SuperAgent'},
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return `请求失败：HTTP ${res.status}`;
      const html = await res.text();
      return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || '页面无文本内容';
    } catch (err: any) {
      return `抓取失败：${err.message}`;
    }
  },
};

let previewServer: Server | null = null;

export const startPreviewTool: ToolDefinition = {
  name: 'start_preview',
  description: '启动 app/ 目录的预览服务器。生成应用文件后必须立即调用此工具',
  parameters: {
    type: 'object',
    properties: {port: {type: 'number'}},
    required: [],
    additionalProperties: false,
  },
  isConcurrencySafe: false,
  isReadOnly: false,
  execute: async ({port = 8080}: {port?: number} = {}) => {
    if (previewServer) return `预览服务器已在运行 → http://localhost:${port}`;
    const root = resolve('app');
    if (!existsSync(root)) return '错误：app/ 目录不存在';

    previewServer = createServer((req, res) => {
      const send = (status: number, body?: Buffer | string, type?: string) => {
        const headers: Record<string, string> = {
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
        };
        if (type) headers[ 'Content-Type' ] = type;
        res.writeHead(status, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
      };

      // 1. 解析并解码 URL（decodeURIComponent 抛错 → 400）
      let pathname: string;
      try {
        pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      } catch {
        send(400, 'Bad Request', 'text/plain; charset=utf-8');
        return;
      }

      // 2. 目录请求指向 index.html；. 前缀防 resolve 把绝对路径解析到 root 外
      const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname;
      const filePath = resolve(root, '.' + rel);

      // 3. 防目录穿越：解析结果必须仍在 root 内
      if (filePath !== root && !filePath.startsWith(root + sep)) {
        send(403, 'Forbidden', 'text/plain; charset=utf-8');
        return;
      }

      // 4. 读文件 → 404
      let data: Buffer;
      try {
        data = readFileSync(filePath);
      } catch {
        send(404, 'Not Found', 'text/plain; charset=utf-8');
        return;
      }

      // 5. MIME：mrmime 精简查找表（常见类型，打包后 ~3KB），用法与 sirv 一致
      //    未知类型 lookup 返回 undefined，退回 octet-stream
      const type = lookup(filePath);
      send(200, data, type || 'application/octet-stream');
    });

    return new Promise<string>((resolvePromise) => {
      previewServer!.listen(port, () => {
        resolvePromise(`✓ 预览服务器已启动 → http://localhost:${port}`);
      });
    });
  },
};

// ── Tavily（自动挡）──────────────────────────────
// 维度	            Serper	           Tavily
// 免费额度	         2,500 次/月	     1,000 次/月
// 价格	            $0.30-1/1K       	$5-8/1K
// 延迟	            200-500ms	         1-2s
// 返回内容	        snippet（网页摘要）	提取文本（完整内容）
// 需要 web_fetch	   是	                  否
export const tavilySearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回相关网页的标题、链接和内容摘要',
  parameters: {
    type: 'object',
    properties: {
      query: {type: 'string', description: '搜索关键词'},
      max_results: {type: 'number', description: '返回结果数量，默认 5'},
    },
    required: [ 'query' ],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({query, max_results = 5}: {query: string; max_results?: number}) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) return '[web_search] 未配置 TAVILY_API_KEY，请在 .env 中设置';

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results,
        include_answer: true,
      }),
    });

    if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

    const data = await res.json() as any;
    const lines: string[] = [];

    if (data.answer) {
      lines.push(`## AI 摘要\n${data.answer}\n`);
    }

    for (const r of data.results || []) {
      lines.push(`### ${r.title}`);
      lines.push(r.url);
      lines.push(r.content || r.snippet || '');
      lines.push('');
    }

    return lines.join('\n') || '没有找到相关结果';
  },
};

// ── Serper（手动挡）──────────────────────────────

export const serperSearchTool: ToolDefinition = {
  name: 'web_search',
  description: '搜索互联网获取最新信息。返回 Google 搜索结果的标题、链接和摘要',
  parameters: {
    type: 'object',
    properties: {
      query: {type: 'string', description: '搜索关键词'},
      max_results: {type: 'number', description: '返回结果数量，默认 5'},
    },
    required: [ 'query' ],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({query, max_results = 5}: {query: string; max_results?: number}) => {
    const apiKey = process.env.SERPER_API_KEY;
    if (!apiKey) return '[web_search] 未配置 SERPER_API_KEY，请在 .env 中设置';

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({q: query, num: max_results}),
    });

    if (!res.ok) return `[web_search] 请求失败: HTTP ${res.status}`;

    const data = await res.json() as any;
    const lines: string[] = [];

    if (data.knowledgeGraph) {
      const kg = data.knowledgeGraph;
      lines.push(`## ${kg.title}`);
      if (kg.description) lines.push(kg.description);
      lines.push('');
    }

    for (const r of (data.organic || []).slice(0, max_results)) {
      lines.push(`### ${r.title}`);
      lines.push(r.link);
      lines.push(r.snippet || '');
      lines.push('');
    }

    return lines.join('\n') || '没有找到相关结果';
  },
};

// fetch_url 粗暴地把 HTML 标签全删了返回纯文本，web_fetch 通过 Turndown 保留了 Markdown 结构——标题层级、链接、代码块、列表都在，LLM 读起来信息密度更高。
export const webFetchTool: ToolDefinition = {
  name: 'web_fetch',
  description: '抓取指定 URL 的网页内容，转换为 Markdown 格式。搭配 web_search 使用——先搜索拿到链接，再用这个工具读取详细内容',
  parameters: {
    type: 'object',
    properties: {
      url: {type: 'string', description: '完整 URL'},
    },
    required: [ 'url' ],
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  maxResultChars: 3000,
  execute: async ({url}: {url: string}) => {
    try {
      const res = await fetch(url, {
        headers: {'User-Agent': 'Mozilla/5.0 (compatible; SuperAgent/1.0)'},
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `抓取失败: HTTP ${res.status}`;
      const html = await res.text();
      return htmlToMarkdown(html);
    } catch (err: any) {
      return `抓取失败: ${err.message}`;
    }
  },
};

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});
turndown.remove([ 'script', 'style', 'nav', 'footer', 'header', 'iframe' ]);

function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export function pickSearchTool(): ToolDefinition {
  // if (process.env.TAVILY_API_KEY) return tavilySearchTool;
  if (process.env.SERPER_API_KEY) return serperSearchTool;
  return tavilySearchTool;  // 默认（会提示配 Key）
}