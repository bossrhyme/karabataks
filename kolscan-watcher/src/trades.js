// Gerçek zamanlı trade akışı izleyicisi.
//
// kolscan.io/trades canlı bir akış. Veri kaynağını kesin bilmediğimiz için üç
// yöntemi birden dinleriz ve normalize edip dedupe ederek biriktiririz:
//   1) WebSocket frame'leri (en olası gerçek zamanlı kaynak)
//   2) XHR/fetch JSON yanıtları (/api/trades vb.)
//   3) DOM fallback — akış satırlarını periyodik okur (API değişirse güvence)
// Tümü tek bir DedupeStore'a (data/trades.jsonl) yazar.
import { newPage, gotoWithChallenge } from './browser.js';
import { config, tradesUrl } from './config.js';
import { DedupeStore, nowIso } from './store.js';
import { extractArray, sleep } from './util.js';
import { makeLogger } from './log.js';

const log = makeLogger('trades');

// Bir trade kaydı için benzersiz anahtar: imza/hash, yoksa alanların birleşimi.
function tradeKey(t) {
  return (
    t.signature ||
    t.txHash ||
    t.tx ||
    t.hash ||
    t.id ||
    [t.wallet, t.token, t.amount, t.side, t.timestamp].filter(Boolean).join('|') ||
    JSON.stringify(t)
  );
}

// Ham kaydı tek tip şemaya indirger (orijinali _raw'da saklar).
function normalize(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const wallet =
    raw.wallet_address || raw.walletAddress || raw.wallet || raw.address || raw.trader || null;
  const side = (raw.side || raw.type || raw.action || '').toString().toLowerCase() || null;
  return {
    capturedAt: nowIso(),
    source,
    signature: raw.signature || raw.txHash || raw.tx || raw.hash || raw.id || null,
    wallet,
    trader_name: raw.trader_name || raw.name || raw.username || null,
    side: side.includes('buy') ? 'buy' : side.includes('sell') ? 'sell' : side,
    token: raw.token_symbol || raw.symbol || raw.token || raw.tokenName || null,
    tokenAddress: raw.token_address || raw.tokenAddress || raw.mint || null,
    amount_sol: raw.amount_sol ?? raw.sol ?? raw.solAmount ?? null,
    amount_usd: raw.amount_usd ?? raw.usd ?? raw.usdAmount ?? null,
    amount_token: raw.amount ?? raw.tokenAmount ?? raw.qty ?? null,
    price: raw.price ?? null,
    timestamp: raw.timestamp ?? raw.time ?? raw.ts ?? raw.blockTime ?? null,
    _raw: raw,
  };
}

// Bir frame/yanıt gövdesini olası trade dizisine çevirir.
function parsePayload(payload) {
  let json = payload;
  if (typeof payload === 'string') {
    const s = payload.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return []; // socket.io ping vb. atla
    try {
      json = JSON.parse(s);
    } catch {
      return [];
    }
  }
  const arr = extractArray(json);
  if (arr.length) return arr;
  // Tek bir trade objesi de gelebilir
  if (json && typeof json === 'object' && (json.signature || json.wallet || json.token)) {
    return [json];
  }
  return [];
}

// trades sayfası için DOM'dan satır okuyucu (fallback). Sayfa yapısı değişebileceğinden
// olabildiğince genel: link içeren satırlardan metin toplar.
async function readDomRows(page) {
  return page
    .evaluate(() => {
      const rows = [];
      // Solana imzası/adresi içeren bağlantıları taşıyan satırları hedefle.
      const anchors = Array.from(document.querySelectorAll('a[href*="solscan"], a[href*="/account/"], a[href*="/tx/"]'));
      const seen = new Set();
      for (const a of anchors) {
        const row = a.closest('tr, li, [role="row"], div');
        if (!row || seen.has(row)) continue;
        seen.add(row);
        const text = row.innerText?.replace(/\s+/g, ' ').trim();
        if (text) rows.push({ text, href: a.getAttribute('href') });
      }
      return rows.slice(0, 50);
    })
    .catch(() => []);
}

export class TradesWatcher {
  constructor() {
    this.store = new DedupeStore('trades.jsonl', tradeKey);
    this.page = null;
    this.running = false;
    this.total = 0;
  }

  async _ingest(records, source) {
    const norm = records.map((r) => normalize(r, source)).filter(Boolean);
    if (!norm.length) return 0;
    const added = await this.store.addMany(norm);
    if (added) {
      this.total += added;
      log.info(`+${added} trade (${source}) — toplam ${this.total}`);
    }
    return added;
  }

  async _attach(page) {
    // 1) WebSocket
    page.on('websocket', (ws) => {
      log.info(`websocket açıldı: ${ws.url()}`);
      ws.on('framereceived', async (frame) => {
        const trades = parsePayload(frame.payload);
        if (trades.length) await this._ingest(trades, 'websocket').catch(() => {});
      });
      ws.on('close', () => log.warn(`websocket kapandı: ${ws.url()}`));
    });

    // 2) XHR/fetch JSON
    page.on('response', async (resp) => {
      const url = resp.url();
      if (!/\/api\//i.test(url) && !/trade/i.test(url)) return;
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!ct.includes('json')) return;
      let json;
      try {
        json = await resp.json();
      } catch {
        return;
      }
      const trades = parsePayload(json);
      if (trades.length) await this._ingest(trades, 'xhr').catch(() => {});
    });
  }

  async start() {
    await this.store.load();
    this.running = true;
    while (this.running) {
      try {
        this.page = await newPage();
        await this._attach(this.page);
        await gotoWithChallenge(this.page, tradesUrl());
        log.info('trade akışı dinleniyor...');

        // Sayfa açık kaldıkça WS/XHR dinleyicileri çalışır. Ayrıca düzenli DOM taraması.
        while (this.running && !this.page.isClosed()) {
          const rows = await readDomRows(this.page);
          if (rows.length) {
            // DOM satırlarını ham metin kaydı olarak sakla (imza href'ten çıkarılır).
            const parsed = rows.map((r) => {
              const sig = (r.href.match(/(?:tx|account)\/([A-Za-z0-9]{20,})/) || [])[1];
              return { signature: sig, _domText: r.text, source: 'dom' };
            });
            await this._ingest(parsed, 'dom').catch(() => {});
          }
          await sleep(config.tradesReconnectMs);
        }
      } catch (e) {
        log.error(`akış hatası: ${e.message}`);
      } finally {
        await this.page?.close().catch(() => {});
        this.page = null;
      }
      if (this.running) {
        log.warn(`${config.tradesReconnectMs}ms sonra yeniden bağlanılıyor...`);
        await sleep(config.tradesReconnectMs);
      }
    }
  }

  stop() {
    this.running = false;
  }
}

// Tek seferlik mod için: kısa süre dinleyip biriktirir, sonra durur.
export async function scrapeTradesOnce(durationMs = 30_000) {
  const w = new TradesWatcher();
  const p = w.start();
  await sleep(durationMs);
  w.stop();
  await w.page?.close().catch(() => {});
  await p.catch(() => {});
  log.info(`tek seferlik trade yakalama bitti: ${w.total} yeni kayıt`);
  return w.total;
}
