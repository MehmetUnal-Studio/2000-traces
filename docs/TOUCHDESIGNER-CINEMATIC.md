# 2000 TRACES — Cinematic / TouchDesigner

Bu sürüm ayrı bir yerel ağdır: **`/traces_cinematic`**. Önceki `/traces_native` ağı karşılaştırma için korunur, sinematik proje içinde hesaplaması kapalıdır. Kaynak görüntü, video veya tarayıcı girişi kullanılmaz.

GitHub'dan indirmek için [taşınabilir proje klasörünü](../touchdesigner/project/README.md) kullanın; kayıt verileri dahil tüm klasörü birlikte tutun.

GitHub paketindeki `.toe`, 6 Eylül 2026 saat 10:16'daki son Desktop kaydıdır ve sonraki görsel/kamera ayarlarını korur (70.802 byte). Aşağıdaki ölçümler önceki başlangıç ayarlarına aittir. Son dosya ayrıca Derivative `toeexpand` ile açılarak 73 düğüm, göreli kayıt yolu, geçici yardımcıların yokluğu ve değişmemiş gömülü runtime/kamera/plazma/çevre/UDP kaynakları doğrulandı. `.tox` önceki doğrulanmış başlangıç ayarlarını taşır.

Teslim klasöründeki **2000 Traces Cinematic.toe** projeyi, **2000 Traces Cinematic.tox** ise başka bir TouchDesigner projesine eklenebilen bileşeni içerir. `recording/` klasörünü beraber taşıyın. Başka klasördeki bir projeye TOX eklerken **Data → Assets** yolunu bu klasöre ayarlayın.

## Açılış ve kullanım

`/traces_cinematic` bileşeninin **Custom Parameters** penceresini açın. Son görüntü içerideki **`OUT_CINEMATIC`** TOP'udur. Bu çıkış Syphon, NDI, projektör veya kendi çıktı ağınıza bağlanabilir; mevcut projede harici görüntü yayını başlatılmaz.

- **Camera → Start cinematic recording playback**: kaydı baştan, üç dakikalık kamera koreografisiyle oynatır.
- **Playback → Play / Position**: oynatmayı durdurur veya kaydın herhangi bir saniyesine gider. **Director** açıksa kamera o kayıt konumuna gider; geri sarma da aynı yolu izler.
- **Camera → Director kapalı**: Distance, Azimuth, Elevation ve Fov elle düzenlenir. Kamera fiziksel olarak ilerler; Distance değişimi görüntü ölçeklemesi değildir. Yönetmen modundan çıkarken konum, hedef ve odak korunur, ani sıçrama yapılmaz.
- **Approach**: bulunduğunuz yerden 16 saniyelik yaklaşma. **Fit**: genel görünüme dönüş.
- **Image → Animate**: duraklatıldığında plazmanın hareketini sürdürür. Sabit kare karşılaştırması veya deterministik dışa aktarım için kapatın.

| Sayfa | Başlıca ayarlar |
| --- | --- |
| Plasma | Gazın ışık şiddeti, optik yoğunluğu, türbülans ayrıntısı ve kalınlığı. Curvature merceklenmeyi; Doppler asymmetry bakış açısına bağlı parlaklık farkını değiştirir. |
| Starlight | Kayıttan gelen noktalar, gaz ve parmak çizgilerinin ışığı. Aperture, yakın noktaların odak dışı ayak izini ayarlar; enerji korunur. Distant galactic dust/starfield dekoratif çevredir. |
| Optics | Pozlama, doygunluk, bloom, yatay ışık saçılması, çok hafif film greni ve kenar kararması. Plasma render scale kalite/maliyet dengesidir. |
| Data | Kaynak kimliği ve olay inceleyici. Eventindex özgün olay indeksidir; görsel instance indeksi değildir. |
| UDP | Prepare sessizce hazırlar. Play UDP gönderir. Pause duraklatır. Stop çıkışın kapandığını doğrular. Görsel oynatma tek başına UDP göndermez. |

Başlangıçta UDP kapalıdır. UDP paneli önceki yerel sürümün aynı denetlenmiş istemcisini kullanır. Sunucu saati etkin olduğunda kamera da o konumu izler; yerel Loop ikinci bir gönderim saati oluşturmaz. Canlı kayıt ve OSC adresleme mevcut kayıt sunucusunda kalır. Ayrıntılar: [TouchDesigner veri/UDP rehberi](TOUCHDESIGNER.md#kayıt-ve-udp).

## Yerel görüntü ağı

73 operatör içindeki ana görüntü yolu:

```text
Kayıt TOP'ları → instanced Geometry COMP + GLSL MAT
                        ↓
               starlight_layers (iki HDR buffer)
                  ↙                  ↘
              arka ışık          foreground
                  ↓                  ↓
galactic_environment → gravitational_lens ← plasma_volume
                                               + plasma_depth
                              ↓
                    optical_bloom (Bloom TOP)
                    anamorphic_scattering (Blur TOP)
                              ↓
                    film_grade → subpixel_antialias
                              ↓
                         OUT_CINEMATIC
```

- **`plasma_volume`**: kalınlığı olan, ışık yayan ve soğuran gaz. Eğri ışın boyunca Beer–Lambert soğurma; farklı hızda akan lifler, küçük sıcak düğümler, daha soğuk dış gaz. İçerideki küre ışık yaymaz. Kayıt etkinliği ışığı, kaydedilmiş hareket ise akış davranışını etkiler.
- **`plasma_depth`**: 32 bit kayan noktalı derinlik. Derinlik kaynağının kendisi 32F'tir; sonradan dönüştürülmüş düşük hassasiyetli bir tampon değildir.
- **`starlight_layers`**: tek Render TOP içinde iki HDR ışık tamponu. Ön ve arka katkılar fragment derinliğinden ayrılır. Önceki seyrek nokta maskesiyle tüm pikseli bir katmana geçirme yöntemi kaldırıldı.
- **`gravitational_lens`**: yalnız arka ışığı büker; ön yıldızlar kendi perspektifinde kalır. Kara delik, gaz ve yıldızlar aynı Camera COMP'dan bakış bilgisi alır.
- **`director_path`**: üç dakikalık saf, düzenlenebilir Python kamera yolu. Sabit 45° FOV ile 3,35 birimden 0,96 birime yaklaşır, yakın yörüngeden sonra geri açılır. Yolun başlangıcı ve sonu aynı konum ve hızdadır.
- **`optical_bloom`, `anamorphic_scattering`, `subpixel_antialias`**: TouchDesigner'ın kendi Bloom, Blur ve SMAA Anti Alias TOP'ları. Geçmiş kareleri biriktiren ve kamera hareketinde iz bırakan bir Feedback efekti kullanılmaz.
- **`film_grade`**: HDR ışığı pozlar, parlak bölgeleri yumuşak biçimde sıkıştırır ve bir kez sRGB ekran dönüşümü yapar.

Tüm shader ve Python metinleri projedeki DAT'ların içinde düzenlenebilir. Kaynak sürümleri `touchdesigner/cinematic/` içindedir. Kayıt dizilerinin byte'ları değişmez: 578 katılımcı, 1.073.700 özgün olay, kesin zaman ve X/Y/parmak bilgisi korunur. Dekoratif yıldızlar ve galaktik toz olay sayısına eklenmez.

## Kalite ve kapsam

Bu makinedeki TouchDesigner 2023.12230 NonCommercial anahtarı nedeniyle çıktı **1280×720**'dir. Dengeli ayarda gaz **800×450**, kayıt geometrisi/kompozit/son işlem **1280×720** hesaplanır. **Plasma render scale = 1** gazı da tam çözünürlükte hesaplar; maliyeti artar. Lisans sınırı eksen başına 1280'dir; bu sürüm için 4K veya 60 FPS iddiası yoktur.

Merceklenme ve plazma malzemesi görsel üretim için optik yaklaşımlardır. Bilimsel Kerr/GRMHD simülasyonu veya ölçülmüş astrofiziksel sıcaklık rekonstrüksiyonu değildir. Yüksek ayrıntıdaki sıçramaları gidermek için gazın içinde daha kısa adımlar, eğri ışın türevleri ve örnekleme ayak izine göre filtreleme kullanılır. Çok yakın planda bu filtreleme ince dokuyu yumuşatabilir.

Araştırma ve birincil kaynaklar: [teknik araştırma](TOUCHDESIGNER-CINEMATIC-RESEARCH.md). [Derivative SMAA Anti Alias TOP](https://docs.derivative.ca/Anti_Alias_TOP) son kenar temizliğinin; [Bloom TOP](https://derivative.ca/UserGuide/Bloom_TOP) ise yerel optik ışık yayılımının kaynağıdır.

## Kaynaktan oluşturma

```sh
npm run td:shaders
npm run td:cinematic:field
npm run test:td
```

TouchDesigner Textport:

```python
TRACES_SOURCE_DIR = '/path/to/2000-traces/touchdesigner'
TRACES_ASSET_DIR = '/path/to/recording'
exec(compile(open(TRACES_SOURCE_DIR + '/build_cinematic.py').read(), 'build_cinematic.py', 'exec'))
```

Oluşturucu yalnızca kendisinin işaretlediği `/traces_cinematic` ağını yeniden kurar ve olası UDP gönderimi sürerken işlemi reddeder. `cinematic_bootstrap.py` ve `.build` dosya yardımcısı yalnız geliştirme içindir; teslim edilen projeden kaldırılır.

## 6 Eylül 2026 — yerel doğrulama

Dört kamerada, 1,5 saniyelik yerleşmeden sonra **180 gerçek render karesi** örneklendi. Süreler `time.perf_counter()` ile kareler arasında ölçüldü; bunlar GPU cook süresi değildir. Gerçek output cook sayısı ayrıca kontrol edildi.

| Görünüm | Ortalama FPS | Medyan kare | %95 kare |
| --- | ---: | ---: | ---: |
| Genel görünüm | 29,99 | 33,33 ms | 34,83 ms |
| Eğik disk | 29,99 | 33,36 ms | 35,45 ms |
| Yaklaşma | 29,99 | 33,35 ms | 36,77 ms |
| Yakın yörünge | 29,98 | 33,34 ms | 34,68 ms |

Tüm HDR renk/derinlik tamponları sonlu değerler verdi; native operatör hatası sıfır. 29 kayıt dosyasının tamamı dışa aktarılan kaynakla SHA-256 olarak eşleşti (71.614.519 byte). Kaynak olayı 1.073.690 ayrıca TouchDesigner içinde özgün X=0,478, Y=0,652 ve finger=0 ile okundu. UDP istemcisi hiç başlatılmadı.

**TOX taşıma kontrolü:** `2000 Traces Cinematic.tox` farklı bir üst bileşenin altına yüklendi. 73 operatörün hata ve uyarı alanları boştu. Donmuş çıktı özgün ağla piksel piksel eşleşti: `pixelExact: true`, `maxPixelDifference: 0.0`. UDP istemcisi oluşmadı (`udpClientAbsent: true`). Bu sonuç `tox-validation.json` içinde kayıtlıdır.

**TOE yeniden açılış kontrolü:** kaydedilmiş proje TouchDesigner'da yeniden açıldı; 73 operatörde hata veya uyarı yoktu. Göreli `recording` yolu çalıştı, geliştirme yardımcısı ve geçici test operatörleri bulunmadı; UDP varsayılan olarak kapalı kaldı. Özgün olay 1.073.690, X=0,478, Y=0,652, finger=0 ve kesin zaman 176.051 ms ile yeniden okundu. Önceki Native ağ korundu. `toe-validation.json` raporunda proje adı `2000 Traces Cinematic.1.toe` olarak görünür; bu dosya ile teslimdeki `2000 Traces Cinematic.toe` aynı 70.426 byte ve aynı SHA-256 değerine sahiptir.

Teslim klasöründeki `QA/` dizini, görüntü/kare süresi için `native-validation.json`, 29 kaynak dosyasının bütünlüğü için `assets-validation.json`, taşıma karşılaştırması için `tox-validation.json` ve proje yeniden açılışı için `toe-validation.json` raporlarını içerir.

`npm run check`: 189 JavaScript testi ve Vite build başarılı. `npm run test:td`: 5 dışa aktarım testi, 38 Python testi ve 26 shader/contract dosyası kontrolü başarılı. Python testleri kesin zaman sınırını, gerçek ham X/Y kimliğini, UDP saatinin önceliğini, STOP davranışını, kamera yolu ve manuel geçişin sürekliliğini kapsar.

**Cinematic Preview — 6x.mp4**: yerel Movie File Out TOP ile alınan 900 kare, 1280×720, 30 saniye. Üç dakikalık kaydı/kamera yolunu **6 kat hızlı** gösterir; canlı performans ölçümü değildir. Native projenin gerçek oynatma süresi 180 saniyedir. MJPEG ara çıktı sonradan yalnız dağıtım için H.264'e kodlandı.

Son MP4 dosyası `ffprobe` ile ayrıca denetlendi: H.264, 1280×720, 30 FPS, 900 kare, tam 30,000 saniye ve 21.158.084 byte. Dosyada tek video akışı bulunur; ses akışı yoktur. Makine tarafından okunan sonuç teslimde `QA/preview-ffprobe.json` dosyasındadır.
