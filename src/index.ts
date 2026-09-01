import 'dotenv/config';
import {generateText, stepCountIs, streamText, type ModelMessage} from 'ai';
import {createOpenAI} from '@ai-sdk/openai';
import {createMockModel} from './mock-model';
import {createInterface} from 'node:readline';
import {weatherTool, calculatorTool} from './tools/utility-tools';

const qwen = createOpenAI({
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  apiKey: process.env.DASHSCOPE_API_KEY,
});

const model = process.env.DASHSCOPE_API_KEY
  ? qwen.chat('qwen-plus-latest')
  : createMockModel();
const tools = {get_weather: weatherTool, calculator: calculatorTool};

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});
const messages: ModelMessage[] = [];

function ask() {
  rl.question('\nYou: ', async (input) => {
    const trimmed = input.trim();
    if (!trimmed || trimmed === 'exit') {
      console.log('Bye!');
      rl.close();
      return;
    }

    messages.push({role: 'user', content: trimmed});

    // streamText 加了 tools 和 stopWhen 之后，SDK 内部会自动循环。模型说"我要调 get_weather"，SDK 执行工具，把结果塞回模型，模型拿到真实数据生成最终回复。
    // 这一切发生在 fullStream 的迭代过程中，对你来说就是一个 for-await 循环。
    // 方便，但定制性太差——你没法在步骤之间插入自己的逻辑。打日志、追踪 token、检测死循环、中断执行……这些全都做不了，因为循环被 SDK 藏起来了。
    // 生产级 Agent 几乎都自己控制循环。接下来我们自己实现。
    const result = streamText({
      model,
      system: `system: '你是 Super Agent，一个有工具调用能力的 AI 助手。需要时主动使用工具获取信息，不要编造数据。',`,
      messages,
      tools,
      stopWhen: stepCountIs(5), // 最多跑 5 步
    });

    process.stdout.write('Assistant: ');
    let fullResponse = '';
    for await (const part of result.stream) {
      switch (part.type) {
        case 'text-delta':
          process.stdout.write(part.text);
          fullResponse += part.text;
          break;
        case 'tool-call':
          console.log(`\n  [调用工具: ${part.toolName}(${JSON.stringify(part.input)})]`);
          break;
        case 'tool-result':
          console.log(`  [工具返回: ${JSON.stringify(part.output)}]`);
          break;
      }
    }
    console.log(); // 换行

    messages.push({role: 'assistant', content: fullResponse});

    ask();
  });
}

console.log('Super Agent v0.1 (type "exit" to quit)\n');
ask();
