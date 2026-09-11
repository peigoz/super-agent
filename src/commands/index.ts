import type {ModelMessage} from 'ai';
import type {ToolRegistry} from '../tools/registry';
import type {PromptBuilder, PromptContext} from '../context/prompt-builder';
import type {UsageTracker} from '../usage/tracker';
import type {SessionStore} from '../session/store';
import type {MemoryStore} from '../memory/store';
import {contextCommands} from './context';
import {debugCommands} from './debug';
import {memoryCommands} from './memory';
import {ragCommands} from './rag';
import {dreamCommands} from './dream';

export interface CommandContext {
  messages: ModelMessage[];
  timestamps: Map<number, number>;
  registry: ToolRegistry;
  builder: PromptBuilder;
  tracker: UsageTracker;
  sessionStore: SessionStore;
  model: any;
  makePromptCtx: () => PromptContext;
  ask: () => void;
  memoryStore?: MemoryStore;
  [ key: string ]: any;
}

export type CommandHandler = (cmd: string, ctx: CommandContext) => boolean | 'async';

export function createDispatcher(handlers: CommandHandler[]): CommandHandler {
  return (cmd, ctx) => {
    for (const h of handlers) {
      const result = h(cmd, ctx);
      if (result) return result;
    }
    return false;
  };
}

export const dispatch = createDispatcher([
  ...debugCommands,
  ...contextCommands,
  ...memoryCommands,
  ...ragCommands,
  ...dreamCommands,
]);