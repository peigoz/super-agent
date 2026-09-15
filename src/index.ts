import 'dotenv/config';
import {generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry, toolsRepoter} from './tools/registry';
import {agentLoop, type BudgetState} from './agent/loop';
import {allTools} from './tools/index';
import {MCPClient, MockMCPClient} from './tools/mcp-client';
import {SessionStore} from './session/store';
import {coreRules, deferredTools, memoryContext, PromptBuilder, ragContext, sessionContext, toolGuide, type PromptContext} from './context/prompt-builder';
import {estimateTokens, microcompact, summarize} from './context/compressor';
import {applyDefense, estimateMessageTokens, TokenTracker, truncateToolResults, ttlPrune} from './context/defense';
import {UsageTracker} from './usage/tracker';
import {createToolSearchTool} from './tools/tool-search';
import {createDispatcher, type CommandContext} from './commands';
import {MemoryStore} from './memory/store';
import {createMemoryTool} from './tools/memory-tools';
import {createDashScopeEmbedder, createMockEmbedder, embed} from './rag/embedder';
import {VectorStore} from './rag/store';
import {SqliteVectorStore} from './rag/sqlite-store';
import {createRagTools} from './tools/rag-tools';
import process from 'node:process';
import {SkillLoader, skillRepoter} from './skills/loader';
import {PluginManager, pluginRepoter} from './plugins/manager';
import {supabasePlugin} from './plugins/supabase-plugin';
import {FeishuChannel} from './channels/feishu';
import {ChannelGateway} from './channels/gateway';
import {HookPipeline} from './security/hooks';
import {CronService} from './cron/service';
import {createCronTool} from './tools/cron-tools';
import {contextCommands} from './commands/context';
import {createCronCommands} from './commands/cron';
import {debugCommands} from './commands/debug';
import {dreamCommands} from './commands/dream';
import {memoryCommands} from './commands/memory';
import {ragCommands} from './commands/rag';
import {createSecurityCommands} from './commands/security';
import {createChannelCommands} from './commands/channel';
import {createPluginCommands} from './commands/plugin';
import {createSkillCommands} from './commands/skill';

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
const vectorStore = new SqliteVectorStore('knowledge.db');
const embedFn = process.env.DASHSCOPE_API_KEY
  ? createDashScopeEmbedder(process.env.DASHSCOPE_API_KEY)
  : createMockEmbedder();
registry.register(...createRagTools(vectorStore, embedFn));
/** End ----RAG---- End */

/** Start ----Skills---- Start */
// [TODO]: 实现 skill-tool 给 AI 动态启动卸载 skill
const skillLoader = new SkillLoader('.');
skillLoader.load();
skillRepoter(skillLoader)
/** End ----Skills---- End */

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
    console.log('连接 GitHub MCP Server...');
    try {
      const client = new MCPClient(
        'npx', [ '-y', '@modelcontextprotocol/server-github' ],
        {GITHUB_PERSONAL_ACCESS_TOKEN: githubToken},
      );
      const tools = await registry.registerMCPServer('github', client);
      console.log(`  已注册 ${tools.length} 个 MCP 工具\n`);
      return;
    } catch (err) {
      console.log(`  MCP 连接失败: ${err instanceof Error ? err.message : err}`);
      console.log('  降级为 Mock MCP...\n');
    }
  }

  if (!githubToken) {
    console.log('\n未配置 GITHUB_PERSONAL_ACCESS_TOKEN，使用 Mock MCP');
  }

  const mockClient = new MockMCPClient();
  const tools = await registry.registerMCPServer('github', mockClient);
  console.log(`  已注册 ${tools.length} 个 Mock MCP 工具`);
}

/** Start ----SystemPrompt---- Start */
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
  .pipe('skillContext', () => skillLoader.buildPromptSection())
  .pipe('sessionContext', sessionContext());


// 添加长期记忆后，每轮的 system-prompt 可能会变，改为函数实时构建
function makePromptCtx(messages: ModelMessage[]): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: 'default',
  };
}
/** End ----SystemPrompt---- End */


/** Start ----Hooks---- Start */
const hookPipeline = new HookPipeline();

// 示例 Pre Hook: 写文件前记录日志
hookPipeline.registerPre('audit-log', (toolName, input) => {
  if (toolName === 'write_file' || toolName === 'edit_file') {
    const path = (input as any)?.path || 'unknown';
    console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
  }
  return {action: 'allow'};
});

// 示例 Post Hook: 给 bash 输出加时间戳
hookPipeline.registerPost('bash-timestamp', (toolName, _input, output) => {
  if (toolName === 'bash') {
    const timestamp = new Date().toISOString();
    return {
      action: 'modify',
      modifiedOutput: `[${timestamp}]\n${output}`,
    };
  }
  return {action: 'allow'};
});

registry.setHookPipeline(hookPipeline);
/** End ----Hooks---- End */

/** Start ----Cron---- Start */
// ── Cron Service ────────────────────────────────
const cronService = new CronService('.');
registry.register(createCronTool(cronService));
/** End ----Cron---- End */

/** Start ----Channel---- Start */
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx([])),
});

const FEISHU_PORT = Number(process.env.FEISHU_PORT || '3000');
const feishuChannel = new FeishuChannel({
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  port: FEISHU_PORT,
});
gateway.register(feishuChannel);
/** End ----Channel---- End */

/** Start ----Plugins---- Start */
const pluginManager = new PluginManager(registry, gateway, hookPipeline);
pluginManager.availablePlugins.set('supabase', supabasePlugin)
/** End ----Plugins---- End */

/** Start ----Command---- Start */

const dispatch = createDispatcher([
  ...debugCommands, ...contextCommands, ...memoryCommands,
  ...ragCommands, ...dreamCommands,
  ...createSkillCommands(skillLoader),
  ...createPluginCommands(pluginManager),
  ...createChannelCommands(gateway),
  ...createSecurityCommands(registry, hookPipeline),
  ...createCronCommands(cronService),
]);
/** End ----Command---- End */

async function main() {
  await connectGithubMCP()

  // 启动时自动加载插件
  console.log('加载插件...');
  for (const [ name, def ] of pluginManager.availablePlugins) {
    try {
      await pluginManager.load(def);
      pluginRepoter(pluginManager);
    } catch {
      console.log(`  ✗ ${name} — 加载失败`);
    }
  }

  console.log('启动 Channel...');
  await gateway.startAll();

  cronService.load();
  cronService.setExecutor({
    runAgentPrompt: async (prompt, _timeout) => {
      const cronMessages: ModelMessage[] = [ {role: 'user', content: prompt} ];
      const system = builder.build(makePromptCtx(messages));
      await agentLoop(model, registry, cronMessages, system);
      const lastMsg = cronMessages[ cronMessages.length - 1 ];
      if (!lastMsg) return '(无输出)';
      if (typeof lastMsg.content === 'string') return lastMsg.content;
      if (Array.isArray(lastMsg.content)) {
        return lastMsg.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
      return String(lastMsg.content);
    },
    notify: (message) => {console.log(`\n${message}`);},
  });
  cronService.start();

  toolsRepoter(registry);

  let summary = '';
  let messages: ModelMessage[] = [];

  // Session 持久化
  const timestamps = new Map<number, number>();
  const sessionStore = new SessionStore('default');
  const isContinue = process.argv.includes('--continue');
  if (isContinue && sessionStore.exists()) {
    messages = sessionStore.load().map((entry, idx) => {
      timestamps.set(idx, entry.timestamp)
      return entry.message
    })
    console.log(`\n[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`\n[Session] 新会话`);
  }

  const promptCtx = makePromptCtx(messages)
  // Debug: 显示 Prompt Pipe 各模块状态
  builder.debug(promptCtx);

  const tracker = new UsageTracker('.usage/today.jsonl');
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        cronService.stop();
        await gateway.stopAll();  
        await pluginManager.unloadAll();
        rl.close();
        return;
      }

      const ctx: CommandContext = {
        messages, timestamps, registry, tracker, model,
        builder, makePromptCtx, ask,
        sessionStore, memoryStore, vectorStore,
      };
      const handled = dispatch(trimmed, ctx);
      if (handled === 'async') return;
      if (handled) {ask(); return;}

      const userMsg: ModelMessage = {role: 'user', content: trimmed};
      messages.push(userMsg);
      timestamps.set(messages.length - 1, Date.now());
      sessionStore.append(userMsg);

      // 每次模型执行前都调用 Tools 压缩，降低 LLM 压缩摘要触发频率
      const turnDefense = applyDefense(messages, timestamps);
      messages = turnDefense.messages;

      const currentSystem = builder.build(makePromptCtx(messages));
      const beforeLen = messages.length;

      await agentLoop(model, registry, messages, currentSystem, tracker);

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      const now = Date.now();
      for (let i = beforeLen; i < messages.length; i++) {
        timestamps.set(i, now);
      }
      sessionStore.appendAll(newMessages);

      // 每轮对话后 LLM 压缩检查，作为三层防线的兜底，压缩（user/assistant 消息）
      summary = await compresssor(model, messages, summary);

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

  ask();
}

main().catch(console.error);

// 整个防御体系的执行顺序是：截断（Layer 2）→ TTL 修剪（Layer 3）→ Token 估算（Layer 1，判断是否需要 LLM 压缩）→ 如果需要，触发 Microcompact → 如果还不够，触发 Summarization。
// 采用软删除 + LLM 压缩历史对话的策略，LLM 压缩只在即时防线不够用的时候才触发：
async function compresssor(model: any, messages: ModelMessage[], summary: string): Promise<string> {
  // Check if compaction needed after each turn
  const currentTokens = estimateTokens(messages);

  if (currentTokens > 4000) {
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
  }
  return summary;
}
