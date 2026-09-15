import type {ChannelDefinition} from '../channels/types';
import type {ToolDefinition} from '../tools/registry';
import type {PreToolHook, PostToolHook} from '../security/hooks';

export interface PluginConfig {
  [ key: string ]: string | number | boolean;
}

/** Hook 的执行阶段 */
export type HookType = 'pre' | 'post';
export type HookFn<T extends HookType> = T extends 'pre' ? PreToolHook : PostToolHook;
export interface PluginApi {
  registerTools(tools: ToolDefinition[]): void;
  registerChannel(channel: ChannelDefinition): void;  // 新增
  registerHook(type: HookType, {name, fn}: {name: string; fn: HookFn<HookType>}): void;
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