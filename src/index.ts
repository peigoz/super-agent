import 'dotenv/config';
import {generateText, stepCountIs, streamText, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry, type ToolDefinition} from './tools/tool-registry';
import {agentLoop, type BudgetState} from './agent/loop';
import {allTools} from './tools/index';
import {pickSystem} from './context/prompt';
import {MCPClient, MockMCPClient} from './mcp-client';
import {SessionStore} from './session/store';

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

const registry = new ToolRegistry();
registry.register(toolSearchTool);
registry.register(...allTools);

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

  const qwen = createOpenAI({
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: process.env.DASHSCOPE_API_KEY,
  });

  const model = process.env.DASHSCOPE_API_KEY
    ? qwen.chat('qwen-plus-latest')
    : createMockModel();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
  const budget: BudgetState = {used: 0, limit: 15000};
  const SYSTEM = pickSystem({type: 'web_search', deferredTools: registry.getDeferredToolSummary()});

  // Session 持久化
  const isContinue = process.argv.includes('--continue');
  const store = new SessionStore('default');

  let messages: ModelMessage[] = [];
  if (isContinue && store.exists()) {
    messages = store.load();
    console.log(`\n[Session] 恢复会话，${messages.length} 条历史消息`);
  } else {
    console.log(`\n[Session] 新会话`);
  }

  function ask() {
    rl.question('\nYou: ', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit') {
        console.log('Bye!');
        rl.close();
        return;
      }

      const userMsg: ModelMessage = {role: 'user', content: trimmed};
      messages.push(userMsg);
      store.append(userMsg);

      const beforeLen = messages.length;

      await agentLoop(model, registry, messages, SYSTEM, budget);

      // 持久化本轮新增的消息（agent loop 会往 messages 里 push assistant/tool 消息）
      const newMessages = messages.slice(beforeLen);
      store.appendAll(newMessages);

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
