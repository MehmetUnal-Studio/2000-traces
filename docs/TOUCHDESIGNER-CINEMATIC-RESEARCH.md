# TouchDesigner sinematik geliştirme araştırması

6 Eylül 2026. Hedef çalışma ortamı: TouchDesigner 2023.12230, macOS, mevcut Non-Commercial lisans ile 1280×720. Bu belge mevcut kaynak kodunun incelemesi ve birincil kaynak araştırmasıdır; aşağıdaki öneriler tek başına uygulanmış ya da performansı doğrulanmış özellikler değildir.

## Mevcut görüntüdeki temel sorun

`touchdesigner/shaders/core.frag`, ışın yönünü sayısal olarak büküyor; ince disk içindeki yolu ve soğurmayı entegre ediyor. Bu, ekrana yapıştırılmış bir daireden daha gelişmiş bir başlangıç. Ancak bükülme kuvveti ayarlanmış Öklid uzayı denklemidir; Schwarzschild/Kerr geodezik çözücüsü değildir. Diskin Doppler çarpanı da sanatsal bir yaklaşımdır.

`composite.frag`, çok sayıda katkılı yıldız/gazın toplam rengini tek en-yakın derinlikle karşılaştırıp keskin ön/arka seçimi yapıyor. `dust.frag` ve `stars.frag` derinlik geçişinde yalnız parlak, küçük merkezleri yazıyor; geniş ışık profilleri aynı derinlik temsilinde bulunmuyor. Yaklaşma sırasında seyrek derinlik beneklerinin bütün piksel katkısını birden öne taşıması, delikli veya benekli örtüşme üretmesi beklenir. Bu, kaynak kodundan çıkarımdır; düzeltme ayrı katman önizlemeleriyle doğrulanmalı.

## İlk uygulanacak teknikler

| Öncelik | Teknik ve yerel uygulama | Görsel kazanç / sınır |
| --- | --- | --- |
| 1 | Katkılı yıldız, toz ve filamentleri parçacık başına kamera uzayında ön/arka HDR hedeflere ayır. Yalnız arkayı mercekle; sonra kara delik geçirgenliği, ardından ön katkıyı birleştir. | Tek seyrek depth örneğinin tüm toplam rengi kesmesini kaldırır. Merkez düzlemine göre iki katman ayırmak hâlâ bir yaklaşımdır; çekirdeği kesen yakın gaz için ışın boyunca örtüşme gerekir. |
| 2 | Kara delik çevresindeki emisyonu daha küçük yapısal ölçeklerle, düzensiz yoğunluk, ışık kaybı ve farklı yörünge hızlarıyla kur. Gazı yansımalı metal yüzey gibi ışıklandırma. | Kesintisiz sarı neon halka yerine sıcak, yarı saydam akış. Parlaklık yalnız bloom'dan gelmemeli; sahne renginde sıcaklık ve yoğunluk farkları bulunmalı. |
| 3 | Düşük çözünürlüklü hacim geçişinde üç boyutlu yoğunluk ve yol boyunca geçirgenlik hesapla; dünyaya sabit örnekleme kullan. | Büyük billboard bulutları yerine kamera hareketinde kalınlık ve karanlık toz şeritleri. Yarım çözünürlük başlangıç bütçesidir; doğruluk/performance ölçülmeden adım sayısı artırılmamalı. |
| 4 | Kamera COMP konumu, hedefi ve hızı için tek ortak rig kullan. Sabit FOV ile fiziksel dolly; kontrollü yanal yol ve yumuşak hızlanma/yavaşlama ekle. | Yakın yıldızların uzaktakilerden daha hızlı geçmesi; disk ve çekirdeğin birlikte büyümesi. Kamera koordinatları hem MAT hem GLSL TOP ışınlarına aynı karede gitmeli. |
| 5 | Lineer HDR → çok ölçekli ışık yayılımı → kontrollü pozlama/ton eşleme → tek ekran dönüşümü. | Parlak merkezde doku korunur, uzayın siyahı kalkmaz. Lens kusurları az ve isteğe bağlı olmalı. |

TouchDesigner GLSL TOP çoklu renk hedefleri ve Render Select TOP ile emisyon, geçirgenlik, derinlik gibi ayrı çıktılar taşınabilir. Renk için 16-bit float yeterli olabilir; kaynak X/Y, kesin zaman ve derinlik hassasiyeti gerekçesiz azaltılmamalıdır. 16-bit hedefe geçiş yalnız bellek/bant genişliği ve görüntü karşılaştırmasıyla yapılmalı. [GLSL TOP](https://docs.derivative.ca/Write_a_GLSL_TOP), [piksel biçimleri](https://docs.derivative.ca/Pixel_Formats), [Render TOP](https://derivative.ca/UserGuide/Render_TOP).

## Fiziksel görünüm için referans

NASA örneğinde disk içindeki parlak düğümler oluşup dağılır; farklı yörünge hızları bunları uzatır. Kenardan bakışta arka disk ışığı üstte/altta görünür. Görüş doğrultusuna yaklaşan taraf daha parlak, uzaklaşan taraf daha sönüktür; tam karşıdan bakışta bu asimetri kaybolur. Küresel kara deliğin foton halkasının yaklaşık dairesel kalması tek başına kamera hatası değildir. Bu projede değerlendirme, diskin eğimi, örtüşme, arkadaki ışığın bükülmesi ve paralaks üzerinden yapılmalı. [NASA / Jeremy Schnittman görselleştirmesi](https://www.nasa.gov/universe/nasa-visualization-shows-a-black-holes-warped-world/).

Gerçekçi görünüm ve fiziksel doğruluk ayrı kabul ölçütleridir. Bruneton'un yöntemi, dönmeyen kara delikte Schwarzschild metriği altında önceden hesaplanmış tablolarla ışın demetinin disk ve yıldızlarla kesişimini bulur; yıldız filtrelemesini ayrıca ele alır. İki küçük tablo kullanması mevcut GPU bütçesi için araştırmaya değer. Fakat tam bir aktarım; tablo üretimi, kamera referans sistemi, ışık filtreleme ve doğruluk örnekleri gerektirir. Mevcut `CURVATURE` değerini değiştirmek bu yöntemi uygulamak değildir. [Bruneton, teknik rapor](https://ebruneton.github.io/black_hole_shader/paper.pdf), [yazarın kod ve örnekleri](https://ebruneton.github.io/black_hole_shader/).

Kerr metriğinde dönen kara delik ve keyfi yakın kamera konumları için DNGR, eliptik ışın demetleri kullanır. Bu, sinema referansıdır; bu oturumdaki gerçek zamanlı bütçeyle aynı algoritmanın tamamının çalışacağı söylenemez. [James, von Tunzelmann, Franklin ve Thorne, 2015](https://arxiv.org/abs/1502.03808).

## Bu Mac üzerinde doğru araç seçimi

Vulkan/MoltenVK üzerinden yerel GLSL MAT, GLSL TOP, çoklu hedefler ve hesaplama shader'ları kullanılabilir; macOS'ta geometry shader desteği bulunmaz. Halihazırda çalışan instanced quad yapısı bu nedenle uygun başlangıçtır. Güncel belgedeki her yeni özelliğin 2023.12230'da bulunduğu varsayılmamalı. [Derivative Vulkan açıklaması](https://derivative.ca/solr/vulkan).

Feedback TOP gerçek temporal anti-aliasing değildir. Kamera hareketi, kayıtta seek veya loop sırasında düz renk biriktirme gölge izi yaratır. Temporal çözüm eklenecekse önceki kamera matrisiyle yeniden projeksiyon, derinlik/örtüşme reddi ve geçmişi sıfırlama gerekir; aksi halde ilk sürümde kapalı tutmak daha doğru. [Feedback TOP](https://derivative.ca/UserGuide/Feedback_TOP).

Kamera FOV değiştirmek ile kamerayı taşımak ayrı davranışlardır. Ortak Camera COMP'nin gerçek konumu değişmeli; shader'da bağımsız ekran ölçeklemesi yapılmamalı. Büyük yapıda aşırı alan derinliği bulanıklığı minyatür hissi yaratabilir; yakın parçacıklara kontrollü optik yumuşama dışında derinliği öncelikle paralaks ve örtüşme anlatmalı. Son cümle bir sanat yönetimi önerisidir. [Camera COMP](https://derivative.ca/UserGuide/Camera_COMP).

## Görsel ve performans kabulü

1. **Aynı kayıt, aynı an:** 36, 90 ve 180. saniye görüntülerini aynı kamera/pozlama ile karşılaştır. X/Y ve zaman örneklemesi değişmesin; sinematik materyal özgün verinin yerine geçmesin.
2. **Üç açı:** genel görünüm, 35°/30° eğimli görünüm ve diske yakın kenar görünümü. Merceklenme ile disk aynı uzayda kalmalı; koyu merkezde seyrek depth delikleri veya kameraya yapışık bulutlar görünmemeli.
3. **Tek çekim yaklaşma:** 12–20 saniyelik fiziksel dolly. Yakın/uzak yıldızlar farklı ekran hızına sahip olmalı; başlangıç, bitiş ve elle devralmada hız sıçramamalı.
4. **Materyal yakın planı:** %100 ölçekte sarı alanda tek renk dolgu, eşit aralıklı kazınmış halkalar, rastgele beyaz parıltı gürültüsü veya görünür örnekleme şeritleri bulunmamalı. Parlaklık artsa da koyu gaz aralıkları okunmalı.
5. **Katman kontrolü:** ön alan, arka alan, çekirdek emisyonu ve son HDR görüntü ayrı ayrı kaydedilmeli. Birleşik görüntüde görülen hatanın hangi katmanda başladığı belirlenmeli.
6. **Hareket kararlılığı:** sabit kayıt anında kamera dönerken küçük yıldızlar titreşip kaybolmamalı; atmosfer kareye bağlı rastgele yenilenmemeli. Seek/loop eski görüntü izi taşımamalı.
7. **Ölçülmüş akıcılık:** hedef 1280×720'de en az 30 FPS; ortalama yanında uzun kareler ve 95. yüzdelik kare süresi raporlanmalı. Genel/kenar/yakın açıların her biri en az 10 saniye ölçülmeli. Başarı ölçülene kadar hedef olarak kalır.

GPU shader maliyeti CPU cook zamanıyla eşdeğer değildir. Probe ve Perform CHOP/Trail CHOP ile kare süresi izlenmeli; pahalı TOP'lar ve gereksiz canlı önizlemeler ayrı ölçülmeli. Kare başına GPU→CPU görüntü okuması doğrulama sırasında kullanılabilir, performans ölçümünde kapalı olmalı. [Derivative optimizasyon rehberi](https://derivative.ca/UserGuide/Optimize), [Performance Monitor sınırları](https://docs.derivative.ca/Performance_Monitor).

TouchDesigner'a taşımak kendi başına daha fiziksel bir görüntü garantilemez; Bruneton'un örneği web ortamında da çalışır. Buradaki kazanım, ayrı düzenlenebilir render katmanları, hacimsel malzeme, ortak kamera, HDR kompozit ve ölçülmüş gerçek zamanlı davranışın birlikte geliştirilmesiyle gösterilmelidir.
