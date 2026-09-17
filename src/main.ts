import 'dotenv/config';
import {generateText, stepCountIs, streamText, type LanguageModel, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry, toolsRepoter} from './tools/registry';
import {agentLoop, type BudgetState} from './agent/loop';
import {allTools} from './tools/index';
import {SessionStore} from './session/store';
import {coreRules, deferredTools, memoryContext, multiAgentGuide, PromptBuilder, ragContext, sessionContext, toolGuide, type PromptContext} from './context/prompt-builder';
import {compresssor, estimateTokens, microcompact, summarize} from './context/compressor';
import {applyDefense, estimateMessageTokens, TokenTracker, truncateToolResults, ttlPrune} from './context/defense';
import {UsageTracker} from './usage/tracker';
import {createToolSearchTool} from './tools/tool-search';
import {createDispatcher, type CommandContext} from './commands';
import {MemoryStore} from './memory/store';
import {createMemoryTool} from './tools/memory-tools';
import {createDashScopeEmbedder, createMockEmbedder, embed} from './rag/embedder';
// import {VectorStore} from './rag/store';
import {makeRagByDir, SqliteVectorStore} from './rag/sqlite-store';
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
import {SubAgentRegistry} from './multiple-agent/registry';
import type {SpawnContext} from './multiple-agent/spawn';
import {createSpawnTool} from './tools/spawn-tools';
import {createAgentCommands} from './commands/agent';
import {createSkillTool} from './tools/skill-tools';
import {loadConfig} from './config/loader';
import type {SuperAgentConfig} from './config/schema';
import {connectGithubMCP} from './tools/github-mcp';
import {chunkDocument} from './rag/chunker';

// 加载配置
const config = loadConfig();

function createModel(cfg: SuperAgentConfig[ 'model' ]) {
  if (!cfg.apiKey) return createMockModel();
  const provider = createOpenAI({baseURL: cfg.baseURL, apiKey: cfg.apiKey});
  return provider.chat(cfg.name);
}
const model = createModel(config.model);

/** Start ----Registry---- Start */
const registry = new ToolRegistry();
registry.setRole(config.security.defaultRole);
registry.register(...allTools);
registry.register(createToolSearchTool(registry));
/** End ----Registry---- End */

/** Start ----Memory---- Start */
const memoryStore = new MemoryStore(config.memory.dataDir);
memoryStore.init();
registry.register(createMemoryTool(memoryStore));
/** End ----Memory---- End */

/** Start ----RAG---- Start */
let vectorStore: SqliteVectorStore | undefined = undefined
if (config.rag.enabled) {
  vectorStore = new SqliteVectorStore(config.rag.dbFilename, config.rag.docsDir);
  const embedFn = createDashScopeEmbedder(config.model.apiKey)
  // 已生成过
  // await makeRagByDir({dir: config.rag.docsDir, vectorStore, embedFn})

  registry.register(...createRagTools(vectorStore, embedFn));
}
/** End ----RAG---- End */

/** Start ----Skills---- Start */
const skillLoader = new SkillLoader();
skillLoader.load();
registry.register(createSkillTool(skillLoader))
skillRepoter(skillLoader)
/** End ----Skills---- End */

/** Start ----Hooks---- Start */
const hookPipeline = new HookPipeline();

// 示例 Pre Hook: 写文件前记录日志
if (config.security.auditLog) {
  hookPipeline.registerPre('audit-log', (toolName, input) => {
    if (toolName === 'write_file' || toolName === 'edit_file') {
      const path = (input as any)?.path || 'unknown';
      console.log(`  [audit] 文件写入操作: ${toolName} → ${path}`);
    }
    return {action: 'allow'};
  });
}
// 示例 Post Hook: 给 bash 输出加时间戳
if (config.security.bashTimestamp) {
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
}
registry.setHookPipeline(hookPipeline);
/** End ----Hooks---- End */

/** Start ----Cron---- Start */
// ── Cron Service ────────────────────────────────
let cronService: CronService | undefined = undefined;
if (config.cron.enabled) {
  cronService = new CronService(config.cron.dataDir);
  registry.register(createCronTool(cronService));
}
/** End ----Cron---- End */

/** Start ----Channel---- Start */
const gateway = new ChannelGateway({
  model,
  registry,
  buildSystem: () => builder.build(makePromptCtx([])),
});

if (config.channels.feishu.enabled) {
  const feishuChannel = new FeishuChannel({...config.channels.feishu});
  gateway.register(feishuChannel);
}
/** End ----Channel---- End */

/** Start ----SubAgent---- Start */
// ── Sub-Agent ────────────────────────────────────────
const agentRegistry = new SubAgentRegistry({...config.agents});

function getSpawnCtx(): SpawnContext {
  return {
    model,
    registry,
    agentRegistry,
    buildSystem: () => builder.build(makePromptCtx([])),
    currentDepth: 0,
  };
}

registry.register(createSpawnTool(agentRegistry, getSpawnCtx));
/** End ----SubAgent---- End */

/** Start ----Plugins---- Start */
const pluginManager = new PluginManager(registry, gateway, hookPipeline);
pluginManager.availablePlugins.set('supabase', supabasePlugin)
/** End ----Plugins---- End */

/** Start ----SystemPrompt---- Start */
// Prompt Pipe 组装 system prompt
// 保持 prompt 前缀不变，计算结果就能复用。不变的 section 放前面，变的放后面：
// coreRules — 永远不变，放最前面，cache 稳稳命中。
// toolGuide — 工具数量基本固定，变化很少。
// deferredTools — 所有的工具列表也基本固定，放中间。
// sessionContext — 每次启动都不同，放最后面。
const builder = new PromptBuilder()
  .pipe('coreRules', coreRules())
  .pipe('multiAgent', multiAgentGuide(agentRegistry))
  .pipe('toolGuide', toolGuide())
  .pipe('deferredTools', deferredTools())
  .pipe('memoryContext', memoryContext(memoryStore))
  .pipe('ragContext', ragContext(vectorStore))
  .pipe('skillContext', () => skillLoader.buildPromptSection())
  .pipe('sessionContext', sessionContext());

// 添加长期记忆后，每轮的 system-prompt 可能会变，改为函数实时构建
// sessionId 等也应该跟随会话id自动生成
function makePromptCtx(messages: ModelMessage[]): PromptContext {
  return {
    toolCount: registry.getActiveTools().length,
    deferredToolSummary: registry.getDeferredToolSummary(),
    sessionMessageCount: messages.length,
    sessionId: config.session.id,
  };
}
/** End ----SystemPrompt---- End */

/** Start ----Command---- Start */
const dispatch = createDispatcher([
  ...debugCommands, ...contextCommands, ...memoryCommands,
  ...ragCommands, ...dreamCommands,
  ...createSkillCommands(skillLoader),
  ...createPluginCommands(pluginManager),
  ...createChannelCommands(gateway),
  ...createSecurityCommands(registry, hookPipeline),
  ...createCronCommands(cronService),
  ...createAgentCommands(agentRegistry),
]);
/** End ----Command---- End */

export async function startAgent() {
  if (config.mcp.github.enable) {
    await connectGithubMCP(registry, config.mcp.github)
  }

  // 启动时自动加载插件
  console.log('加载插件...');
  for (const pluginCfg of config.plugins) {
    const def = pluginManager.availablePlugins.get(pluginCfg.name);
    if (!def) {console.log(`  ✗ ${pluginCfg.name} — 未知插件`); continue;}
    try {
      await pluginManager.load(def);
    } catch {
      console.log(`  ✗ ${pluginCfg.name} — 加载失败\n`);
    }
  }
  pluginRepoter(pluginManager);

  console.log('启动 Channel...');
  await gateway.startAll();

  cronService?.load();
  cronService?.setExecutor({
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
  cronService?.start();

  toolsRepoter(registry);

  let summary = '';
  let messages: ModelMessage[] = [];

  // Session 持久化
  const timestamps = new Map<number, number>();
  const sessionStore = new SessionStore(config.session.id);
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

  const tracker = new UsageTracker(config.usage.trackingFile);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        cronService?.stop();
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