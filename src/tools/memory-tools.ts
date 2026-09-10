import type {MemoryStore} from '../memory/store';
import type {ToolDefinition} from './registry';

// 存储原则：
// 1. 能从代码推导的不存。项目用什么技术栈、目录结构长什么样、某个函数在哪个文件——grep 一下就知道了，存到记忆里反而会过期。
// 2. 能从 git 推导的不存。谁改了什么、上次发布是什么时候——git log 是权威来源。
// 3. 文档里已经有的不存。CLAUDE.md（或你项目里的任何配置文件）里写过的规则，不需要再存一份到记忆里。
// 4. 只存"只存在于对话中、无法从其他地方获取"的信息。 用户的偏好、纠正反馈、项目决策的背景原因、外部资源的位置——这些信息只在对话里出现过一次，如果不存下来，就永远丢了。

// 四种类型，每种类型有不同的触发时机和使用方式：
// user（用户画像）——关于用户是谁的信息。角色、偏好、技术背景、工作习惯。"用户是后端工程师，Go 写了十年但第一次碰 React"——有了这条记忆，解释前端概念时就能用后端类比，而不是从零讲起。
// feedback（行为反馈）——用户对 Agent 行为的纠正和确认。"不要在测试里 mock 数据库"、"单个大 PR 比拆成多个小 PR 好"。这类记忆最重要，因为它直接影响 Agent 的行为模式。纠正的内容和后续确认结果的内容都要存——只存纠正会让 Agent 越来越保守，因为它只知道什么不该做，不知道什么做法被验证过了。
// project（项目动态）——进行中的工作、决策、截止日期。"下周四之前冻结非核心合并，移动端要切分支"。这类记忆衰减最快，过了截止日期就没用了。存的时候要把相对日期转成绝对日期——"下周四"存成 "2026-05-07"，不然一个月后看到"下周四"，完全不知道指的是哪一天。
// reference（外部资源）**——指向外部系统的一个渠道。"bug 跟踪在 Github 看板的 xxx 栏目里"、"oncall 看 Grafana 的 api-latency 面板"。这类记忆帮 Agent 知道去哪里找信息。
export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: 'memory',
    description: '管理跨会话记忆。action: save（保存）| list（列表）| search（搜索）| read（读取）| delete（删除）',
    parameters: {
      type: 'object',
      properties: {
        action: {type: 'string', enum: [ 'save', 'list', 'search', 'read', 'delete', 'lint' ]},
        name: {type: 'string', description: '记忆名称（save 时必填）'},
        description: {type: 'string', description: '一句话描述（save 时必填）'},
        type: {type: 'string', enum: [ 'user', 'feedback', 'project', 'reference' ], description: '记忆类型（save 时必填）'},
        content: {type: 'string', description: '记忆内容（save 时必填）'},
        query: {type: 'string', description: '搜索关键词（search 时必填）'},
        filename: {type: 'string', description: '文件名（read/delete 时必填）'},
      },
      required: [ 'action' ],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      switch (args.action) {
        case 'save': {
          if (!args.name || !args.type || !args.content) {
            return '保存失败：需要 name、type、content 参数';
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          });
          return `已保存到记忆: ${filename}`;
        }
        case 'list': {
          const entries = memoryStore.list();
          if (entries.length === 0) return '当前没有存储任何记忆。';
          return `记忆列表（共 ${entries.length} 条记忆）：\n` +
            entries.map(e => `  [${e.type}] ${e.name} — ${e.description}`).join('\n');
        }
        case 'search': {
          const results = memoryStore.search(args.query || '', 5);
          if (results.length === 0) return `没有找到与 "${args.query}" 相关的记忆。`;
          return `BM25 搜索结果（${results.length} 条）：\n` + results.map(h =>
            `  [score=${h.score.toFixed(2)}] [${h.entry.type}] ${h.entry.name} — ${h.entry.description}`
          ).join('\n');
        }
        case 'read': {
          if (!args.filename) return '读取失败：需要 filename 参数';
          return memoryStore.loadFile(args.filename) ?? `文件不存在: ${args.filename}`;
        }
        case 'delete': {
          if (!args.filename) return '删除失败：需要 filename 参数';
          return memoryStore.delete(args.filename) ? `已删除: ${args.filename}` : `文件不存在: ${args.filename}`;
        }
        case 'lint': {
          const reports = memoryStore.lint();
          if (reports.length === 0) return '记忆库健康，没有发现问题。';
          const lines = [ `记忆库 lint 报告（${reports.length} 条有问题）：`, '' ];
          for (const r of reports) {
            const fname = r.entry.filePath.split('/').pop();
            const preview = r.entry.content.slice(0, 100).replace(/\n/g, ' ');
            lines.push(`📁 ${fname}  [${r.entry.type}] ${r.entry.name}`);
            lines.push(`   内容预览: ${preview}${r.entry.content.length > 100 ? '...' : ''}`);
            for (const issue of r.issues) lines.push(`   • ${issue.kind}: ${issue.message}`);
            lines.push('');
          }
          lines.push('提示: 基于以上报告直接操作即可（delete 删除、save 覆盖更新），不需要逐条 read。');
          return lines.join('\n');
        }
        default:
          return `未知操作: ${args.action}`;
      }
    },
  };
}
