import {existsSync, mkdirSync, readFileSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';
import type {ModelMessage} from 'ai';

const SESSION_DIR = '.sessions';

/** JSONL 里的一行，timestamp 用 ISO 8601 落盘，方便直接打开文件看 */
export interface SessionEntry {
  type: 'message';
  timestamp: string;
  message: ModelMessage;
}

export interface LoadedEntry {
  timestamp: number;
  message: ModelMessage;
}

// 兼容早期落盘的毫秒时间戳；解析不出来就当作「刚刚」，避免被 TTL 误修剪
function parseTimestamp(ts: unknown): number {
  if (typeof ts === 'number') return ts;
  const ms = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isNaN(ms) ? Date.now() : ms;
}

export class SessionStore {
  private dir: string;
  private sessionId: string;

  constructor(sessionId: string = 'default') {
    this.sessionId = sessionId;
    this.dir = SESSION_DIR;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, {recursive: true});
    }
  }

  private get filePath(): string {
    return join(this.dir, `${this.sessionId}.jsonl`);
  }

  append(message: ModelMessage): void {
    const entry: SessionEntry = {
      type: 'message',
      timestamp: new Date().toISOString(),
      message,
    };
    appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  appendAll(messages: ModelMessage[]): void {
    for (const msg of messages) {
      this.append(msg);
    }
  }

  load(): LoadedEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];

    const messages: LoadedEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry: SessionEntry = JSON.parse(line);
        if (entry.type === 'message') {
          messages.push({
            timestamp: parseTimestamp(entry.timestamp),
            message: entry.message,
          });
        }
      } catch { /* skip malformed lines */}
    }
    return messages;
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
