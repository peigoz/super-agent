import 'dotenv/config';
import {generateText, stepCountIs, streamText, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry} from './tools/tool-registry';
import {agentLoop, type BudgetState} from './agent-loop';
import {allTools} from './tools/index';
import {pickSystem} from './prompt';
import {MCPClient, MockMCPClient} from './mcp-client';

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();

const registry = new ToolRegistry();
registry.register(...allTools);
console.log(`已注册 ${registry.getAll().length} 个工具：`);
for (const tool of registry.getAll()) {
  const flags = [
    tool.isConcurrencySafe ? '可并发' : '串行',
    tool.isReadOnly ? '只读' : '读写',
  ].join(', ');
  console.log(`  - ${tool.name}（${flags}）`);
}

const SYSTEM = pickSystem({type: 'web_search'});
const messages: ModelMessage[] = [];
// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = {used: 0, limit: 15000};

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

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

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    messages.push({role: 'user', content: trimmed});

    await agentLoop(model, registry, messages, SYSTEM, budget);

    ask();
  });
}

console.log('Super Agent (type "exit" to quit)\n');
console.log('demo：');
console.log('  1. 找出项目里所有 TODO');
console.log('  2. 去 https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling 看下文档总结');
console.log('  3. 做一个待办清单的网页应用\n');
console.log('  4. 帮我查下oxc的最新动态\n');
await connectMCP()
ask();