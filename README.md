# Super Agent

一个从零实现的 CLI AI Agent 框架，对标 Claude Code 的设计模式。包含完整的 Agent Loop、工具系统、上下文工程、多 Agent 协作、插件/技能扩展机制、可观测性等核心能力，适合学习 Agent 运行时的设计与实现。

## 特性

- **Agent Loop**：主循环 + 循环检测 + 失败重试，REPL 交互形态
- **工具系统**：内置文件读写、Bash、网络抓取、搜索等常驻工具，支持 `shouldDefer` 懒加载（低频工具仅注册摘要，由 `tool_search` 按需取回完整 schema）
- **上下文工程（三层防线）**：Token 估算 → 工具结果截断 / TTL 清理 → LLM 摘要压缩兜底；PromptBuilder 按"前缀稳定优先"顺序组装 system prompt 以命中缓存
- **多 Agent**：`spawn_agent` 同步派生子 Agent，结果回注父上下文，支持深度 / 并发 / 超时限制
- **Skill 系统**：`.skills/<name>/SKILL.md` 渐进式三层加载（frontmatter → 全文 → 参考文件），内置 `code-review`、`web-builder` 示例
- **插件系统**：接口契约、API 隔离、命名空间（`pluginName__toolName`）、生命周期管理、错误隔离，内置 supabase 插件示例
- **Channel 接入**：飞书机器人（Hono webhook），Gateway 统一管理多渠道，每渠道独立会话
- **配置系统**：`super-agent.config.json` + zod schema 校验 + `${ENV_VAR}` 插值 + 交互式 `init` 向导
- **可观测性**：每轮对话落 JSONL trace（敏感字段自动脱敏），token 用量与费用追踪
- **记忆系统**：md 文件式长期记忆 + lint 健康检查 + `/dream` 自主整理
- **RAG**：docs 目录切块 → DashScope embedding → sqlite-vec 向量检索
- **权限与 Hook**：RBAC 三角色（owner/developer/guest）工具管控，pre/post hook 管道与审计日志
- **Cron 定时任务**：Agent 可自主创建定时任务，croner 执行并回注 Agent Loop
- **Vibe Coding 预览**：`start_preview` 在浏览器实时编译预览 Agent 生成的 TSX
- **会话持久化**：JSONL 存储，`--continue` 恢复上次会话
- **Mock 模型**：无 API Key 时自动降级为本地 mock 模型，开箱即跑

## 技术栈

- **语言/运行时**：TypeScript (ESM) + Node 24，tsx 直接运行，无构建步骤
- **LLM**：Vercel AI SDK（`ai` + `@ai-sdk/openai`），默认 DashScope `qwen-plus-latest`（OpenAI 兼容协议）
- **Web**：Hono + @hono/node-server（飞书 webhook）
- **存储**：better-sqlite3 + sqlite-vec（RAG 向量库）
- **其他**：croner（定时）、zod v4（配置校验）、turndown、dotenv

## 快速开始

```bash
# 安装依赖（需 pnpm）
pnpm install

# 交互式配置向导，生成 super-agent.config.json
pnpm init

# 启动 REPL
pnpm start

# 开发模式（tsx watch）
pnpm dev

# 恢复上次会话
pnpm continue

# 查看对话 trace
pnpm trace:inspect
```

在 REPL 中输入消息即可对话，`exit` 退出。未配置 `DASHSCOPE_API_KEY` 时会使用本地 mock 模型。

## 环境变量

通过 `.env` 配置：

| 变量 | 说明 |
| --- | --- |
| `DASHSCOPE_API_KEY` | LLM / embedding（必需，缺失则使用 mock 模型） |
| `TAVILY_API_KEY` / `SERPER_API_KEY` | 网络搜索，按可用 key 自动选择工具 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书渠道接入 |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | GitHub MCP（默认关闭） |

## 项目结构

```
src/
├── index.ts            # bin 入口：init 子命令 或 启动 agent
├── main.ts             # 组装中枢：各子系统初始化 + REPL 主循环
├── mock-model.ts       # 无 API Key 时的本地 mock 模型
├── agent/              # agent loop、循环检测、重试
├── tools/              # ToolRegistry + 内置工具
├── context/            # PromptBuilder、三层防线、上下文压缩
├── multiple-agent/     # SubAgentRegistry、spawn 子 agent
├── plugins/            # PluginManager：契约 / 隔离 / 生命周期
├── skills/             # SkillLoader：渐进式三层加载
├── config/             # zod schema + loader + init 向导
├── security/           # RBAC、HookPipeline、bash 分类器
├── memory/             # MemoryStore：md 文件记忆库
├── rag/                # chunker、embedder、SqliteVectorStore
├── channels/           # ChannelGateway + 飞书渠道
├── cron/               # CronService + parser + store
├── session/            # JSONL 会话持久化
├── trace/              # 本地 trace 记录 + inspect 查看器
├── usage/              # token / 费用追踪
└── commands/           # 斜杠命令 dispatcher
```

运行时数据目录：`.memory/`、`.sessions/`、`.skills/`、`.traces/`、`.usage/`、`.cron/`、`db/knowledge.db`。

## 斜杠命令

REPL 内可用：

| 命令 | 说明 |
| --- | --- |
| `/context` | 查看当前上下文 |
| `/memory` / `/lint` / `/dream` | 记忆库查看 / 校验 / 自主整理 |
| `/rag` | RAG 检索 |
| `/skill list` | 查看已加载技能 |
| `/plugin list` | 查看插件状态 |
| `/channel list` | 查看渠道状态 |
| `/hooks` | 查看 hook 管道 |
| `/usage` | 查看 token 用量 |
| `/status` / `/defend` / `/sim` | 状态 / 防线 / 模拟 |
