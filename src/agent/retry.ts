// --- 错误分类 ---

export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const message = error.message || '';

  // HTTP 状态码判断
  const statusMatch = message.match(/(\d{3})/);
  if (statusMatch) {
    const status = parseInt(statusMatch[ 1 ]);
    if ([ 429, 529, 408 ].includes(status)) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // 网络错误
  if (message.includes('ECONNRESET') || message.includes('EPIPE')) return true;
  if (message.includes('ETIMEDOUT') || message.includes('timeout')) return true;
  if (message.includes('fetch failed') || message.includes('network')) return true;
  // AI SDK 会把流式错误包装成 NoOutputGeneratedError
  if (message.includes('No output generated')) return true;

  return false;
}

// --- 指数退避 + 随机抖动 ---

export function calculateDelay(attempt: number, baseMs = 500, maxMs = 30000): number {
  const exponential = baseMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, maxMs);
  // 随机抖动（±25%），避免"惊群效应"（Thundering Herd）：API 服务端过载返回 429，Agent 等 1 秒后重试。此时所有收到 429 的客户端都在等 1 秒后重试。1 秒后，服务端被又一波请求冲击——更多的 429，更多的等 1 秒，形成一个越来越大的请求洪峰。
  const jitterRange = capped * 0.25;
  const jittered = capped + (Math.random() * 2 - 1) * jitterRange;
  return Math.max(0, Math.round(jittered));
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
