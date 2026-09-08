import 'dotenv/config';
import {generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry, type ToolDefinition} from './tools/tool-registry';
import {agentLoop, type BudgetState} from './agent/loop';
import {allTools} from './tools/index';
import {MCPClient, MockMCPClient} from './tools/mcp-client';
import {SessionStore} from './session/store';
import {coreRules, deferredTools, PromptBuilder, sessionContext, toolGuide, type PromptContext} from './context/prompt-builder';
import {estimateTokens, microcompact, summarize} from './context/compressor';
import {applyDefense, estimateMessageTokens, TokenTracker, truncateToolResults, ttlPrune} from './context/defense';
import {UsageTracker} from './usage/tracker.js';
import {buildContextSnapshot, renderContextView} from './context/view';

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);

const toolSearchTool: ToolDefinition = {
  name: 'tool_search',
  description: '获取延迟工具的完整定义。传入工具名（从系统提示的延迟工具列表中选取），返回该工具的完整参数 Schema',
  parameters: {
    type: 'object',
    properties: {
      query: {type: 'string', description: '工具名，如 "mcp__github__list_issues"。支持逗号分隔多个工具名'},
    },
    required: [ 'query' ],
    additionalProperties: false,
  },
  isConcurrencySafe: true,
  isReadOnly: true,
  execute: async ({query}: {query: string}) => {
    const results = registry.searchTools(query);
    if (results.length === 0) return `没有找到匹配 "${query}" 的工具`;
    return results.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  },
};
registry.register(toolSearchTool);

async function connectMCP() {
  const githubToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  let canSpawn = true;
  try {
    const {execSync} = await import('node:child_process');
    execSync('echo test', {stdio: 'ignore'});
  } catch {
    canSpawn = false;
  }

  if (githubToken && canSpawn) {
    console.log('\n连接 GitHub MCP Server...');
    try {
      const client = new MCPClient(
        'npx', [ '-y', '@modelcontextprotocol/server-github' ],
        {GITHUB_PERSONAL_ACCESS_TOKEN: githubToken},
      );
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer('github', mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

async function main() {
  await connectMCP()

  toolsRepoter();

  // Session 持久化
  const isContinue = process.argv.includes('--continue');
  const sessionId = 'default';
  const store = new SessionStore('default');

  let summary = '';
  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`\n[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`\n[Session] 新会话`);
  }

  const tracker = new UsageTracker('.usage/today.jsonl');
  const timestamps = new Map<number, number>();

  // 启动时压缩检查，替换为 tools 三层即时防线压缩。目的降低 LLM 压缩频率，节省费用和时间
  // summary = await compresssor(model, messages, summary, isContinue);
  console.log(`\n=== 三层即时防线 ===`);
  const beforeTokens = estimateMessageTokens(messages);
  const defense = applyDefense(messages, timestamps);
  messages = defense.messages;
  console.log(`[防线后] ${messages.length} 条消息, ~${defense.tokenEstimate} tokens (节省 ${beforeTokens - defense.tokenEstimate})`);
  // 更新 token 预算
  // tracker.replaceMessages(messages, defense.messages);
  console.log(`====================\n`);

  // Prompt Pipe 组装 system prompt
  // 保持 prompt 前缀不变，计算结果就能复用。不变的 section 放前面，变的放后面：
  // coreRules — 永远不变，放最前面，cache 稳稳命中。
  // toolGuide — 工具数量基本固定，变化很少。
  // deferredTools — 所有的工具列表也基本固定，放中间。
  // sessionContext — 每次启动都不同，放最后面。
  const builder = new PromptBuilder()
    .pipe('coreRules', coreRules())
    .pipe('toolGuide', toolGuide())
    .pipe('deferredTools', deferredTools())
    .pipe('sessionContext', sessionContext());

  const promptCtx: PromptContext = {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId,
  };
  // const SYSTEM = pickSystem({type: 'web_search', deferredTools: registry.getDeferredToolSummary()});
  const SYSTEM = builder.build(promptCtx);
  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        rl.close();
        return;
      }

      if (handleCommandTrigger(trimmed, {system: SYSTEM, messages})) {
        ask()
        return
      }

      const userMsg: ModelMessage = {role: 'user', content: trimmed};
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      // 每次模型执行前都调用 Tools 压缩，降低 LLM 压缩摘要触发频率
      const turnDefense = applyDefense(messages, timestamps);
      messages = turnDefense.messages;

      const beforeLen = messages.length;

      await agentLoop(model, registry, messages, SYSTEM, tracker);

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) {
        timestamps.set(i, now);
      }
      store.appendAll(newMessages);

      // 每轮对话后 LLM 压缩检查，作为三层防线的兜底，压缩（user/assistant 消息）
      summary = await compresssor(model, messages, summary, false);

      const status = estimateMessageTokens(messages);
      console.log(`  [Token] ~${status} tokens`);

      ask();
    });
  }

  console.log('Super Agent (type "exit" to quit)\n');
  console.log('demo：');
  console.log('  1. 找出项目里所有 TODO');
  console.log('  2. 去 https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling 看下文档总结');
  console.log('  3. 做一个待办清单的网页应用\n');
  console.log('  4. 帮我查下oxc的最新动态\n');
  console.log('  5. 帮我查下 vercel/ai 仓库的 star 数量\n');

  handleCommandTrigger('context', {system: SYSTEM, messages})
  ask();
}

main().catch(console.error);

// 整个防御体系的执行顺序是：截断（Layer 2）→ TTL 修剪（Layer 3）→ Token 估算（Layer 1，判断是否需要 LLM 压缩）→ 如果需要，触发 Microcompact → 如果还不够，触发 Summarization。
// 采用软删除 + LLM 压缩历史对话的策略，LLM 压缩只在即时防线不够用的时候才触发：
async function compresssor(model: any, messages: ModelMessage[], summary: string, isContinue: boolean): Promise<string> {
  // Check if compaction needed after each turn
  const currentTokens = estimateTokens(messages);
  if (currentTokens > 4000) {
    if (isContinue) console.log(`\n  ==== [历史对话启动压缩检查] ====`);
    console.log(`\n  [压缩检查] ~${currentTokens} tokens, 触发压缩...`);
    const mc2 = microcompact(messages);
    messages = mc2.messages;
    if (mc2.cleared > 0) console.log(`  [Microcompact] 清理了 ${mc2.cleared} 个工具结果`);

    const comp2 = await summarize(model, messages, summary);
    if (comp2.compressedCount > 0) {
      messages = comp2.messages;
      summary = comp2.summary;
      console.log(`  [Summarization] 压缩了 ${comp2.compressedCount} 条消息, ~${estimateTokens(messages)} tokens`);
    }

    if (isContinue) console.log(`  ==== [历史对话压缩完成] ====`);
  }
  return summary;
}

function handleCommandTrigger(cmd: string, {system, messages}: {system: string, messages: ModelMessage[]}) {
  // /context: 终端可视化的 context 占用，参考 Claude Code 的 /context
  if (cmd === '/context' || cmd === 'context') {
    const snapshot = buildContextSnapshot({
      modelName: process.env.DASHSCOPE_API_KEY ? 'Qwen Plus' : 'Mock Model (开发用)',
      modelId: process.env.DASHSCOPE_API_KEY ? 'qwen3-6-plus' : 'mock-model',
      windowTokens: 1_000_000,
      systemPromptChars: system.length,
      toolDescriptionChars: registry.getActiveTools().reduce((a, t) => a + t.name.length + (t.description?.length || 0) + JSON.stringify(t.parameters || {}).length, 0),
      memoryChars: 0,
      skillsChars: 0,
      messages,
    });
    console.log(renderContextView(snapshot));
    return true;
  }

  return false;
}

function toolsRepoter() {
  console.log(`已注册 ${registry.getAll().length} 个工具：`);
  for (const tool of registry.getAll()) {
    const flags = [
      tool.isConcurrencySafe ? '可并发' : '串行',
      tool.isReadOnly ? '只读' : '读写',
    ].join(', ');
    console.log(`  - ${tool.name}（${flags}）`);
  }
  const allCount = registry.getAll().length;
  const activeTools = registry.getActiveTools();
  const estimate = registry.countTokenEstimate();
  console.log(`\n=== 工具统计 ===`);
  console.log(`  全部工具: ${allCount} 个`);
  console.log(`  活跃工具: ${activeTools.length} 个`);
  console.log(`  延迟工具: ${allCount - activeTools.length} 个`);
  console.log(`  Token 估算: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟，不占 prompt)`);
}
