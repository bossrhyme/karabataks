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
import { closeBrowser } from './browser.js';
import { scrapeLeaderboard } from './leaderboard.js';
import { TradesWatcher, scrapeTradesOnce } from './trades.js';
import { scrapeWallets } from './wallet.js';
import { discover } from './discover.js';
import { sleep } from './util.js';
import { makeLogger } from './log.js';

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
  log.info('kolscan-watcher başlıyor (sürekli mod)');
  log.info(
    `leaderboard her ${config.leaderboardIntervalMs / 1000}s, ` +
      `wallets her ${config.walletIntervalMs / 1000}s, ` +
      `trades sürekli. İzlenen cüzdan: ${config.wallets.length}`
  );

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

async function main() {
  const [cmd, arg] = process.argv.slice(2);

  try {
    if (!cmd || cmd === 'start' || cmd === 'watch') {
      await runWatcher();
      return; // süreç sinyale kadar açık kalır
    }

    if (cmd === 'once') {
      if (arg === 'leaderboard') await scrapeLeaderboard();
      else if (arg === 'trades') await scrapeTradesOnce(Number(process.argv[4]) || 30_000);
      else if (arg === 'wallets') await scrapeWallets();
      else log.error(`'once' için geçersiz modül: ${arg} (leaderboard|trades|wallets)`);
    } else if (cmd === 'discover') {
      await discover(arg || 'trades', Number(process.argv[4]) || 30_000);
    } else {
      log.error(`bilinmeyen komut: ${cmd}`);
      log.info('komutlar: start | once <modül> | discover <hedef>');
    }
  } finally {
    if (cmd && cmd !== 'start' && cmd !== 'watch') await closeBrowser();
  }
}

main().catch((e) => {
  log.error(`ölümcül: ${e.stack || e.message}`);
  process.exit(1);
});
