// Merkezi yapılandırma. Tüm değerler ortam değişkenleriyle (env) ezilebilir.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function intEnv(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function listEnv(name, fallback = []) {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  baseUrl: process.env.KOLSCAN_BASE_URL || 'https://kolscan.io',

  // Çıktı klasörü (JSON birikimi burada)
  dataDir: process.env.KOLSCAN_DATA_DIR || path.join(ROOT, 'data'),

  // Tarayıcı
  headless: process.env.KOLSCAN_HEADFUL ? false : true,
  // Cloudflare bazen headless'ı yakalar; takılırsan KOLSCAN_HEADFUL=1 ile dene.
  userAgent:
    process.env.KOLSCAN_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  locale: process.env.KOLSCAN_LOCALE || 'en-US',
  navTimeoutMs: intEnv('KOLSCAN_NAV_TIMEOUT_MS', 60_000),

  // Zamanlama (ms)
  leaderboardIntervalMs: intEnv('KOLSCAN_LEADERBOARD_INTERVAL_MS', 5 * 60_000), // 5 dk
  walletIntervalMs: intEnv('KOLSCAN_WALLET_INTERVAL_MS', 10 * 60_000), // 10 dk
  // Trade akışı sürekli açık kalır; bağlantı koparsa şu aralıkla yeniden bağlanır:
  tradesReconnectMs: intEnv('KOLSCAN_TRADES_RECONNECT_MS', 15_000),

  // Leaderboard
  timeframes: listEnv('KOLSCAN_TIMEFRAMES', ['daily', 'weekly', 'monthly']),
  // Sonsuz kaydırmada en fazla kaç kez "dibe in"
  leaderboardMaxScrolls: intEnv('KOLSCAN_LEADERBOARD_MAX_SCROLLS', 40),
  scrollSettleMs: intEnv('KOLSCAN_SCROLL_SETTLE_MS', 900),

  // İzlenecek cüzdanlar (virgülle ayır): KOLSCAN_WALLETS=addr1,addr2
  wallets: listEnv('KOLSCAN_WALLETS', []),

  // Retry/backoff
  maxRetries: intEnv('KOLSCAN_MAX_RETRIES', 4),
  retryBaseMs: intEnv('KOLSCAN_RETRY_BASE_MS', 2_000),
};

export function leaderboardUrl() {
  return `${config.baseUrl}/leaderboard`;
}
export function tradesUrl() {
  return `${config.baseUrl}/trades`;
}
export function walletUrl(address) {
  // kolscan cüzdan sayfası; pattern değişirse KOLSCAN_WALLET_PATH ile ezilebilir.
  const tpl = process.env.KOLSCAN_WALLET_PATH || '/account/{addr}';
  return `${config.baseUrl}${tpl.replace('{addr}', address)}`;
}
