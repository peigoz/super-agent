import {generateText, type ModelMessage} from 'ai';
import {textToolResultOutput, toolResultOutputToText} from './tool-result-output.js';


/** Estimate token count: ~4 chars per token for mixed Chinese/English. */
function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          chars += part.text.length;
        } else if ('output' in part) {
          chars += toolResultOutputToText(part.output).length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

// Agent 压缩策略：
// 1. Compaction（紧凑化,优先） 不改对话结构，只缩小内容，比如移除某些比较大的工具调用的内容；
// 2. Summarization（摘要化） 用 LLM 生成摘要替换整段对话，原始的这段对话内容会丢失。

// ── Layer 1: Microcompact ────────────────────────────
const CLEARABLE_TOOLS = new Set([
  'read_file', 'bash', 'grep', 'glob', 'list_directory',
  'edit_file', 'write_file',
]);
const KEEP_RECENT_TOOL_RESULTS = 3;

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  // 找到所有 tool result 消息的位置
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[ i ];
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      toolResultIndices.push(i);
    }
  }

  // 保留最近 N 个工具结果不动，只清理更早的
  const toClear = toolResultIndices.slice(
    0, Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS)
  );

  let cleared = 0;
  const result = messages.map((msg, idx) => {
    if (!toClear.includes(idx)) return msg;
    if (msg.role !== 'tool') return msg;

    const toolName = msg.content[ 0 ].type === 'tool-result' ? msg.content[ 0 ].toolName : 'unknown';
    if (!CLEARABLE_TOOLS.has(toolName)) return msg;

    cleared++;
    return {
      ...msg,
      content: msg.content.map(part => ({
        ...part, output: textToolResultOutput('[tool result cleared]'),
      })),
    };
  });

  return {messages: result, cleared};
}

// ── Layer 2: LLM Summarization ───────────────────────
// Prompt 核心原则：
// 1. 给模型一个表格让它填，而不是让它自由写作。
// 2. 模板内容要贴合业务场景。如果 Agent 是做代码审查的，模板里应该有"审查过的文件"、"发现的问题"、"修复建议"。如果是做客服的，应该有"用户诉求"、"已尝试的解决方案"、"当前情绪"。Claude Code 的摘要模板有 9 个字段（用户意图、技术概念、文件改动、错误修复等），完全针对编程场景设计。
// 3. 字数限制很重要。不设上限的话，模型可能生成一个比原始对话还长的"摘要"，压缩变成了膨胀。
// 4. "不要什么"比"要什么"更重要。Prompt 里明确说"不要写笼统的概述"，否则模型会输出"用户进行了一系列操作"这种没有任何信息量的句子。
const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写。如果某个字段没有相关内容，写"无"：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言（中文或英文）输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

const CONTEXT_TOKEN_THRESHOLD = 300;
const KEEP_RECENT_MESSAGES = 6;

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

export async function summarize(
  model: any,
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages);
  if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD || messages.length <= KEEP_RECENT_MESSAGES) {
    return {messages, summary: existingSummary || '', compressedCount: 0};
  }

  const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);

  // 对齐到 user 消息边界——切分点一定不能落在 assistant 或 tool 消息上，否则保留的消息列表会以非 user 开头，很多 LLM API 会报错。
  // 注意要从切分点往前找到最近的 user 消息再切。
  let alignedIdx = splitIdx;
  while (alignedIdx > 0 && messages[ alignedIdx ].role !== 'user') {
    alignedIdx--;
  }
  if (alignedIdx === 0) {
    return {messages, summary: existingSummary || '', compressedCount: 0};
  }

  const toCompress = messages.slice(0, alignedIdx);
  const toKeep = messages.slice(alignedIdx);

  const conversationText = toCompress
    .map(msg => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map(part => 'text' in part
            ? part.text
            : 'output' in part
              ? toolResultOutputToText(part.output)
              : '').join('')
          : '';
      return content ? `**${msg.role}**: ${content}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  if (!conversationText.trim()) {
    return {messages, summary: existingSummary || '', compressedCount: 0};
  }

  const userPrompt = existingSummary
    ? `## 已有摘要（上一次压缩的结果）\n\n${existingSummary}\n\n## 需要压缩的新对话\n\n${conversationText}`
    : conversationText;

  try {
    const {text: summary} = await generateText({
      model,
      system: COMPRESS_PROMPT,
      prompt: userPrompt,
    });

    const summaryMessage: ModelMessage = {
      role: 'user',
      content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束，以下是最近的对话]`,
    };

    const newMessages: ModelMessage[] = [ summaryMessage, ...toKeep ];

    return {
      messages: newMessages,
      summary,
      compressedCount: toCompress.length,
    };
  } catch (err) {
    console.error('[Compaction] LLM 摘要失败:', err);
    return {messages, summary: existingSummary || '', compressedCount: 0};
  }
}

export {estimateTokens};