# 2000 TRACES — Operatör Kılavuzu

Bu doküman gösteri gecesi (show night) sırasında sistemi çalıştıracak operatör içindir.
Her iddia kod okunarak doğrulanmıştır: `src/server.js`, `src/env.js`, `src/sources/live-source.js`,
`viz/src/main.js`, `viz/src/hud.js`.

## 1. Kurulum ve başlatma

İki süreç gerekir, ikisi de ayrı terminal:

```
npm run panel   # kayıt sunucusu (src/server.js) — 127.0.0.1:8787, sadece loopback
npm run viz     # görselleştirici (Vite dev server, viz/src/main.js)
```

`npm run panel` sadece `127.0.0.1`'e bağlanır — venue LAN'ına asla açılmaz (`src/server.js` yorum:
"Local operator panel: bind loopback only, never the venue LAN"). Port `PANEL_PORT` env değişkeni ile
değiştirilebilir (varsayılan 8787).

`npm run panel` açılmadan `npm run viz` açılırsa viz "kayıt sunucusu kapalı — önce çalıştır: npm run panel"
mesajını gösterir; sistemi çökertmez.

## 2. Nasıl kayıt alınır

Kayıt akışı bir state machine'dir: `IDLE → ARMED → RECORDING → FINALIZING → COMPLETE`.

### ui/index.html kontrol panelinden (operatör masası)
`http://127.0.0.1:8787/` adresindeki kontrol paneli:
1. **ARM** düğmesi — `POST /api/arm`. IDLE veya COMPLETE'ten ARMED'e geçer.
   ARMED iken tekrar basmak **disarm**'dır (ARMED → IDLE) — yanlışlıkla kolluysanız kurtarır.
2. Panel ARMED durumdayken düğme **DISARM**'a döner.
3. **● KAYIT** (start) — `POST /api/start`, sadece ARMED fazından çalışır (409 döner aksi halde).
   Body'e opsiyonel `{"label": "prova 1"}` verilebilir (bkz. §3).
4. Kayıt 90 saniyelik (`durationMs`, varsayılan 90000 ms) **tek atımlık** bir show artifact'ıdır — geri
   sarılmaz, üstüne yazılmaz.
5. **DUR** (stop) — `POST /api/stop` — sadece RECORDING sırasında (yani `current` set iken) çalışır;
   FINALIZING sırasında 409 döner ("cannot stop from FINALIZING") — bir take paketlenirken durdurulamaz.
6. Panel `HATA` alanını `lastError` / `packError` alanlarından render eder — kayıt başarısız olsa bile
   bu görünür kalır, sessizce kaybolmaz.

### viz üzerinden (● KAYIT)
`npm run viz` sayfasında HUD'daki **● KAYIT** düğmesi aynı `/api/arm` → `/api/start` akışını sunucu
durumunu (`/api/status`) önce sorup, sonra `/api/live` SSE bağlantısını açıp, sonra arm+start çağırarak
yürütür. `RECORDING` state'i gelene kadar sahne temizlenmez/yeniden kurulmaz — sunucu onayı olmadan
önceki pack imha edilmez. Kayıt sırasında Space/Enter tuşları **asla** kaydı durdurmaz (sadece pack
modunda transport'u aç/kapatır); tüm HUD düğmeleri tıklamadan sonra blur olur, böylece boşluk tuşuna
yanlışlıkla basmak DUR'a basmış gibi davranmaz.

Kayıt bitince viz otomatik olarak "■ PAKETLENIYOR…" gösterir (FINALIZING/COMPLETE), ardından paket
hazır olduğunda yeni pack'e otomatik geçer.

### Take label (etiket)
`POST /api/start` body'sinde `{"label": "..."}` verilebilir — en fazla 40 karakter, yalnız
`[\p{L}\p{N} _-]` karakterlerine indirgenir (script/HTML enjeksiyonu vs. temizlenir). Etiket:
session JSONL header'ına, paket manifestine, `index.json`'a ve `/api/library` satırlarına akar;
hello/state broadcast'lerinde de görünür.

## 3. Kütüphane (KÜTÜPHANE paneli) — listeleme, paketleme, silme

viz HUD'daki **KÜTÜPHANE** düğmesi sağda bir panel açar; içerik `GET /api/library` (kayıt sunucusundan)
ile doldurulur — iki liste:

- **Paketler**: isim/etiket, `lanes · events`, düğmeler **AÇ** (switchPack ile o pakete geçer) ve **SİL**.
- **Paketlenmemiş oturumlar** (ham `.jsonl`): dosya adı, boyut, düğmeler **PAKETLE** (`POST /api/pack`
  `{file}` ile mevcut sessions dizinindeki bir dosyayı pack'ler) ve **SİL**.

**SİL iki aşamalıdır**: ilk tıklama düğmeyi 4 saniyeliğine **EMİN MİSİN?**'e çevirir; ikinci tıklama
gerçek `DELETE /api/sessions/<dosya>` veya `DELETE /api/packs/<isim>` çağrısını yapar. Her işlemden
sonra kütüphane + paket index'i yeniden çekilir; açık pack silinmişse bir sonraki pakete veya boş
duruma düşülür. Her tamamlanan kayıttan sonra panel otomatik yenilenir.

Aktif kayıt yapılan oturum (veya finalize edilmekte olan) **silinemez/paketlenemez** — sunucu 409
döner ("session is still recording"); 90 saniyelik show artifact'ı asla ayağının altından çekilmez.

Dosya/isim güvenliği: `/`, `\`, `..`, null byte veya benzeri path traversal denemeleri `safeChildPath`
tarafından reddedilir (400/404) — hedef dizinin dışına asla erişilmez.

Kayıt sunucusu kapalıyken panel "kayıt sunucusu kapalı (npm run panel)" mesajını gösterir.

## 4. Canlı izolasyon (live seat isolation)

Canlı yayın (RECORDING) sırasında sahnedeki bir şeride (lane) tıklamak o katılımcıyı izole eder:
disk üzerindeki `uSelLane` uniform'u set edilir, seat paneli o kişinin bölge/koltuk bilgisini
(`laneMeta`den zone harfi + seat) ve canlı güncellenen olay sayısını gösterir.

**Esc** tuşu veya boş bir alana tıklamak seçimi temizler (`selectLive(null)` / `select(null)`,
`e.key === 'Escape'` main.js'de dinleniyor).

## 5. Auto-attach

viz sayfası açılışta `GET /api/status`'u sorar; sunucu zaten **RECORDING** ise viz otomatik olarak
canlı moda geçer ve aynı "attach" kod yolunu kullanır — hello mesajındaki güncel `roster`'dan sahneyi
kurar (yeni bir take için ayrı roster broadcast'i beklemez, çünkü zaten devam eden bir oturuma
katılıyordur). Bu sayede viz sayfası show ortasında yenilense/yeniden açılsa da kayıp yaşanmaz.

## 6. Ortam değişkenleri

`.env` dosyası proje kökünde, `src/env.js`'deki `loadEnv()` ile okunur (CRLF satır sonları da
desteklenir — `\r?\n` ile bölünür). `.env` yoksa gerçek `process.env` değişkenleri kullanılabilir.

| Değişken | Zorunlu mu | Açıklama |
|---|---|---|
| `CS_EVENTS_URL` | Evet | Canlı SSE olay akışının URL'i (`src/sources/live-source.js`). |
| `CS_EVENTS_AUTH` | `CS_EVENTS_TOKEN` yoksa evet | Basic auth kimlik bilgisi. |
| `CS_EVENTS_TOKEN` | `CS_EVENTS_AUTH` yoksa evet | Bearer token. |
| `PANEL_PORT` | Hayır | Kayıt sunucusu portu (varsayılan 8787). |

**AUTH vs TOKEN önceliği**: `CS_EVENTS_URL` ile birlikte `CS_EVENTS_AUTH` **veya** `CS_EVENTS_TOKEN`'dan
en az biri zorunludur (`loadEnv` bunu doğrular, yoksa fırlatır). **İkisi de verilirse `CS_EVENTS_TOKEN`
(Bearer) kazanır** ve `live-source.js` bunu bir kez `console.warn` ile bildirir:
`"live-source: both CS_EVENTS_AUTH and CS_EVENTS_TOKEN are set — CS_EVENTS_TOKEN (Bearer) wins; unset
the stale one"`. Show gecesi terminal loglarında bu satırı görürseniz `.env`'deki eski değeri silin.

401/403 (kimlik doğrulama hatası) yeniden denenmez sonsuza kadar: bir kez tekrar denenir, yine
başarısız olursa `SSE auth failed (HTTP 401): check CS_EVENTS_AUTH / CS_EVENTS_TOKEN` hatasıyla
durur — sessiz sonsuz döngü yerine net teşhis.

## 7. Bilinen sınırlar

- **90 saniyelik tek atımlık kayıt**: `durationMs` varsayılan 90000 ms; bu bir show artifact'ıdır,
  duraklat/devam et yoktur. Stream sessiz kalsa bile wall-clock zamanlayıcı (`durationMs + 5000`)
  oturumu zorla kapatır.
- **derived-roster replay buffer sınırı 400.000 olay**: `viz/src/main.js` içinde canlı roster geç
  geldiğinde (derived roster) tutulan replay buffer 400.000 olayı aşarsa atılır ve
  `live.rosterDerived = false` olur — çok uzun/çok yoğun bir açılış gecikmesinde en eski canlı veri
  kaybolabilir (yeniden türetme devre dışı kalır, ama akış durmaz).
- **spare lane sayısı 64/256**: sahne düzeni (`rosterLayout`) roster sunucudan gecikmeli/türetilmiş
  (derived) geldiyse 256, taze bir roster snapshot'ı ile kurulduysa 64 yedek şerit (spare lane) ayırır.
  Bu sınırı aşan geç katılımcılar sessizce görünmez olmaz — `live.dropped` sayacı artar ve kayıt
  istatistik satırında yüzeye çıkar ("spare band full").
- **FINALIZING için ayrı bir broadcast yoktur şeklinde bir kısıtlama YOKTUR** — düzeltildi: sunucu artık
  `RECORDING → FINALIZING → COMPLETE` geçişlerinin her birinde `broadcast({kind:'state', state:...})`
  gönderir; viz bu durumu "■ PAKETLENIYOR…" olarak gösterir. (Bilinen sınırlardan biri: FINALIZING
  anındaki `status()` yalnız `finalizingSessionId/stats/participants` anlık görüntüsünü taşır — tam
  session nesnesi bu noktada artık bellekte tutulmaz, bu kasıtlıdır çünkü ~600 MB'lık canlı event
  store'u boşta tutmak istenmez.)
- **Kayıt sunucusu sadece loopback'e bağlıdır** (`127.0.0.1`) — venue LAN'ından erişilemez; operatör
  masasındaki tarayıcı doğrudan aynı makinede olmalı.
- **Aktif oturum silinemez/paketlenemez**: kayıt devam ederken (`current`) veya paketlenirken
  (`finalizing`) o dosyaya `DELETE`/`POST /api/pack` çağrısı 409 döner.
- **Paket silme sadece dizinleri kaldırır**: `DELETE /api/packs/<isim>` yalnızca bir dizin (pack) ise
  çalışır; `index.json` gibi tekil dosyalar bu yoldan silinemez.
- **Label sanitizasyonu kayıptır**: 40 karakteri aşan veya izin verilmeyen karakter içeren etiketler
  kırpılır/temizlenir — orijinal metin geri getirilemez.
</content>
