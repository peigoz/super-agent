import {type ModelMessage, streamText} from 'ai';
import type {ToolRegistry} from '../tools/registry';
import type {SubAgentRegistry} from './registry';
import type {SpawnRequest} from './types';

export interface SpawnContext {
  model: any;
  registry: ToolRegistry;
  agentRegistry: SubAgentRegistry;
  buildSystem: () => string;
  currentDepth: number;
}

const EXCLUDED_TOOLS = new Set([ 'spawn_agent' ]);

const AGENT_COLORS = [
  '\x1b[36m',  // cyan
  '\x1b[33m',  // yellow
  '\x1b[35m',  // magenta
  '\x1b[32m',  // green
  '\x1b[34m',  // blue
];
const RESET = '\x1b[0m';

function agentTag(index: number, runId: string): string {
  const color = AGENT_COLORS[ index % AGENT_COLORS.length ];
  return `${color}[Agent-${index + 1}:${runId}]${RESET}`;
}

// 子 Agent 的输出作为 spawn_agent 工具的返回值，直接注入父 Agent 的上下文。这么做的特点是同步、单向、零延迟。Claude Code 内部也是这个模式。
// 如果场景需要异步通知（比如子 Agent 跑了好几分钟才完成），可以参考 OpenClaw 接入 Announce Queue 模式 ——— 子 Agent 完成后结果先进队列，有 1 秒的防抖间隔，还有指数退避重试。
export async function spawnAgent(
  request: SpawnRequest,
  ctx: SpawnContext,
  index = 0,
): Promise<string> {
  const {ok, reason} = ctx.agentRegistry.canSpawn(ctx.currentDepth);
  if (!ok) return `[spawn] 拒绝: ${reason}`;

  const runId = ctx.agentRegistry.generateId();
  const tag = agentTag(index, runId);
  const run = {
    id: runId,
    task: request.task,
    status: 'running' as const,
    depth: ctx.currentDepth + 1,
    startedAt: new Date().toISOString(),
  };
  ctx.agentRegistry.register(run);

  const timeout = request.timeout || 60000;
  const maxSteps = 30;
  const ac = new AbortController();
  console.log(`  ${tag} 启动: ${request.task.slice(0, 50)}`);

  // 关键：独立的 messages 数组 = 独立的上下文窗口，Claude Code 用 AsyncLocalStorage 做上下文隔离
  // 长时间运行的 Agent，或者需要各自独立的文件系统操作的场景时业界其他隔离方案：
  // 1. 进程级隔离：通过 tmux 或 iTerm2 启动独立进程，完全独立的内存空间。
  // 2. git worktree 隔离：子 Agent 需要做破坏性的代码修改（比如大规模重构），给它一个独立的 worktree，改坏了不影响主分支。Claude Code 的 isolation: 'worktree' 就是这个——创建一个临时 git worktree，子 Agent 在里面随便改，完成后如果有改动就保留，没改动就自动清理。
  const messages: ModelMessage[] = [
    {role: 'user', content: request.task},
  ];
  try {
    const system = ctx.buildSystem() +
      '\n\n[子 Agent 模式] 你是一个被派出去执行具体任务的子 Agent。直接完成任务并输出结论，保持简洁。' +
      '\n当你需要同时获取多个独立信息时（比如读多个文件、搜多个关键词），尽可能在一次回复中并行调用多个工具，不要一个个串行调。';

    // toAISDKFormatUnlocked 绕过父 Agent 的读写锁；排除 spawn_agent 防递归
    const tools = ctx.registry.toAISDKFormatUnlocked(EXCLUDED_TOOLS);
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      let step = 0;
      while (step < maxSteps) {
        step++;
        const isLastStep = step === maxSteps;
        console.log(`  ${tag} Step ${step}/${maxSteps}${isLastStep ? ' (总结)' : ''}`);
        if (isLastStep) {
          messages.push({role: 'user', content: '你已经收集了足够的信息。请直接输出文字总结，不要再调用任何工具。'});
        }
        const result = streamText({
          model: ctx.model, system,
          tools,
          toolChoice: isLastStep ? 'none' : 'auto',
          messages,
          maxRetries: 0,
          abortSignal: ac.signal,
          providerOptions: {openai: {parallelToolCalls: true}},
          onError: () => { },
        });
        let hasToolCall = false;
        for await (const part of result.stream) {
          if (part.type === 'tool-call') {
            hasToolCall = true;
            const argsPreview = JSON.stringify(part.input).slice(0, 80);
            console.log(`  ${tag} 调用 ${part.toolName}(${argsPreview})`);
          }
        }
        const finalStep = await result.finalStep;
        const stepResponse = finalStep.response;
        messages.push(...stepResponse.messages);
        if (!hasToolCall) break;
      }
    } finally {
      clearTimeout(timer);
    }

    // 提取最后一条 assistant 消息作为结果
    const lastAssistant = [ ...messages ].reverse().find(m => m.role === 'assistant');
    let result = '(无输出)';
    if (lastAssistant) {
      if (typeof lastAssistant.content === 'string') {
        result = lastAssistant.content;
      } else if (Array.isArray(lastAssistant.content)) {
        result = lastAssistant.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('') || '(无输出)';
      }
    }

    ctx.agentRegistry.complete(runId, result);
    console.log(`  ${tag} 完成 ✓ (${result.length} 字符)`);
    return result;
  } catch (err: any) {
    const isAbort = err.name === 'AbortError' || ac.signal.aborted;
    const errorMsg = isAbort ? `执行超时 (${timeout / 1000}s)` : (err.message || String(err));
    ctx.agentRegistry.fail(runId, errorMsg);
    console.log(`  ${tag} ${isAbort ? '超时' : '失败'} ✗: ${errorMsg}`);
    if (isAbort) {
      const partial = [ ...messages ].reverse().find(m => m.role === 'assistant');
      if (partial) {
        const text = typeof partial.content === 'string' ? partial.content
          : Array.isArray(partial.content)
            ? partial.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('')
            : '';
        if (text) return `[部分结果] ${text}`;
      }
    }
    return `[sub-agent 执行失败] ${errorMsg}`;
  }
}

export async function spawnParallel(
  requests: SpawnRequest[],
  ctx: SpawnContext,
): Promise<Array<{task: string; result: string}>> {
  console.log(`\n  ┌─ 派发 ${requests.length} 个子 Agent 并行执行 ─┐`);
  const results = await Promise.all(
    requests.map(async (req, i) => {
      const result = await spawnAgent(req, ctx, i);
      return {task: req.task, result};
    })
  );
  console.log(`  └─ 全部完成 (${results.length}/${requests.length}) ─┘\n`);
  return results;
}
