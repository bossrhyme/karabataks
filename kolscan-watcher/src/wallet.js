// Tekil cüzdan geçmişi çekici.
//
// Belirli bir cüzdan adresinin kolscan sayfasını açar, son ~100 işlemini ve
// token PnL dökümünü API yanıtlarından/DOM'dan toplar. Her cüzdan için ayrı
// snapshot (data/wallets/<addr>.json) + dedupe'lu işlem günlüğü tutar.
import { newPage, gotoWithChallenge } from './browser.js';
import { config, walletUrl } from './config.js';
import { writeSnapshot, DedupeStore, nowIso } from './store.js';
import { extractArray, sleep, withRetry } from './util.js';
import { makeLogger } from './log.js';

const log = makeLogger('wallet');

function txKey(t) {
  return t.signature || t.txHash || t.tx || t.hash || t.id || JSON.stringify(t);
}

export async function scrapeWallet(address) {
  return withRetry(`wallet ${address}`, async () => {
    const page = await newPage();
    const txs = new Map(); // key -> tx
    const pnl = []; // token PnL kayıtları (varsa)
    try {
      page.on('response', async (resp) => {
        const url = resp.url();
        if (!/\/api\//i.test(url)) return;
        const ct = (resp.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        let json;
        try {
          json = await resp.json();
        } catch {
          return;
        }
        const rows = extractArray(json);
        for (const r of rows) {
          if (r && (r.signature || r.txHash || r.tx || r.hash)) {
            txs.set(txKey(r), r);
          } else if (r && (r.token || r.symbol || r.pnl || r.pnl_usd)) {
            pnl.push(r);
          }
        }
      });

      await gotoWithChallenge(page, walletUrl(address));
      await page.waitForLoadState('networkidle').catch(() => {});

      // İşlemleri yüklemek için biraz kaydır.
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => {
          const el = document.getElementById('mainScroll');
          if (el) el.scrollTop = el.scrollHeight;
          else window.scrollTo(0, document.body.scrollHeight);
        });
        await sleep(config.scrollSettleMs);
      }

      const stamp = nowIso();
      const txList = [...txs.values()];
      await writeSnapshot(`wallets/${address}.json`, {
        address,
        capturedAt: stamp,
        txCount: txList.length,
        pnlCount: pnl.length,
        transactions: txList,
        tokenPnl: pnl,
      });

      // İşlemleri dedupe'lu zaman serisine de ekle.
      const store = new DedupeStore(`wallets/${address}.txlog.jsonl`, txKey);
      const added = await store.addMany(
        txList.map((t) => ({ ...t, _wallet: address, capturedAt: stamp }))
      );
      log.info(`${address}: ${txList.length} işlem, ${pnl.length} PnL kaydı (+${added} yeni)`);
      return { address, txCount: txList.length, pnlCount: pnl.length, added };
    } finally {
      await page.close().catch(() => {});
    }
  });
}

export async function scrapeWallets(addresses = config.wallets) {
  if (!addresses.length) {
    log.warn('izlenecek cüzdan yok (KOLSCAN_WALLETS ayarla)');
    return [];
  }
  const out = [];
  for (const addr of addresses) {
    try {
      out.push(await scrapeWallet(addr));
    } catch (e) {
      log.error(`${addr} başarısız: ${e.message}`);
    }
  }
  return out;
}
