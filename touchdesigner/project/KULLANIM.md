# 2000 TRACES — Etkileşimli sinema

Projeyi **TouchDesigner 2025.33230** ile açın. `.toe` dosyasıyla `recording` klasörünü birlikte tutun. Masaüstü tesliminin adı **2000 Traces Interactive.toe**, GitHub paketindeki karşılığının adı **2000 Traces Cinematic.toe**.

## Görsel pencereyi açmak

Etkileşimli pencere proje açıldığında otomatik açılır. Kapattıysanız `/traces_cinematic` bileşenini seçin; **Custom Parameters → Playback → Open interactive cinema** satırındaki **Pulse** düğmesine basın. Otomatik açılmayı aynı sayfadaki **Open cinema when project loads** ile değiştirebilirsiniz.

Bu pencere `VIEWPORT` üzerinden açılır. Ham `OUT_CINEMATIC` TOP'u temiz görsel çıktısıdır; kamera kontrolleri ve koltuk paneli için etkileşimli pencereyi kullanın.

## Gezinme ve oynatma

| Hareket | Kontrol |
| --- | --- |
| Kara deliğin etrafında dönme | Sol tuşla sürükle |
| Görüşü sağa/sola/yukarı/aşağı kaydırma | Shift ile sürükle veya orta tuşla sürükle |
| Yaklaşma / uzaklaşma | Tekerlek veya sağ tuşla dikey sürükleme |
| Geniş kadraja dönme | **Kadrajı sıfırla** veya **F** |
| Kaydı oynatma / duraklatma | **OYNAT / DURAKLAT** veya **Space** |
| Kaydın bir anına gitme | Alt zaman çubuğu |
| Otomatik kamera yoluna dönme | **KAMERA: SERBEST** düğmesine basarak **KAMERA: SİNEMA** yap |

Klavye kısayolları için önce görsel alanına tıklayın. Fareyle gezinmeye başladığınızda sinematik kamera, bulunduğu açıdan serbest kontrole geçer. Gezinmek kaydı başa sarmaz. Dahil edilen kayıt üç dakikadır.

## Tek koltuğu izlemek

**Koltuk seç** menüsünden koltuğu seçin veya görünür izine tıklayın. Sağdaki panel kayıtlı **X/Y**, **parmak numarası**, **zaman**, hareket hızı ve son hareket çizgisini gösterir. Değerler oynatma ve zaman çubuğunda gezinme sırasında güncellenir.

- **SOLO: AÇIK:** Yalnızca seçilen koltuğun kayıtlı izleri görünür. Kara delik ve dekoratif yıldızlar sahnede kalır.
- **SOLO: KAPALI:** Tüm koltuklar görünür; panel seçtiğiniz koltuğu takip eder.
- **Seçimi kaldır:** Tüm kayda geri döner.

Kara deliğin hemen yakınındaki merceklenmiş izlerde tıklama komşu bir izi seçebilir; kesin seçim için koltuk menüsünü kullanın. **Esc** seçimi temizler; yüzen pencereyi de kapatabilir.

## Arka plandaki yazı

`/traces_cinematic` içindeki **Custom Parameters → Title** sayfasından **Stars of The Year** yazısını açıp kapatabilir; görünürlüğünü, boyutunu, uzaklığını ve yüksekliğini değiştirebilirsiniz. **Keep title facing the camera** açıkken yazı, kamera etrafında dönseniz de sahnenin arkasında kalır. Kapalıyken azimut ve yükseklik açısıyla sabit yönünü ayarlayabilirsiniz.

Başlangıç görünürlüğü **0.12** değerindedir. Yazı ayrı bir son görüntü katmanıdır; kara deliğin ışığını, yıldızların parlamasını veya merceklenmeyi değiştirmez. Yazının kendisi `title_stars`, `title_of` ve `title_year` Text TOP'larında düzenlenebilir.

## UDP

Bu kontroller görsel oynatmayı yönetir. Projeyi açmak, **OYNAT** düğmesine basmak, gezinmek veya koltuk seçmek UDP gönderimini başlatmaz. UDP geri gönderimi ayrı kontrollerden ve özgün oturum arşivinden yapılır; bu teslimde kapalı tutulmuştur.
