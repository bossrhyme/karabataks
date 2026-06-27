// Paylaşılan Chromium tarayıcı/oturum yönetimi.
import { chromium } from 'playwright';
import { config } from './config.js';
import { makeLogger } from './log.js';

const log = makeLogger('browser');

let browser = null;
let context = null;

export async function getContext() {
  if (context) return context;

  log.info(`Chromium başlatılıyor (headless=${config.headless})`);
  browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  context = await browser.newContext({
    userAgent: config.userAgent,
    locale: config.locale,
    viewport: { width: 1440, height: 900 },
    timezoneId: process.env.KOLSCAN_TZ || 'UTC',
  });
  context.setDefaultNavigationTimeout(config.navTimeoutMs);
  context.setDefaultTimeout(config.navTimeoutMs);

  // webdriver bayrağını gizle (basit Cloudflare/bot kontrolü için).
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  return context;
}

// Yeni bir sayfa açar; çağıran kapatmaktan sorumludur.
export async function newPage() {
  const ctx = await getContext();
  return ctx.newPage();
}

export async function closeBrowser() {
  try {
    await context?.close();
    await browser?.close();
  } catch (e) {
    log.warn(`kapatma hatası: ${e.message}`);
  } finally {
    context = null;
    browser = null;
  }
}

// Verilen URL'e gider; bir Cloudflare "checking your browser" sayfası görürse bekler.
export async function gotoWithChallenge(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Cloudflare interstitial başlığı genelde "Just a moment" içerir.
  for (let i = 0; i < 10; i++) {
    const title = (await page.title().catch(() => '')) || '';
    if (!/just a moment|attention required|checking/i.test(title)) break;
    log.warn(`Cloudflare challenge bekleniyor (${title})...`);
    await page.waitForTimeout(2000);
  }
  return page;
}
