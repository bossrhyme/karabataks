# kolscan-watcher

[kolscan.io](https://kolscan.io) için **sürekli canlı izleyici**. Gerçek bir tarayıcı
(Playwright + Chromium) kullanarak üç veri akışını ayrı ayrı çeker, normalize eder
ve dedupe ederek `data/` altına biriktirir:

1. **KOL Leaderboard** — `daily` / `weekly` / `monthly` trader sıralaması (PnL, win/loss, cüzdan).
2. **Canlı Trade akışı** — gerçek zamanlı al/sat işlemleri (WebSocket + XHR + DOM fallback).
3. **Tekil cüzdan geçmişi** — belirlediğin adreslerin son işlemleri ve token PnL'i.

> kolscan Cloudflare bot koruması kullandığı için basit `curl`/`fetch` çalışmaz.
> Bu yüzden veriler gerçek bir tarayıcı oturumu üzerinden, sayfanın kendi API
> çağrıları ve WebSocket frame'leri dinlenerek toplanır.

## Kurulum

```bash
cd kolscan-watcher
npm install          # playwright + chromium kurar (postinstall)
```

Node 18+ gerekir.

## Çalıştırma

```bash
# Sürekli canlı izleyici (varsayılan): trades sürekli, leaderboard/wallets periyodik
npm start

# Tek seferlik işlemler
npm run leaderboard          # bir kez tüm timeframe'leri çek
npm run trades               # ~30 sn trade akışı yakala
KOLSCAN_WALLETS=addr1,addr2 npm run wallets

# Endpoint/şema keşfi (site değişirse gerçek API'leri görmek için)
npm run discover -- trades   # veya: leaderboard | wallet
```

`Ctrl+C` ile düzgün şekilde durur.

## Dashboard (web paneli)

Repo kökündeki **`index.html`** — KOL leaderboard'u **günlük / haftalık / aylık**
sekmelerine ayıran, **Min Win Rate** filtresi (varsayılan **%60**) olan ve
**canlı trade akışını** gösteren tek dosyalık panel. İzleyicinin `data/` çıktısını okur.

```bash
npm run serve     # http://localhost:8787 — repo kökünü + kolscan-watcher/data'yı sunar
# veya repo kökünden: python3 -m http.server 8787
```

- **Win rate filtresi:** Üstteki kaydırıcı/giriş ile eşik ayarlanır (varsayılan %60).
  Leaderboard kayıtlarında `wins`/`losses`'tan win rate hesaplanır.
- **Timeframe sekmeleri:** Günlük/Haftalık/Aylık her biri ilgili `data/leaderboard/<tf>.json`'ı gösterir.
- **Canlı akış:** `data/trades.jsonl`'i periyodik okur (varsayılan 10 sn) ve en yeni işlemleri akıtır.
- **Veri yokken:** İzleyici henüz çalışmadıysa panel net bir uyarı ve yapıyı gösteren **demo veri** ile açılır.

## Çıktılar (`data/`)

| Dosya | İçerik |
|---|---|
| `leaderboard/<timeframe>.json` | İlgili timeframe'in son tam sıralaması |
| `leaderboard/<timeframe>.history.jsonl` | Her çekimde ilk 10'un zaman serisi özeti |
| `trades.jsonl` | Dedupe'lu tüm yakalanan işlemler (append-only) |
| `wallets/<address>.json` | Cüzdanın son durumu: işlemler + token PnL |
| `wallets/<address>.txlog.jsonl` | Cüzdanın dedupe'lu işlem zaman serisi |
| `discover/<target>.jsonl` | Keşif modunun ham ağ/WS dökümü |

## Yapılandırma (ortam değişkenleri)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `KOLSCAN_WALLETS` | _(boş)_ | İzlenecek cüzdanlar, virgülle ayrık |
| `KOLSCAN_LEADERBOARD_INTERVAL_MS` | `300000` | Leaderboard çekme aralığı (5 dk) |
| `KOLSCAN_WALLET_INTERVAL_MS` | `600000` | Cüzdan çekme aralığı (10 dk) |
| `KOLSCAN_TRADES_RECONNECT_MS` | `15000` | Trade akışı yeniden bağlanma / DOM tarama aralığı |
| `KOLSCAN_TIMEFRAMES` | `daily,weekly,monthly` | Çekilecek leaderboard timeframe'leri |
| `KOLSCAN_HEADFUL` | _(kapalı)_ | `1` yaparsan tarayıcı görünür açılır (Cloudflare takılırsa dene) |
| `KOLSCAN_WALLET_PATH` | `/account/{addr}` | Cüzdan sayfası URL şablonu |
| `KOLSCAN_DATA_DIR` | `./data` | Çıktı klasörü |
| `KOLSCAN_LOG_LEVEL` | `info` | `debug` ile ayrıntılı log |
| `KOLSCAN_BASE_URL` | `https://kolscan.io` | Temel adres |

## Mimari

```
src/
  index.js        orchestrator (sürekli mod + once/discover komutları)
  config.js       env tabanlı yapılandırma
  browser.js      paylaşılan Chromium oturumu (+ Cloudflare bekleme)
  leaderboard.js  /api/leaderboard yakalama + scroll sayfalama + dedupe
  trades.js       WS + XHR + DOM fallback ile canlı trade biriktirme
  wallet.js       tekil cüzdan işlem/PnL çekimi
  discover.js     endpoint/şema keşif dökümü
  store.js        JSON snapshot + dedupe'lu JSONL kalıcılık
  util.js         retry/backoff, esnek dizi çıkarımı
  log.js          zaman damgalı logger
```

## Sağlamlık notları

- **Esnek ayrıştırma:** kolscan'in JSON sarmalayıcısı (`{data:[]}`, `{result:[]}` vb.)
  ve alan adları zamanla değişebilir; `util.extractArray` ve `trades.normalize`
  birden çok olası ada karşı toleranslıdır. Beklenen alanlar gelmezse `_raw` içinde
  ham kayıt korunur — veri kaybı olmaz.
- **Dedupe:** trade'ler imza/hash ile, leaderboard cüzdan adresi ile, cüzdan işlemleri
  imza ile tekilleştirilir. Açılışta mevcut dosyalardan görülen anahtarlar yüklenir.
- **Site değişirse:** önce `npm run discover -- <hedef>` çalıştırıp
  `data/discover/<hedef>.jsonl` içindeki gerçek URL ve şemayı incele, sonra ilgili
  modülde selector/alan adlarını güncelle.

## Yasal / sorumluluk

Yalnızca herkese açık verileri, site şartlarına ve geçerli yasalara uygun şekilde
ve makul aralıklarla çek. Bu araç eğitim/araştırma amaçlıdır.
