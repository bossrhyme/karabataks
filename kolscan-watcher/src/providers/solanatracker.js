// Solana Tracker provider — kolscan'e gerek kalmadan GERÇEK API'den veri.
//
// İki şeyi doldurur (dashboard'un okuduğu aynı data/ dosyaları):
//   - data/leaderboard/<tf>.json   ← GET /v2/pnl/leaderboard/kols
//   - data/trades.jsonl            ← Datastream WebSocket (gerçek zamanlı)
//
// API anahtarı ZORUNLU ve env'den okunur:  SOLANATRACKER_API_KEY=...
// Ücretsiz katman için: https://www.solanatracker.io/data-api  ·  Docs: https://docs.solanatracker.io
//
// NOT: Endpoint yolları ve alan adları Solana Tracker dokümanına göre küçük
// farklar gösterebilir; aşağıdaki eşlemeler toleranslı yazıldı, gerekirse
// BASE_URL / path / alan adlarını tek satırda güncelleyebilirsin.
import { writeSnapshot, appendLine, DedupeStore, nowIso } from '../store.js';
import { extractArray, sleep, withRetry } from '../util.js';
import { makeLogger } from '../log.js';

const log = makeLogger('solanatracker');

const BASE_URL = process.env.SOLANATRACKER_BASE_URL || 'https://data.solanatracker.io';
const WS_URL = process.env.SOLANATRACKER_WS_URL || 'wss://datastream.solanatracker.io';
const API_KEY = process.env.SOLANATRACKER_API_KEY || '';

// kolscan timeframe -> gün
const TF_DAYS = { daily: 1, weekly: 7, monthly: 30 };

function requireKey() {
  if (!API_KEY) {
    throw new Error(
      'SOLANATRACKER_API_KEY tanımlı değil. Ücretsiz anahtar: https://www.solanatracker.io/data-api'
    );
  }
}

async function apiGet(path, params = {}) {
  requireKey();
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { 'x-api-key': API_KEY, accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${url.pathname} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// --- Leaderboard ----------------------------------------------------------
// Ham kaydı dashboard'un okuduğu alan adlarına normalize eder (alias ekler, ham veriyi korur).
function normalizeTrader(r, i) {
  const wallet = r.wallet || r.wallet_address || r.address || r.owner || null;
  const pnlUsd = r.pnl ?? r.pnl_usd ?? r.realized ?? r.realizedPnl ?? r.total ?? null;
  const wins = r.wins ?? r.win ?? r.winning ?? null;
  const losses = r.losses ?? r.loss ?? r.losing ?? null;
  const winPct = r.winPercentage ?? r.win_rate ?? r.winRate ?? null;
  return {
    rank: r.rank ?? i + 1,
    trader_name: r.name || r.username || r.label || null,
    wallet_address: wallet,
    _wallet: wallet,
    pnl_usd: pnlUsd,
    pnl_sol: r.pnl_sol ?? r.solPnl ?? null,
    wins,
    losses,
    win_rate: winPct,
    ...r, // ham alanları da koru
  };
}

export async function fetchLeaderboard(timeframe, { limit = 100 } = {}) {
  requireKey(); // anahtar yoksa retry etmeden hemen başarısız ol
  return withRetry(`st-leaderboard ${timeframe}`, async () => {
    const days = TF_DAYS[timeframe] ?? 1;
    // kolscan KOL listesi endpoint'i; alternatif: /v2/pnl/leaderboard/top
    const json = await apiGet('/v2/pnl/leaderboard/kols', { days, limit });
    const rows = extractArray(json).map(normalizeTrader);
    const stamp = nowIso();
    await writeSnapshot(`leaderboard/${timeframe}.json`, {
      timeframe,
      capturedAt: stamp,
      source: 'solanatracker',
      count: rows.length,
      records: rows,
    });
    await appendLine(`leaderboard/${timeframe}.history.jsonl`, {
      capturedAt: stamp,
      count: rows.length,
      top: rows.slice(0, 10).map((r) => ({
        wallet: r._wallet,
        name: r.trader_name,
        pnl_usd: r.pnl_usd,
        win_rate: r.win_rate,
      })),
    });
    log.info(`${timeframe}: ${rows.length} KOL yazıldı`);
    return rows.length;
  });
}

export async function fetchAllLeaderboards(timeframes = ['daily', 'weekly', 'monthly']) {
  const out = {};
  for (const tf of timeframes) {
    try {
      out[tf] = await fetchLeaderboard(tf);
    } catch (e) {
      log.error(`${tf} başarısız: ${e.message}`);
      out[tf] = 0;
    }
  }
  return out;
}

// --- Canlı trade akışı (Datastream WebSocket) -----------------------------
function normalizeTrade(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw.tx || raw.trade || raw.data || raw;
  const side = (t.type || t.side || '').toString().toLowerCase();
  return {
    capturedAt: nowIso(),
    source: 'solanatracker',
    signature: t.signature || t.tx || t.txHash || t.id || null,
    wallet: t.wallet || t.owner || t.trader || null,
    trader_name: t.name || t.username || null,
    side: side.includes('buy') ? 'buy' : side.includes('sell') ? 'sell' : side || null,
    token: t.token?.symbol || t.symbol || t.tokenSymbol || t.token || null,
    tokenAddress: t.token?.mint || t.mint || t.tokenAddress || null,
    amount_sol: t.solAmount ?? t.amount_sol ?? t.sol ?? null,
    amount_usd: t.volume ?? t.amount_usd ?? t.usd ?? null,
    amount_token: t.tokenAmount ?? t.amount ?? null,
    price: t.price ?? null,
    timestamp: t.time ?? t.timestamp ?? t.blockTime ?? null,
    _raw: raw,
  };
}

const tradeKey = (t) =>
  t.signature || [t.wallet, t.token, t.timestamp].filter(Boolean).join('|') || JSON.stringify(t);

// Datastream'e bağlanır, KOL/trade kanalına abone olur ve trades.jsonl'a biriktirir.
// Reconnect döngülüdür; stop() ile durdurulur.
export class TradeStream {
  constructor({ reconnectMs = 15_000 } = {}) {
    this.store = new DedupeStore('trades.jsonl', tradeKey);
    this.reconnectMs = reconnectMs;
    this.running = false;
    this.ws = null;
    this.total = 0;
  }

  async start() {
    requireKey();
    await this.store.load();
    this.running = true;
    while (this.running) {
      try {
        await this._connectOnce();
      } catch (e) {
        log.error(`stream hatası: ${e.message}`);
      }
      if (this.running) {
        log.warn(`${this.reconnectMs}ms sonra yeniden bağlanılıyor...`);
        await sleep(this.reconnectMs);
      }
    }
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      // Anahtar bazı Datastream kurulumlarında query param ile verilir.
      const url = `${WS_URL}/${encodeURIComponent(API_KEY)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      let settled = false;
      const done = (fn, arg) => {
        if (!settled) {
          settled = true;
          fn(arg);
        }
      };

      ws.onopen = () => {
        log.info('Datastream bağlı, abone olunuyor...');
        // Genel "son işlemler" kanalı; doküman farklıysa room adını güncelle.
        for (const room of ['latest', 'transaction', 'kol-trades']) {
          try {
            ws.send(JSON.stringify({ type: 'join', room }));
          } catch {}
        }
      };

      ws.onmessage = async (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        } catch {
          return;
        }
        const payload = msg.data ?? msg.tx ?? msg;
        const items = Array.isArray(payload) ? payload : [payload];
        const norm = items.map(normalizeTrade).filter((t) => t && t.signature);
        if (norm.length) {
          const added = await this.store.addMany(norm).catch(() => 0);
          if (added) {
            this.total += added;
            log.info(`+${added} trade (datastream) — toplam ${this.total}`);
          }
        }
      };

      ws.onclose = () => {
        log.warn('Datastream kapandı');
        done(resolve);
      };
      ws.onerror = (e) => {
        done(reject, new Error(e?.message || 'ws error'));
      };
    });
  }

  stop() {
    this.running = false;
    try {
      this.ws?.close();
    } catch {}
  }
}
