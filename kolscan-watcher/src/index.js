#!/usr/bin/env node
// kolscan-watcher giriş noktası / orchestrator.
//
// Kullanım:
//   node src/index.js                 # sürekli canlı izleyici (varsayılan)
//   node src/index.js once leaderboard # tek seferlik leaderboard çekimi
//   node src/index.js once trades      # ~30s trade akışı yakala
//   node src/index.js once wallets     # izlenen cüzdanları çek
//   node src/index.js discover trades  # endpoint/şema keşfi (trades|leaderboard|wallet)
import { config } from './config.js';
import { fetchAllLeaderboards, TradeStream } from './providers/solanatracker.js';
import { sleep } from './util.js';
import { makeLogger } from './log.js';

// Playwright'a dokunan modüller yalnızca scraping modlarında dinamik yüklenir;
// böylece `api` modu Playwright kurulu olmadan da çalışır.

const log = makeLogger('main');

// Bir görevi periyodik çalıştıran zamanlayıcı; durdurulabilir.
function schedule(name, fn, intervalMs, signal) {
  (async () => {
    while (!signal.aborted) {
      try {
        await fn();
      } catch (e) {
        log.error(`${name} döngü hatası: ${e.message}`);
      }
      // Aralık boyunca, iptal edilirse erken çık.
      const step = 1000;
      for (let waited = 0; waited < intervalMs && !signal.aborted; waited += step) {
        await sleep(Math.min(step, intervalMs - waited));
      }
    }
    log.info(`${name} zamanlayıcı durdu`);
  })();
}

async function runWatcher() {
  log.info('kolscan-watcher başlıyor (sürekli mod / Playwright scraping)');
  log.info(
    `leaderboard her ${config.leaderboardIntervalMs / 1000}s, ` +
      `wallets her ${config.walletIntervalMs / 1000}s, ` +
      `trades sürekli. İzlenen cüzdan: ${config.wallets.length}`
  );

  const { closeBrowser } = await import('./browser.js');
  const { scrapeLeaderboard } = await import('./leaderboard.js');
  const { TradesWatcher } = await import('./trades.js');
  const { scrapeWallets } = await import('./wallet.js');

  const ac = new AbortController();
  const trades = new TradesWatcher();

  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${sig} alındı, kapatılıyor...`);
    ac.abort();
    trades.stop();
    await sleep(500);
    await closeBrowser();
    log.info('güle güle');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Sürekli trade akışı (kendi yeniden-bağlanma döngüsü var).
  trades.start().catch((e) => log.error(`trades watcher öldü: ${e.message}`));

  // Periyodik leaderboard.
  schedule('leaderboard', scrapeLeaderboard, config.leaderboardIntervalMs, ac.signal);

  // Periyodik cüzdan geçmişi (cüzdan tanımlıysa).
  if (config.wallets.length) {
    schedule('wallets', () => scrapeWallets(), config.walletIntervalMs, ac.signal);
  }
}

// Solana Tracker API tabanlı izleyici — scraping yok, gerçek API.
async function runApiWatcher() {
  log.info('kolscan-watcher başlıyor (Solana Tracker API modu)');
  const ac = new AbortController();
  const stream = new TradeStream({ reconnectMs: config.tradesReconnectMs });

  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`${sig} alındı, kapatılıyor...`);
    ac.abort();
    stream.stop();
    await sleep(300);
    log.info('güle güle');
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Canlı trade akışı (kendi reconnect döngüsü var).
  stream.start().catch((e) => log.error(`trade stream öldü: ${e.message}`));
  // Periyodik leaderboard.
  schedule('st-leaderboard', () => fetchAllLeaderboards(config.timeframes), config.leaderboardIntervalMs, ac.signal);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  try {
    if (!cmd || cmd === 'start' || cmd === 'watch') {
      await runWatcher();
      return; // süreç sinyale kadar açık kalır
    }

    if (cmd === 'api') {
      if (arg === 'leaderboard') await fetchAllLeaderboards(config.timeframes);
      else {
        await runApiWatcher();
        return; // sinyale kadar açık kal
      }
    } else if (cmd === 'once') {
      if (arg === 'leaderboard') await (await import('./leaderboard.js')).scrapeLeaderboard();
      else if (arg === 'trades') await (await import('./trades.js')).scrapeTradesOnce(Number(process.argv[4]) || 30_000);
      else if (arg === 'wallets') await (await import('./wallet.js')).scrapeWallets();
      else log.error(`'once' için geçersiz modül: ${arg} (leaderboard|trades|wallets)`);
    } else if (cmd === 'discover') {
      await (await import('./discover.js')).discover(arg || 'trades', Number(process.argv[4]) || 30_000);
    } else {
      log.error(`bilinmeyen komut: ${cmd}`);
      log.info('komutlar: start | api [leaderboard] | once <modül> | discover <hedef>');
    }
  } finally {
    // Yalnızca Playwright kullanan modlarda tarayıcıyı kapat.
    if (['once', 'discover'].includes(cmd)) {
      await (await import('./browser.js')).closeBrowser();
    }
  }
}

main().catch((e) => {
  log.error(`ölümcül: ${e.stack || e.message}`);
  process.exit(1);
});
