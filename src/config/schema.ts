import {z} from 'zod';

export const ModelConfigSchema = z.object({
  provider: z.enum([ 'dashscope', 'openai', 'custom' ]).default('dashscope'),
  name: z.string().default('qwen-plus-latest'),
  baseURL: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  apiKey: z.string().default(''),
});

export const PluginConfigSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.string()).default({}),
});

export const FeishuChannelConfigSchema = z.object({
  enabled: z.boolean().default(false),
  appId: z.string().default(''),
  appSecret: z.string().default(''),
  port: z.number().default(3000),
});

export const ChannelConfigSchema = z.object({
  feishu: FeishuChannelConfigSchema.prefault({}),
});

export const AgentConfigSchema = z.object({
  maxSpawnDepth: z.number().min(0).max(5).default(1),
  maxConcurrent: z.number().min(1).max(10).default(3),
  defaultTimeout: z.number().default(60000),
});

export const SecurityConfigSchema = z.object({
  defaultRole: z.enum([ 'owner', 'developer', 'guest' ]).default('developer'),
  auditLog: z.boolean().default(true),
  bashTimestamp: z.boolean().default(true),
});

export const MemoryConfigSchema = z.object({
  dataDir: z.string().default('.'),
});

export const RagConfigSchema = z.object({
  enabled: z.boolean().default(true),
  docsDir: z.string().default('docs'),
  storeDir: z.string().default('db'),
  dbFilename: z.string().default('knowledge.db'),
});

export const CronConfigSchema = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().default('.'),
});

export const SessionConfigSchema = z.object({
  id: z.string().default('default'),
});

export const UsageConfigSchema = z.object({
  trackingFile: z.string().default('.usage/today.jsonl'),
});

export const GithubMcpConfigSchema = z.object({
  enable: z.boolean().default(false),
  token: z.string().default("")
})

export const McpConfigSchema = z.object({
  github: GithubMcpConfigSchema.prefault({}),
})

export const SuperAgentConfigSchema = z.object({
  version: z.string().default('1.0'),
  model: ModelConfigSchema.prefault({}),
  plugins: z.array(PluginConfigSchema).default([]),
  channels: ChannelConfigSchema.prefault({}),
  agents: AgentConfigSchema.prefault({}),
  security: SecurityConfigSchema.prefault({}),
  memory: MemoryConfigSchema.prefault({}),
  rag: RagConfigSchema.prefault({}),
  cron: CronConfigSchema.prefault({}),
  session: SessionConfigSchema.prefault({}),
  usage: UsageConfigSchema.prefault({}),
  mcp: McpConfigSchema.prefault({}),
});

export type SuperAgentConfig = z.infer<typeof SuperAgentConfigSchema>;
