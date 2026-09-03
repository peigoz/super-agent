import 'dotenv/config';
import {generateText, stepCountIs, streamText, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {ToolRegistry} from './tools/tool-registry';
import {agentLoop, type BudgetState} from './agent-loop';
import {allTools} from './tools/index';
import {pickSystem} from './prompt';

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

const messages: ModelMessage[] = [];
// 预算由调用方持有，跨轮持续累计——agentLoop 只负责消费它
const budget: BudgetState = {used: 0, limit: 15000};

const SYSTEM = pickSystem({type: 'web_search'});

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
ask();