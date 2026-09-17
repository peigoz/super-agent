import {appendFile, mkdir, readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {ModelMessage} from 'ai';
import type {StepUsage} from '../usage/tracker';

type TraceStatus = 'completed' | 'failed' | 'cancelled';

interface TraceOptions {
  directory?: string;
  sessionId: string;
  model: string;
}

interface StepStartedInput {
  step: number;
  system: string;
  messages: ModelMessage[];
}

interface StepCompletedInput {
  step: number;
  text: string;
  outputMessages: ModelMessage[];
  usage: StepUsage;
}

const SECRET_KEY = /api[-_]?key|token|secret|password|authorization/i;

function sanitize(value: unknown, key = ''): unknown {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([ childKey, childValue ]) => [ childKey, sanitize(childValue, childKey) ]),
    );
  }
  return value;
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'default';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Trace 生产约束:
// 1. 保留周期。生产环境根据排障和合规要求设置 7～30 天，然后定时清理或归档。
// 2. 大小上限。对单个字段和单条 Trace 设置大小上限，把大对象改成引用：
// 3. 采样。调试阶段可以 100% 记录，流量上来以后可以保留全部失败 Trace，只随机保留一部分成功 Trace。否则可观测性成本会比较高。
// 分布式部署时要替换最后的存储层，把 JSONL 上传到云端的对象存储里面，比如阿里云的 OSS。上传完之后，把对应的 OSS 链接存入你的业务数据库表
// 数据库表字段例子：
interface TraceIndex {
  traceId: string;
  sessionId: string;
  status: 'completed' | 'failed' | 'cancelled';
  storageUrl: string;
  stepCount: number;
  totalTokens: number;
  durationMs: number;
  createdAt: Date;
}
// [TODO]: 在多入口系统里，CLI、飞书、Cron Job、Sub-Agent 都可以创建自己的 Trace。还可以给 Recorder 加 parentTraceId，把子 Agent 的 Trace 和父 Agent 串成一棵树。
export class LocalTraceRecorder {
  readonly traceId: string;
  readonly filePath: string;
  private readonly startedAt = Date.now();
  private readonly stepStartedAt = new Map<number, number>();
  private writeFailed = false;

  constructor(private readonly options: TraceOptions) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.traceId = `${safeName(this.options.sessionId)}-${stamp}`;
    this.filePath = join(this.options.directory ?? '.traces', `${this.traceId}.jsonl`);
  }

  static async start(options: TraceOptions): Promise<LocalTraceRecorder> {
    const recorder = new LocalTraceRecorder(options);
    await mkdir(dirname(recorder.filePath), {recursive: true});
    await recorder.write({
      type: 'trace_started',
      traceId: recorder.traceId,
      sessionId: options.sessionId,
      model: options.model,
      timestamp: new Date().toISOString(),
    });
    return recorder;
  }

  async recordStepStarted(input: StepStartedInput): Promise<void> {
    this.stepStartedAt.set(input.step, Date.now());
    await this.write({
      type: 'step_started',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      context: sanitize({system: input.system, messages: input.messages}),
    });
  }

  async recordAttemptError(step: number, attempt: number, error: unknown): Promise<void> {
    await this.write({
      type: 'step_attempt_failed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step,
      attempt,
      error: errorMessage(error),
    });
  }

  async recordStepCompleted(input: StepCompletedInput): Promise<void> {
    const startedAt = this.stepStartedAt.get(input.step) ?? Date.now();
    await this.write({
      type: 'step_completed',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      step: input.step,
      durationMs: Date.now() - startedAt,
      output: sanitize({text: input.text, messages: input.outputMessages}),
      usage: input.usage,
    });
  }

  async finish(status: TraceStatus, error?: unknown): Promise<void> {
    await this.write({
      type: 'trace_finished',
      traceId: this.traceId,
      timestamp: new Date().toISOString(),
      status,
      durationMs: Date.now() - this.startedAt,
      ...(error === undefined ? {} : {error: errorMessage(error)}),
    });
  }

  private async write(event: Record<string, unknown>): Promise<void> {
    if (this.writeFailed) return;
    try {
      await appendFile(this.filePath, JSON.stringify(event) + '\n', 'utf8');
    } catch (error) {
      this.writeFailed = true;
      console.warn(`  [Trace] 写入失败，已停止记录: ${errorMessage(error)}`);
    }
  }
}

export async function inspectTrace(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  const events = content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = events.find(event => event.type === 'trace_started');
  const finished = [ ...events ].reverse().find(event => event.type === 'trace_finished');
  const lines = [ `Trace ${started?.traceId ?? filePath}` ];

  for (const event of events) {
    if (event.type === 'step_started') {
      lines.push(`  Step ${event.step}: context ${event.context.messages.length} messages`);
    }
    if (event.type === 'step_completed') {
      const toolCalls = event.output.messages
        .flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
        .filter((part: any) => part.type === 'tool-call')
        .map((part: any) => part.toolName);
      const tools = toolCalls.length > 0 ? ` · tools: ${toolCalls.join(', ')}` : '';
      lines.push(`    completed in ${event.durationMs}ms · ${event.usage.inputTokens + event.usage.outputTokens} tokens${tools}`);
    }
  }

  lines.push(`  Status: ${finished?.status ?? 'incomplete'}`);
  return lines.join('\n');
}