import 'dotenv/config';
import {generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry, toolsRepoter, type ToolDefinition} from './tools/registry';
import {agentLoop, type BudgetState} from './agent/loop';
import {allTools} from './tools/index';
import {MCPClient, MockMCPClient} from './tools/mcp-client';
import {SessionStore} from './session/store';
import {coreRules, deferredTools, memoryContext, PromptBuilder, ragContext, sessionContext, toolGuide, type PromptContext} from './context/prompt-builder';
import {estimateTokens, microcompact, summarize} from './context/compressor';
import {applyDefense, estimateMessageTokens, TokenTracker, truncateToolResults, ttlPrune} from './context/defense';
import {UsageTracker} from './usage/tracker';
import {createToolSearchTool} from './tools/tool-search';
import {dispatch, type CommandContext} from './commands';
import {MemoryStore} from './memory/store';
import {createMemoryTool} from './tools/memory-tools';
import {createDashScopeEmbedder, createMockEmbedder, embed} from './rag/embedder';
import {VectorStore} from './rag/store';
import {createRagTools} from './tools/rag-tools';
import {chunkDocument} from './rag/chunker';
import fs, {existsSync} from 'node:fs';

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

/** Start ----Registry---- Start */
const registry = new ToolRegistry();
registry.register(...allTools);
registry.register(createToolSearchTool(registry));
/** End ----Registry---- End */

/** Start ----Memory---- Start */
const memoryStore = new MemoryStore('.');
memoryStore.init();
registry.register(createMemoryTool(memoryStore));
/** End ----Memory---- End */

/** Start ----RAG---- Start */
const vectorStore = new VectorStore();
const embedFn = process.env.DASHSCOPE_API_KEY
  ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
  : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));
/** End ----RAG---- End */

async function connectGithubMCP() {
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
  await connectGithubMCP()

  toolsRepoter(registry);

  // Session 持久化
  const isContinue = process.argv.includes('--continue');
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
    .pipe('memoryContext', memoryContext(memoryStore))
    .pipe('ragContext', ragContext(vectorStore))
    .pipe('sessionContext', sessionContext());

  // 添加长期记忆后，每轮的 system-prompt 可能会变，改为函数实时构建
  function makePromptCtx(): PromptContext {
    return {
      toolCount: registry.getActiveTools().length,
      deferredToolSummary: registry.getDeferredToolSummary(),
      sessionMessageCount: messages.length,
      sessionId: 'default',
    };
  }
  const promptCtx = makePromptCtx()
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

      const ctx: CommandContext = {
        messages, timestamps, registry, builder, tracker,
        sessionStore: store, model, makePromptCtx, ask,
        memoryStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === 'async') return;
      if (handled) {ask(); return;}

      const userMsg: ModelMessage = {role: 'user', content: trimmed};
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      store.append(userMsg);

      // 每次模型执行前都调用 Tools 压缩，降低 LLM 压缩摘要触发频率
      const turnDefense = applyDefense(messages, timestamps);
      messages = turnDefense.messages;

      const currentSystem = builder.build(makePromptCtx());
      const beforeLen = messages.length;

      await agentLoop(model, registry, messages, currentSystem, tracker);

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

  if (fs.existsSync('docs')) {
    const files = fs.readdirSync('docs').filter(f => f.endsWith('.md'));
    if (files.length > 0) {
      console.log(`  发现 ${files.length} 个文档，自动导入知识库...`);
      for (const f of files) {
        const path = `docs/${f}`;
        const text = fs.readFileSync(path, 'utf-8');
        const chunks = chunkDocument(path, text);
        const embeddings = await embed(embedFn, chunks.map(c => c.text));
        vectorStore.addBatch(chunks.map((c, i) => ({chunk: c, embedding: embeddings[ i ]})));
        console.log(`    ${f} → ${chunks.length} 个片段`);
      }
      console.log(`  知识库就绪，共 ${vectorStore.size()} 个片段\n`);
    }
  }

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
