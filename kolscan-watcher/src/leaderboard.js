// KOL Leaderboard çekici.
//
// kolscan.io/leaderboard bir Next.js sayfası; veriler sonsuz kaydırma sırasında
// `POST /api/leaderboard` çağrılarıyla `{ data: [...] }` biçiminde geliyor.
// Strateji: sayfayı aç, timeframe sekmesine tıkla, kaydırma kabını dibe çek,
// gelen API yanıtlarını dinle ve cüzdan adresine göre dedupe et.
import { newPage, gotoWithChallenge } from './browser.js';
import { config, leaderboardUrl } from './config.js';
import { writeSnapshot, appendLine, nowIso } from './store.js';
import { extractArray, sleep, withRetry } from './util.js';
import { makeLogger } from './log.js';

const log = makeLogger('leaderboard');

// Kayıttan cüzdan adresini olabildiğince esnek çıkar.
function walletOf(rec) {
  return (
    rec.wallet_address ||
    rec.walletAddress ||
    rec.address ||
    rec.wallet ||
    rec.account ||
    rec.id ||
    null
  );
}

async function scrapeTimeframe(page, timeframe, captured) {
  // İlgili sekmeye tıklamayı dene (Daily / Weekly / Monthly).
  const label = timeframe.charAt(0).toUpperCase() + timeframe.slice(1);
  const tab = page
    .getByRole('button', { name: new RegExp(`^${label}$`, 'i') })
    .or(page.getByText(new RegExp(`^${label}$`, 'i')))
    .first();
  try {
    if (await tab.isVisible({ timeout: 3000 })) {
      await tab.click({ timeout: 3000 });
      await sleep(config.scrollSettleMs);
    }
  } catch {
    log.debug(`${timeframe}: sekme bulunamadı, varsayılan görünüm kullanılıyor`);
  }

  // Sonsuz kaydırma: bilinen kaydırma kabı #mainScroll, yoksa window.
  let lastCount = -1;
  let stableRounds = 0;
  for (let i = 0; i < config.leaderboardMaxScrolls; i++) {
    await page.evaluate(() => {
      const el = document.getElementById('mainScroll');
      if (el) el.scrollTop = el.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(config.scrollSettleMs);

    const count = captured.size;
    if (count === lastCount) {
      if (++stableRounds >= 3) break; // 3 turda yeni kayıt yoksa bitir
    } else {
      stableRounds = 0;
    }
    lastCount = count;
  }
  log.info(`${timeframe}: ${captured.size} kayıt toplandı`);
}

export async function scrapeLeaderboard() {
  return withRetry('leaderboard', async () => {
    const page = await newPage();
    try {
      // timeframe -> Map(wallet -> rec)
      const byTimeframe = new Map(config.timeframes.map((t) => [t, new Map()]));
      // Hangi timeframe'in aktif olduğunu bilmediğimiz API yanıtları için "current" yakalama.
      let active = config.timeframes[0];

      page.on('response', async (resp) => {
        const url = resp.url();
        if (!/\/api\/leaderboard/i.test(url)) return;
        if (!resp.ok()) return;
        let json;
        try {
          json = await resp.json();
        } catch {
          return;
        }
        const rows = extractArray(json);
        if (!rows.length) return;
        // İstek gövdesinden timeframe çıkarmayı dene, yoksa aktif sekmeyi kullan.
        let tf = active;
        try {
          const body = resp.request().postData() || '';
          const m = body.match(/daily|weekly|monthly|all|7d|24h|30d/i);
          if (m) {
            const norm = m[0].toLowerCase();
            tf =
              norm === '24h' ? 'daily' : norm === '7d' ? 'weekly' : norm === '30d' ? 'monthly' : norm;
          }
        } catch {
          /* yoksa aktif */
        }
        const bucket = byTimeframe.get(tf) || byTimeframe.get(active);
        for (const r of rows) {
          const w = walletOf(r);
          bucket.set(w || JSON.stringify(r), { ...r, _wallet: w });
        }
      });

      await gotoWithChallenge(page, leaderboardUrl());
      await page.waitForLoadState('networkidle').catch(() => {});

      for (const tf of config.timeframes) {
        active = tf;
        await scrapeTimeframe(page, tf, byTimeframe.get(tf));
      }

      // Kalıcılaştır
      const stamp = nowIso();
      const summary = {};
      for (const tf of config.timeframes) {
        const records = [...byTimeframe.get(tf).values()].map((r, i) => ({
          rank: r.ranking_position ?? r.rank ?? i + 1,
          ...r,
        }));
        await writeSnapshot(`leaderboard/${tf}.json`, {
          timeframe: tf,
          capturedAt: stamp,
          count: records.length,
          records,
        });
        // Zaman serisi: her çekimde özet satırı (boyutu kontrol altında tutmak için sadece özet)
        await appendLine(`leaderboard/${tf}.history.jsonl`, {
          capturedAt: stamp,
          count: records.length,
          top: records.slice(0, 10).map((r) => ({
            wallet: r._wallet,
            name: r.trader_name ?? r.name ?? null,
            pnl_sol: r.pnl_sol ?? r.pnlSol ?? null,
            pnl_usd: r.pnl_usd ?? r.pnlUsd ?? null,
          })),
        });
        summary[tf] = records.length;
      }
      log.info(`leaderboard yazıldı: ${JSON.stringify(summary)}`);
      return summary;
    } finally {
      await page.close().catch(() => {});
    }
  });
}
