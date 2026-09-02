import {jsonSchema} from 'ai';

export interface ToolDefinition {
  name: string;
  description: string;        // 给模型看的描述
  parameters: Record<string, unknown>;  // JSON Schema
  execute: (input: any) => Promise<unknown>;

  // 元数据——给 Agent Loop 做决策用
  isConcurrencySafe?: boolean;  // 能否并行,并发安全性不是按工具名决定的，而是按行为决定的
  isReadOnly?: boolean;         // 是否只读
  maxResultChars?: number;      // 结果最大长度
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

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

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [ name, tool ] of this.tools) {
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      result[ name ] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          const raw = await executeFn(input);
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          return truncateResult(text, maxChars);
        },
      };
    }
    return result;
  }
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