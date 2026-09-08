import {fetchUrlTool, pickSearchTool, startPreviewTool, webFetchTool} from './web-tools.js';
import {weatherTool, calculatorTool} from './utility-tools.js';
import {readFileTool, writeFileTool, editFileTool, listDirectoryTool} from './file-tools.js';
import {globTool, grepTool} from './search-tools.js';
import {bashTool} from './bash-tools.js';
import type {ToolDefinition} from './tool-registry.js';


// 工具的 description 和 inputSchema 里的属性 description，本质上就是在写 prompt。 
// 写得越清楚、越具体，模型调用的准确率就越高。"查天气"不如"查询指定城市的实时天气信息，包括温度、风向等"

// Claude Code 提供的 30+ 工具集，部分标记了 shouldDefer: true 懒加载。通过 ToolSearch 返回匹配工具的完整 Schema 定义
// 核心工具：Read、Edit、Write、Bash、Grep、Glob、Agent、Skill——这些几乎每次对话都要用，永远加载。
// 低频工具**：WebSearch、WebFetch、NotebookEdit、LSP、Cron、Task 管理、Plan Mode、Config——增加 shouldDefer 标记。

export const allTools: ToolDefinition[] = [
  weatherTool, calculatorTool, readFileTool, writeFileTool, editFileTool,
  listDirectoryTool, globTool, grepTool, bashTool, fetchUrlTool, startPreviewTool,
  pickSearchTool(), webFetchTool,
];
