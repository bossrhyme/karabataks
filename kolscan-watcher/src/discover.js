// Endpoint keşif modu.
//
// Bir kolscan sayfasını açar ve TÜM ağ etkinliğini (XHR/fetch JSON yanıtları,
// WebSocket frame'leri) data/discover/<page>.jsonl dosyasına döker. Site yapısı
// değiştiğinde veya gerçek endpoint'leri/şemayı pinlemek istediğinde kullan.
import { newPage, gotoWithChallenge } from './browser.js';
import { config } from './config.js';
import { appendLine, nowIso } from './store.js';
import { leaderboardUrl, tradesUrl, walletUrl } from './config.js';
import { sleep } from './util.js';
import { makeLogger } from './log.js';

const log = makeLogger('discover');

const TARGETS = {
  leaderboard: () => leaderboardUrl(),
  trades: () => tradesUrl(),
  wallet: () => walletUrl(config.wallets[0] || 'DEMO_WALLET_ADDRESS'),
};

export async function discover(target = 'trades', durationMs = 30_000) {
  const urlFn = TARGETS[target];
  if (!urlFn) {
    log.error(`bilinmeyen hedef: ${target}. Seçenekler: ${Object.keys(TARGETS).join(', ')}`);
    return;
  }
  const out = `discover/${target}.jsonl`;
  const page = await newPage();

  page.on('response', async (resp) => {
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    if (!ct.includes('json')) return;
    const url = resp.url();
    let body;
    try {
      body = await resp.json();
    } catch {
      return;
    }
    const sample = Array.isArray(body) ? body.slice(0, 2) : body;
    await appendLine(out, {
      at: nowIso(),
      kind: 'response',
      method: resp.request().method(),
      status: resp.status(),
      url,
      postData: resp.request().postData() || null,
      keys: sample && typeof sample === 'object' ? Object.keys(Array.isArray(sample) ? sample[0] || {} : sample) : [],
      sample,
    });
    log.info(`response ${resp.request().method()} ${resp.status()} ${url}`);
  });

  page.on('websocket', (ws) => {
    log.info(`websocket: ${ws.url()}`);
    ws.on('framereceived', async (f) => {
      await appendLine(out, { at: nowIso(), kind: 'ws-recv', url: ws.url(), payload: String(f.payload).slice(0, 4000) });
    });
    ws.on('framesent', async (f) => {
      await appendLine(out, { at: nowIso(), kind: 'ws-sent', url: ws.url(), payload: String(f.payload).slice(0, 2000) });
    });
  });

  log.info(`${target} keşfi başlıyor -> data/${out} (${durationMs}ms)`);
  await gotoWithChallenge(page, urlFn());
  await sleep(durationMs);
  await page.close().catch(() => {});
  log.info(`keşif bitti. İncele: data/${out}`);
}
