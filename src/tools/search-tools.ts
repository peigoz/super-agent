import type {ToolDefinition} from './tool-registry.js';
import TurndownService from 'turndown';

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