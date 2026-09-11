import type {ToolRegistry, ToolDefinition} from '../tools/registry.js';

// 插件系统五个设计决策:
// 1. 接口契约（PluginDefinition）——定义清楚"一个插件长什么样"。这是所有插件系统的起点。不管你做的是 Agent、编辑器、还是构建工具，第一步都是定义这个接口。
// 2. API 隔离层（PluginApi）——插件不直接操作内部，只通过一个受控的中间层交互。比如 VS Code 的 vscode API、Webpack 的 compiler 对象、Express 的 app 对象，都是这个思路，相当于是业界的最佳实践了，好处是你随时能改内部实现，但暴露给插件的 API 层保持稳定。
// 3. 命名空间隔离（pluginName__toolName）——防止不同插件之间的名字冲突。npm 用 scope（@org/pkg），Chrome 扩展用 manifest ID，道理一样。
// 4. 生命周期管理（activate / destroy）——解决资源泄漏问题。任何需要初始化和清理的资源（连接池、文件句柄、定时器），都必须有显式的生命周期。
// 5. 错误隔离——一个插件挂了不影响其他插件，保证基本的稳定性。

export interface PluginConfig {
  [ key: string ]: string | number | boolean;
}

export interface PluginApi {
  registerTools(tools: ToolDefinition[]): void;
  getConfig(): PluginConfig;
  log(message: string): void;
}

export interface PluginDefinition {
  name: string;
  version: string;
  description: string;
  config?: PluginConfig;

  activate(api: PluginApi): Promise<void> | void;
  destroy?(): Promise<void> | void;
}

interface LoadedPlugin {
  definition: PluginDefinition;
  tools: string[];
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private registry: ToolRegistry;

  public availablePlugins = new Map<string, PluginDefinition>();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  async load(definition: PluginDefinition, config?: PluginConfig): Promise<string[]> {
    if (this.plugins.has(definition.name)) {
      throw new Error(`插件 "${definition.name}" 已加载`);
    }

    const resolvedConfig = this.resolveEnvVars({
      ...definition.config,
      ...config,
    });

    const registeredTools: string[] = [];

    const api: PluginApi = {
      registerTools: (tools: ToolDefinition[]) => {
        for (const tool of tools) {
          const prefixedName = `${definition.name}__${tool.name}`;
          const prefixedTool: ToolDefinition = {
            ...tool,
            name: prefixedName,
            description: `[Plugin:${definition.name}] ${tool.description}`,
          };
          this.registry.register(prefixedTool);
          registeredTools.push(prefixedName);
        }
      },
      getConfig: () => resolvedConfig,
      log: (message: string) => {
        console.log(`  [plugin:${definition.name}] ${message}`);
      },
    };

    try {
      await definition.activate(api);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [plugin:${definition.name}] 激活失败: ${msg}`);
      throw err;
    }

    this.plugins.set(definition.name, {
      definition,
      tools: registeredTools,
    });

    return registeredTools;
  }

  async unload(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    if (plugin.definition.destroy) {
      try {
        await plugin.definition.destroy();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  [plugin:${name}] destroy 出错: ${msg}`);
      }
    }

    for (const toolName of plugin.tools) {
      this.registry.unregister(toolName);
    }

    this.plugins.delete(name);
    return true;
  }

  async unloadAll(): Promise<void> {
    const names = Array.from(this.plugins.keys());
    for (const name of names) {
      await this.unload(name);
    }
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): Array<{name: string; version: string; description: string; tools: string[]}> {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.definition.name,
      version: p.definition.version,
      description: p.definition.description,
      tools: p.tools,
    }));
  }

  private resolveEnvVars(config: PluginConfig): PluginConfig {
    const resolved: PluginConfig = {};
    for (const [ key, value ] of Object.entries(config)) {
      if (typeof value === 'string' && value.startsWith('${') && value.endsWith('}')) {
        const envKey = value.slice(2, -1);
        resolved[ key ] = process.env[ envKey ] || '';
      } else {
        resolved[ key ] = value;
      }
    }
    return resolved;
  }
}

export function pluginRepoter(pluginManager: PluginManager) {
  const pluginList = pluginManager.list();

  if (pluginList.length > 0) {
    console.log(`  已加载 ${pluginList.length} 个插件：`);
    for (const p of pluginList) {
      console.log(`    ${p.name} — ${p.tools.join(', ')}`);
    }
    console.log('');
  }
}