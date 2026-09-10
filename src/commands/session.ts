import type {CommandHandler} from '.';

export const sessionCommands: CommandHandler[] = [
  // 启动时由 index.ts 按 --continue 决定分发「恢复会话」还是「新会话」
  (cmd, ctx) => {
    if (cmd !== '恢复会话' && cmd !== '/session load' && cmd !== '/continue') return false;
    if (!ctx.sessionStore.exists()) {
      console.log(`\n[Session] 没有可恢复的历史，新会话`);
      return true;
    }
    const messages = ctx.sessionStore.load()
    for (let i = 0; i < messages.length; i++) {
      ctx.timestamps.set(i, messages[ i ].timestamp);
      ctx.messages.push(messages[ i ].message)
    }
    console.log(`\n[Session] 恢复会话，${ctx.messages.length} 条历史消息`);
    return true;
  },
];
