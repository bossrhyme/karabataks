// JSON kalıcılık katmanı: snapshot (son durum) + JSONL (zaman serisi/birikim).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { makeLogger } from './log.js';

const log = makeLogger('store');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolve(relPath) {
  const p = path.join(config.dataDir, relPath);
  ensureDir(path.dirname(p));
  return p;
}

// Tek bir JSON dosyasını atomik yazar (son durum / snapshot).
export async function writeSnapshot(relPath, obj) {
  const p = resolve(relPath);
  const tmp = `${p}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, p);
  log.debug(`snapshot -> ${p}`);
}

export async function readSnapshot(relPath, fallback = null) {
  try {
    const raw = await fsp.readFile(resolve(relPath), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    log.warn(`readSnapshot ${relPath} bozuk: ${e.message}`);
    return fallback;
  }
}

// JSONL'e tek satır ekler (zaman serisi snapshot geçmişi için).
export async function appendLine(relPath, obj) {
  const p = resolve(relPath);
  await fsp.appendFile(p, JSON.stringify(obj) + '\n');
}

// Dedup ederek JSONL'e ekleyen depo. `keyFn` her kayıt için benzersiz anahtar üretir.
// Görülen anahtarlar bellekte tutulur ve açılışta dosyadan yüklenir.
export class DedupeStore {
  constructor(relPath, keyFn) {
    this.path = resolve(relPath);
    this.keyFn = keyFn;
    this.seen = new Set();
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fsp.readFile(this.path, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.seen.add(this.keyFn(JSON.parse(line)));
        } catch {
          /* bozuk satırı atla */
        }
      }
      log.info(`${path.basename(this.path)}: ${this.seen.size} mevcut kayıt yüklendi`);
    } catch (e) {
      if (e.code !== 'ENOENT') log.warn(`load ${this.path}: ${e.message}`);
    }
  }

  // Yeni kayıtları ekler; daha önce görülenleri atlar. Eklenen sayısını döner.
  async addMany(records) {
    await this.load();
    const fresh = [];
    for (const r of records) {
      let k;
      try {
        k = this.keyFn(r);
      } catch {
        continue;
      }
      if (k == null || this.seen.has(k)) continue;
      this.seen.add(k);
      fresh.push(r);
    }
    if (fresh.length) {
      await fsp.appendFile(this.path, fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
    }
    return fresh.length;
  }
}

export function nowIso() {
  return new Date().toISOString();
}
