import type {CommandHandler} from './index.js';
import type {ChannelGateway} from '../channels/gateway.js';
import {gateway} from 'ai';

export const channelCommands: CommandHandler[] = [
  (cmd, ctx) => {
    if (cmd !== '/channel' && cmd !== '/channel list') return false;

    const channels = ctx.gateway.list();
    if (channels.length === 0) {
      console.log('\n[channels] 没有注册的通道。\n');
      return true;
    }

    console.log('\n[channels]');
    for (const ch of channels) {
      console.log(`  ${ch.name} — ${ch.description}`);
    }
    console.log('');
    return true;
  },
];
