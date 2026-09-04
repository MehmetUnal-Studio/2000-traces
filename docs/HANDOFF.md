# 2000 TRACES — Hand-off (2026-09-05)

**Ne:** Cosmic Symphony seyirci akışını kaydeden recorder + dairesel "plak" data-art görselleştirici.
Seyirci olayları müzik hattına (OSC) dönüşmeden önceki ham SSE akışından kaydedilir; müzik zincirine dokunulmaz.

- **Repo:** https://github.com/MehmetUnal-Studio/2000-traces (private)
- **Dizin:** `~/Documents/CluadeCodeFiles/2000-traces` · Node ≥ 22, sıfır bağımlılıklı sunucu, Vite + three r185 viewer

## Çalıştırma

```bash
npm run panel   # recorder paneli + API — http://127.0.0.1:8787 (sadece loopback)
```

```bash
npm run viz     # görselleştirici — http://localhost:5174
```

Kayıt: viz'de **● KAYIT** (90 sn, otomatik paket + esere geçiş) ya da panelden ARM → START.
Etiket: `POST /api/start {"label":"prova 1"}` (≤ 40 kr). Dosyadan üretim: `node src/cli.js record-file <capture.raw>`.

## Durum

- Hardening + kütüphane planı **tamamen bitti** (46 bulgu + F1–F5). Testler **82/82 yeşil**.
- Canlı doğrulama (2026-08-31): **1.300 katılımcı, 2.037.831 olay**, 0 kayıp/bozuk; auto-attach, otomatik paketleme ve esere geçiş gerçek koşulda çalıştı. CLI'dan daha önce 2.000 kişi/2,7 M olay testi de geçmişti.
- KÜTÜPHANE paneli: listele / AÇ / PAKETLE / iki aşamalı SİL. **Silme kalıcıdır** (çöp kutusu yok).

## Ortam (.env)

- `CS_EVENTS_URL` — SSE beslemesi (şu an `https://venue.cosmicsymphony.live/api/events`)
- `CS_EVENTS_TOKEN` (Bearer) **veya** `CS_EVENTS_AUTH` (Basic). İkisi de tanımlıysa **TOKEN kazanır** (console.warn düşer). 401/403 bir kez denenir, sonra hata yüzeye çıkar.

## Bilinen sınırlar

- 90 sn tek atımlık kayıt; sessiz akışta duvar saati kesicisi take'i +5 sn'de kapatır.
- Türetilmiş roster (snapshot'sız başlangıç): 256 yedek şerit, 400k olayla sınırlı replay buffer.
- `sessions/`, `captures/*.raw`, `viz/public/packs/`, `.env` git'e girmez — büyük take'leri ayrıca yedekle.
- OSC dinleyicisi yok (bilinçli, kapsam dışı); dinlenen portlar yalnızca 8787 ve 5174 (TCP/HTTP).

## Referans

`docs/OPERATOR.md` (show gecesi rehberi) · `docs/superpowers/plans/` (planlar, tümü işaretli) ·
`docs/findings-2026-08-28.json` (bug-hunt bulguları) · Protokol/rig notları proje hafızasında.

## Açık işler (öneri)

OSC ile uzaktan kayıt tetikleme · 2.000 istemcili take'in UI üzerinden provası · tarayıcı E2E turu (elle yapıldı, otomatik değil).
