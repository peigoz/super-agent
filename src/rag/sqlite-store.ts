import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type {Chunk} from './chunker';
import type {StoredChunk} from './store';
import type {EmbeddingFn} from './embedder';
import {mmrSelect, type SearchResult} from './search';
import {embed} from './embedder';

const STORE_DIR = 'db'

export class SqliteVectorStore {
  private db: Database.Database;

  constructor(dbFilename: string = 'knowledge.db') {
    // 用 resolve 而非 join：外部传绝对路径时能正确覆盖 baseDir，
    // join 会把 '/tmp/x.db' 拼成 'db/tmp/x.db' 这种意外路径
    const dbPath = path.resolve(STORE_DIR, dbFilename);
    // better-sqlite3 不会自动建父目录，目录不存在时会直接报 unable to open database file
    fs.mkdirSync(path.dirname(dbPath), {recursive: true});
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);       // 加载向量搜索扩展
    this.createTables();
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[128]
      );

      -- trigram 分词器：按「每 3 个连续字符」建索引，天生支持中文子串匹配。
      -- 默认的 unicode61 会把整串中文当成一个 token，导致 MATCH 基本搜不动。
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        source UNINDEXED,
        tokenize = 'trigram'
      );
    `);
  }

  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now();
    // 三表联动写入
    this.db.prepare(`INSERT OR REPLACE INTO chunks
      (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(chunk.id, chunk.text, chunk.source, chunk.index,
        JSON.stringify(embedding), now);

    this.db.prepare(`INSERT OR REPLACE INTO chunks_vec (id, embedding)
      VALUES (?, ?)`)
      .run(chunk.id, Buffer.from(new Float32Array(embedding).buffer));

    this.db.prepare(`INSERT OR REPLACE INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`)
      .run(chunk.id, chunk.text, chunk.source);
  }

  addBatch(items: Array<{chunk: Chunk; embedding: number[]}>): void {
    const tx = this.db.transaction(() => {
      for (const {chunk, embedding} of items) this.add(chunk, embedding);
    });
    tx();  // 事务批量写入，比逐条快很多
  }

  vectorSearch(queryEmbedding: number[], topK: number): Array<{chunk: StoredChunk; score: number}> {
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    const rows = this.db.prepare(`
      SELECT v.id, v.distance, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_vec v
      JOIN chunks c ON c.id = v.id
      WHERE v.embedding MATCH ?
        AND k = ?
    `).all(buf, topK) as any[];

    return rows.map(r => ({
      chunk: {
        id: r.id, text: r.text, source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        addedAt: 0,
      },
      score: 1 - r.distance,  // cosine distance → similarity
    }));
  }

  keywordSearch(query: string, topK: number): Array<{chunk: StoredChunk; score: number}> {
    const match = buildMatchQuery(query);
    // trigram 下少于 3 字符的词永远匹配不到，整句都是短词时直接放弃关键词路，
    // 靠向量路兜底（embedding 对短查询依然有效）。
    if (!match) return [];

    const rows = this.db.prepare(`
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index, c.embedding
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(match, topK) as any[];

    return rows.map(r => ({
      chunk: {
        id: r.id, text: r.text, source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
        embedding: JSON.parse(r.embedding),
        addedAt: 0,
      },
      score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
    }));
  }

  size(): number {
    return (this.db.prepare('SELECT COUNT(*) as n FROM chunks').get() as any).n;
  }

  clear(): void {
    this.db.exec('DELETE FROM chunks; DELETE FROM chunks_vec; DELETE FROM chunks_fts;');
  }

  sources(): string[] {
    return (this.db.prepare('SELECT DISTINCT source FROM chunks').all() as any[]).map(r => r.source);
  }

  // 混合搜索：直接在 SQLite 层完成向量 + 关键词双路检索
  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const candidateCount = Math.min(topK * 4, this.size());
    if (candidateCount === 0) return [];

    const [ queryVec ] = await embed(embedFn, [ query ]);

    // 路径 1: sqlite-vec 向量搜索
    const vectorResults = this.vectorSearch(queryVec, candidateCount);

    // 路径 2: FTS5 关键词搜索
    const keywordResults = this.keywordSearch(query, candidateCount);

    // 归一化 + 加权合并
    const vecScores = normalizeMinMax(vectorResults.map(r => r.score));
    const kwScores = normalizeMinMax(keywordResults.map(r => r.score));

    const candidates = new Map<string, SearchResult>();
    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[ i ].chunk.id;
      candidates.set(id, {
        chunk: vectorResults[ i ].chunk,
        score: vecScores[ i ] * 0.7,
        vectorScore: vecScores[ i ],
        keywordScore: 0,
      });
    }
    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[ i ].chunk.id;
      const existing = candidates.get(id);
      if (existing) {
        existing.keywordScore = kwScores[ i ];
        existing.score += kwScores[ i ] * 0.3;
      } else {
        candidates.set(id, {
          chunk: keywordResults[ i ].chunk,
          score: kwScores[ i ] * 0.3,
          vectorScore: 0,
          keywordScore: kwScores[ i ],
        });
      }
    }

    const sorted = [ ...candidates.values() ]
      .sort((a, b) => b.score - a.score);

    // MMR deduplication
    return mmrSelect(sorted, topK);
  }
}

// FTS5 的 MATCH 串是一门小语法：AND / OR / NOT / NEAR、双引号短语、`列名:` 过滤器、`*` 前缀。
// 把用户原始输入直接塞进去，轻则 `配置-说明` 这种带 `-` 的查询抛 syntax error，
// 重则输入的 AND/OR 被当成操作符改变语义；而 trigram 下空白也会计入子串，
// 于是「如何配置 API」会被当成一个连续短语去找，多词查询直接全落空。
// 所以这里拆词后逐个用双引号包成短语，再 OR 连接：
// 引号内一律按字面量处理（内部引号双写转义），trigram 下短语即子串匹配，正好贴合中文。
function buildMatchQuery(query: string): string {
  return query
    .split(/[\s\p{P}\p{S}]+/u)
    // 少于 3 个字符的词 trigram 索引里不存在，留着只会拖低召回
    .filter(t => [ ...t ].length >= 3)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map(s => (s - min) / range);
}
