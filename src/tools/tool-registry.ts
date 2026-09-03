import {jsonSchema} from 'ai';
import type {MCPClient, MockMCPClient} from '../mcp-client';

export interface ToolDefinition {
  name: string;
  description: string;        // 给模型看的描述
  parameters: Record<string, unknown>;  // JSON Schema
  execute: (input: any) => Promise<unknown>;

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean;  // 能否并行,并发安全性不是按工具名决定的，而是按行为决定的
  isReadOnly?: boolean;         // 是否只读
  shouldDefer?: boolean;    // 是否延迟加载
  searchHint?: string;      // 搜索提示词，帮助 ToolSearch 匹配
  maxResultChars?: number;      // 结果最大长度
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false;          // 当前是否有独占锁持有者
  private concurrentCount = 0;            // 当前共享锁持有数
  private waitQueue: Array<() => void> = [];  // 阻塞等待中的 resolve 函数

  // MCP 客户端列表，注册 MCP Server 时会把客户端存起来，方便统一关闭
  private mcpClients: Array<MCPClient | MockMCPClient> = [];

  // 工具懒加载
  private discoveredTools = new Set<string>();

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }

  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>(r => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }

  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    const tools = this.getActiveTools().map(t => [ t.name, t ] as const);
    for (const [ name, tool ] of tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[ name ] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            const raw = await executeFn(input);
            const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }

  countTokenEstimate(): {active: number; deferred: number; total: number} {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const schemaSize = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }).length;
      const tokens = Math.ceil(schemaSize / 4);

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return {active, deferred, total: active + deferred};
  }

  /** Start ----MCP 注册---- Start */
  async registerMCPServer(
    serverName: string,
    client: MCPClient | MockMCPClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      // 增加命名空间前缀，避免同名工具冲突
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`, // 增加MCP前缀，便于调试时查看日志。区分是内置工具的问题还是 MCP Server 的问题
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        maxResultChars: 3000,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }
  /** End ----MCP 注册---- End */

  /** Start ----工具延迟加载---- Start */
  // 更激进的方案：ToolSearch + CallTool 双工具代理模式：
  // tools 列表里永远只有 tool_search 和 call_tool 两个元工具， 模型先搜索获取 Schema，再通过 call_tool 转发执行，
  // 应用层根据 tool_name 路由到真正的工具实现。这样工具列表从头到尾不变，cache 完全稳定。
  // 代价是模型不是通过 tools 参数里的结构化 Schema 来"认识"工具的，而是通过对话历史里的文本描述来理解参数格式，参数复杂的工具准确率会略低一些。
  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter(tool => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      return true;
    });
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    const names = q.includes(',')
      ? q.split(',').map(n => n.trim()).filter(Boolean)
      : [ q ];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== 'tool_search') {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  // 所有延迟工具的 Schema 定义不用常驻 prompt
  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter(tool => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return '';

    const lines = deferred.map(t => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : '';
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join('\n')}`;
  }
  /** End ----延迟加载---- End */
}

export function truncateResult(text: string, maxChars: number = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  // 很多时候文件尾部的信息比中间更有价值，所以保留头部和尾部，中间省略
  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}