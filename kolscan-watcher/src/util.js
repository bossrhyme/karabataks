import { config } from './config.js';
import { makeLogger } from './log.js';

const log = makeLogger('util');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Üstel backoff ile yeniden dener. fn() bir promise döndürmeli.
export async function withRetry(label, fn, { retries = config.maxRetries } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const wait = config.retryBaseMs * 2 ** attempt;
      log.warn(`${label} başarısız (deneme ${attempt + 1}/${retries + 1}): ${e.message}. ${wait}ms sonra tekrar.`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Birden çok olası JSON yapısından kayıt dizisini güvenle çıkarır.
// kolscan API'leri farklı sarmalayıcılar kullanabilir: {data:[...]}, {result:[...]}, [...] vb.
export function extractArray(json) {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== 'object') return [];
  for (const key of ['data', 'result', 'results', 'items', 'trades', 'leaderboard', 'rows']) {
    if (Array.isArray(json[key])) return json[key];
  }
  // tek seviye iç içe: {data:{items:[...]}}
  for (const v of Object.values(json)) {
    if (v && typeof v === 'object') {
      const inner = extractArray(v);
      if (inner.length) return inner;
    }
  }
  return [];
}
