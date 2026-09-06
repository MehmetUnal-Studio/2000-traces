# 2000 TRACES — TouchDesigner

Yeni yerel sinematik sürüm: [Cinematic proje ve kullanım rehberi](TOUCHDESIGNER-CINEMATIC.md). Aşağıdaki belge ilk Native sürümün veri/UDP sözleşmesini ve doğrulamasını korur.

GitHub'daki taşınabilir sinematik proje: **[touchdesigner/project](../touchdesigner/project/README.md)**. Bu klasör `.toe`, `.tox` ve sahnenin gerektirdiği kayıt verilerini birlikte içerir. Aşağıdaki Native sürüm bilgileri önceki teslimin kaydıdır; güncel sürüm için [sinematik kılavuzu](TOUCHDESIGNER-CINEMATIC.md) kullanın.

Klasördeki **2000 Traces Native.toe** dosyasını açın; bu düzenlenebilir TouchDesigner projesidir. `.tox`, aynı ağı başka bir projeye eklemek içindir. `recording/` klasörünü proje dosyasıyla birlikte taşıyın; sahnenin kayıt verileri burada bulunur. `.tox` başka bir klasördeki projeye eklenirse **Data → Assets** yolunu bu `recording/` klasörüne ayarlayın.

Bu sürüm, 578 katılımcının 1.073.700 olay içeren üç dakikalık kaydını kullanır. Galaksi, kara delik, merceklenme ve ışık işlemleri TouchDesigner'ın kendi GLSL MAT/TOP operatörlerinde çalışır. Çalıştırmak için tarayıcı veya JavaScript sunucusu gerekmez; JavaScript yalnızca farklı bir kaydı hazırlayan çevrimdışı dışa aktarıcıda kullanılır.

## Görseli açmak

Projede **`/traces_native`** bileşenini seçip Custom Parameters panelini açın. Son görüntü, bileşenin içindeki **`OUT_NEBULA`** TOP'udur. Kendi efektlerinizi veya çıkış ağınızı bunun arkasına bağlayabilirsiniz.

Başlangıç çözünürlüğü **1280 × 720**. Bu bilgisayarda gözlenen TouchDesigner NonCommercial lisansı, TOP çözünürlüğünü eksen başına 1280 ile sınırlar; bu nedenle Width ve Height kontrolleri en fazla 1280'e ayarlanır.

| Sayfa | Kontrol | Kullanım |
| --- | --- | --- |
| Playback | Play | Kaydın görsel zamanını oynatır veya duraklatır. |
| Playback | Position | Kayıt içinde saniye olarak gezinir; toplam süre 180 saniyedir. |
| Playback | Speed / Loop | Oynatma hızını ve döngüyü ayarlar. |
| Playback | Restart | Baştan oynatır. |
| Playback | Lane | Katılımcıyı vurgular; `-1` tüm katılımcıları gösterir. Lane, koltuk numarası değil, kayıt içindeki katılımcı indeksidir. |
| Camera | Distance | Kamerayı fiziksel olarak yaklaştırır veya uzaklaştırır. |
| Camera | Azimuth / Elevation | Kameranın yatay ve dikey açısını değiştirir. |
| Camera | Fov | Dikey görüş açısını ayarlar. |
| Camera | Approach / Fit | 12 saniyelik yaklaşmayı başlatır veya kamerayı başlangıç görünümüne döndürür. |
| Image | Width / Height | Çıkış çözünürlüğünü ayarlar. |
| Image | Orbit / Tilt | Galaksinin dönüşünü ve disk eğimini değiştirir. |
| Image | Animate | Kayıt duraklatıldığında da plazma hareketini sürdürür. |
| Data | Assets | Taşınmış `recording/` klasörünün yolunu düzeltir. |
| Data | Session / Events / Participants | Kaynağın kimliğini ve toplam sayılarını gösterir. |
| Data | Eventindex | İncelenecek özgün kayıt olayının indeksini seçer. |

## Telefon hareketini incelemek

**Data → Eventindex** değiştiğinde içerideki **`SOURCE_EVENT`** Table DAT güncellenir. Burada kaydedilmiş X/Y, zaman, parmak kimliği, katılımcı, bölge, koltuk ve olay türü görünür. Eksik bilgiler üretilmez; `hasXY`, `fingerKnown` ve `exact` alanları eldeki verinin niteliğini açıklar.

Bu indeks, özgün kaydın olay indeksidir. Çizilen 230.000 noktanın sıra numarasıyla aynı değildir. Dışa aktarılan `source-indices` ve `source-pairs` dosyaları görsel örnekleri özgün olaylara bağlar. İnceleme işlemi oynatmayı veya UDP çıkışını başlatmaz.

## Düzenlenebilir görüntü ağı

| Operatörler | Görev |
| --- | --- |
| `dust_*`, `halos_*`, `filaments_*` veri TOP'ları | Kayıttan alınan konum, zaman, katılımcı, boyut ve hareket verilerini tutar. |
| `dust`, `atmosphere`, `filament` ve ilgili MAT/DAT'lar | Kaydın noktalarını, gazını ve parmak izlerini GPU instance'larıyla çizer. |
| `stars`, `clouds` | Uzamsal derinlik için dekoratif arka planı oluşturur. |
| `camera`, `camera_target`, `depth_camera` | Tüm katmanların ortak kamera görünümünü sağlar. |
| `field`, `field_depth` | Galaksi rengini ve derinliğini ayrı işler. |
| `black_hole`, `black_hole_depth` | Eğrilen ışınlarla kara deliği ve plazma diskini hesaplar. |
| `gravitational_lens` | Arka planın merceklenmesini ve ön/arka örtüşmesini birleştirir. |
| `glow_extract`, `glow_0_x/y`, `glow_1_x/y` | Parlak bölgelerin ışık yayılımını üretir. |
| `display_transform`, `OUT_NEBULA` | Pozlama ve ekran renk dönüşümünden sonra son görüntüyü verir. |
| `runtime`, `clock`, `texture_loader` | Yerel Python üzerinden kayıt saatini, kontrolleri ve veri yüklemeyi yönetir. |

Shader metinleri ve Python çalışma kodu DAT'ların içindedir. Kayıt geometrisinin örnekleme sınırları ve instance sayıları bu kayda göre hazırlanmıştır; başka bir kayıt kullanırken yalnızca Assets yolunu değiştirmek yerine veriyi yeniden dışa aktarın ve ağı yeniden oluşturun.

## Kayıt ve UDP

Canlı veri toplama ve üç dakikalık kayıt, mevcut kayıt sunucusunda devam eder. Bu TouchDesigner ağı hazırlanmış bir kayıt paketini yerel olarak oynatır.

UDP denetimi, mevcut sunucunun `http://127.0.0.1:8787` adresindeki oynatma servisini kullanır. **Prepare** kaydı sessizce hazırlar; **Play** açıkça UDP gönderimini başlatır; **Pause** duraklatır; **Stop** sunucudaki gönderimi durdurur. Başlangıçta UDP çıkışı kapalıdır. Görseli açmak veya kaynağın olaylarını incelemek paket göndermez.

UDP için özgün `session-2026-09-05T16-56-19-183Z.jsonl` kaydının sunucunun kayıt arşivinde bulunması gerekir. Teslim edilen `recording/raw/` görselleştirme paketidir; özgün JSONL'nin yerine geçmez. UDP adreslerini, olayların OSC dönüşümünü ve gönderim saatini mevcut sunucu yönetir. TouchDesigner'dan çıkmadan önce gönderimi **Stop** ile durdurun; sunucu ayrı bir süreçte çalışır.

UDP paneli TouchDesigner içinde sahte HTTP yanıtlarıyla Prepare, Play, Pause, seek ve Stop akışında doğrulandı. Görsel, UDP modunda sunucunun saatini izler; yerel Loop otomatik UDP döngüsü başlatmaz. Gerçek UDP gönderimi ve alıcıda ses bu oturumda denenmedi. Ayrıntılı mevcut protokol: [UDP-REPLAY.md](UDP-REPLAY.md).

## Bu oturumdaki doğrulama

Yerel ağdaki tüm GLSL MAT/TOP'lar derlendi; özyinelemeli operatör hata denetimi sıfır hata döndürdü. Başlangıç ve **35° azimuth / 30° elevation** görünümleri TouchDesigner içinde incelendi. 12 saniyelik kamera yaklaşması, 1,15 mesafede yakın plan, 0/36/180 saniyeye sarma ve 2× oynatma kontrol edildi. `.tox` farklı bir üst bileşenin altına yeniden yüklendi; tüm operatörler hatasız çalıştı ve donmuş kare özgün ağla piksel piksel aynı çıktı. Kaydedilen `.toe` yeniden açılarak da doğrulandı: 91 yerel operatör, sıfır hata/uyarı ve doğru göreli veri yolu. UDP başlangıçta kapalı kaldı.

Çok yakın planda seyrek nokta derinliği ile merceklenme arasında benekli geçişler görülebilir. Bu, mevcut görsel motorunun yaklaşık mercek/örtüşme yönteminden taşınan bir sınırlamadır; tam fiziksel ışın izleme değildir.

Veri dışa aktarımı ve kesin zaman sınırı kontrolleri: [TOUCHDESIGNER-DATA-VALIDATION.md](TOUCHDESIGNER-DATA-VALIDATION.md).

## Geliştirici komutları

Kaynak depo kökünde:

```sh
npm run td:shaders
npm run td:shaders:check
npm run td:cinematic:field
npm run td:cinematic:field:check
npm run td:export -- <kaynak-paket-klasörü> <çıktı-klasörü>
npm run test:td
```

İlk komut native GLSL dosyalarını kaynak shader'lardan üretir; `td:cinematic:field` bunlardan sinematik alanın on shader dosyasını türetir. `:check` komutları dosyaları yeniden üretmeden eşleşmeyi doğrular; kaynak shader değişmişse önce temel, ardından sinematik shader'lar üretilir. `td:export` kaydın özgün verilerini ve yerel GPU dizilerini dışa aktarır. `test:td`, dışa aktarım testlerini, Python UDP istemcisi ve saf kamera yolu testlerini, temel ve sinematik shader eşleşmelerini çalıştırır. Mevcut CI bu komutu Node 22 ve 24 ile çalıştırır. Bu geliştirme adımları Node.js ve Python 3 kullanır; teslim edilen `.toe` bunları ayrı süreçler olarak çalıştırmaz.

Geliştirici yeniden oluşturma: TouchDesigner Textport içinde `TRACES_SOURCE_DIR` değişkenini bu reponun `touchdesigner/` klasörüne ayarlayın; `exec(compile(open(TRACES_SOURCE_DIR + "/build_network.py").read(), "build_network.py", "exec"))` çalıştırın. Farklı bir dışa aktarım için `TRACES_ASSET_DIR` yolunu da verin. Oluşturucu yalnızca kendi `/traces_native` bileşenini yeniden kurar; UDP çıkışı açıkken yeniden oluşturmayı reddeder. `bootstrap.py` ve `td_request.py` geliştirme sırasında kullanılan geçici yerel yardımcıdır; teslim edilen `.toe/.tox` bunlara ihtiyaç duymaz.
