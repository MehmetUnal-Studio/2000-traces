# Eseri okumak

2000 TRACES, katılımcıların nota ve X/Y hareket olaylarını etkileşimli bir esere dönüştürür. **Nebula**, canlı kayıt ve arşiv oynatımı için tek görünümdür: veriler karanlık bir merkezin çevresinde kıvrılır; derinlik, ince bağlantılar ve ışık katmanları ortak bir çekim alanı oluşturur.

## Giriş ve keşif

Ana adres, **Stars of The Year / Senenin Yıldızları** girişini açar. Altın gezegen ufku ve yıldız alanı kodla üretilmiş bir kapak görselidir; katılımcı verisi değildir. **Deneyime gir**, **Canlı kayıt başlat** ve **Kayıtları keşfet** ayrı eylemlerdir. **Başlangıç** girişe döner; devam eden kaydı durdurmaz. Sunucuda zaten kayıt sürüyorsa sade ana adres doğrudan bu oturuma katılır.

- Bir ize dokunarak katılımcıyı seçin ve X/Y bilgisini inceleyin.
- Sürükleyerek kaydırın; tekerlekle veya dokunmatik ekranda iki parmakla yakınlaşın.
- **Shift + dikey sürükleme** ya da **Eseri oku → Bakış / eğim**, üç boyutlu yapıya farklı açılardan bakmayı sağlar. Eğim ve yörünge hareketi canlı kayıtta da kullanılabilir.
- **F / ekrana sığdır** kaydırma, yakınlaşma ve ek eğimi sıfırlar. **Esc** seçimi / açık açıklamayı kapatır. **H** arayüzü gizler; H veya geri dönüş düğmesi arayüzü geri getirir.
- Arşivde alt denetimlerle oynatın, zamanı seçin, hızı değiştirin veya son hâle dönün. Canlı kayıt sırasında zaman çizelgesi ve dışa aktarma kapalıdır.

`?pack=kayit-adi` aynı yerel paketi, `?demo=1` sentetik örneği doğrudan açar. Bu adresler giriş ekranını atlar; kayıt dosyalarını başka bir makineye taşımaz. Örnek 2.000 katılımcılı, **90 saniyelik** bir çalışmadır. Yeni kayıtların varsayılan süresi **180 saniyedir**; örneğin ve eski kayıtların kendi süresi korunur.

## Görsel ile veri arasındaki bağ

| İşaret | Karşılığı |
| --- | --- |
| X ekseni | Kaydedilmiş yatay değer, yörüngenin açısal kıvrımını değiştirir. |
| Y ekseni | Kaydedilmiş dikey değer, yörünge yarıçapını ve derinliği değiştirir. |
| Sarmaldaki ilerleme | Olay zamanı izleri içeri doğru sarar. Oynatma zamanı diskin yönelimini de belirler. Katılımcıya bağlı sabit yollar görsel düzeni oluşturur. |
| İnce bağlantılar | Aynı katılımcının **bilinen aynı parmağına** ait ardışık X/Y noktalarıdır. Kişiler arasındaki bir sosyal bağı göstermez. |
| Mavi / altın ışık | Sanatsal ışık malzemesidir; müzik hattı, ses yüksekliği veya fiziksel enerji ölçümü değildir. |
| Merkezin çevresindeki korona | Son nota başlangıcı ve hareket olaylarının hızına tepki veren görsel ışıktır. Karanlık merkez, arkasında kalan noktaları örter. |

Canlı ve arşiv aynı koordinat eşlemesini ve Nebula malzemelerini kullanır. Üç boyutlu konumlar ile gölgelenme derinlik hissini oluşturur; bu, fiziksel bir galaksi veya kara delik simülasyonu değildir. Koronanın prosedürel dokusu ek veri noktaları üretmez.

**Akış yoğunluğu**, yalnız gerçekleşmiş nota başlangıcı ve hareket olaylarından hesaplanır. Her olay sönümlenen olay/saniye hızına katkı verir; sessizlik yaklaşık bir saniyelik üstel sönüm oluşturur. Bağlantı, durum ve nota bitişi mesajları yoğunluk eklemez. Canlı ve arşiv aynı sabit ölçeği kullanır. İleri / geri zaman seçimi ilgili geçmişi yeniden örnekler; sonraki olayları veya önceki oynatmanın yoğunluğunu taşımaz.

**Eseri oku → Yörünge hareketi**, veriyi değiştirmeyen ek dönüşü açıp kapatır. Bu hareket ve koronanın doku animasyonu yeni seyirci verisi alındığı anlamına gelmez. Azaltılmış hareket tercihi ek yörünge hareketini varsayılan olarak kapatır.

## Kayıtlı X/Y'yi incelemek

Bir izi seçtiğinizde X/Y, olay zamanı ve varsa parmak kimliği inceleme panelinde görünür. Küçük koordinat alanı en fazla **64 gerçek iz örneğini** gösterir. Eksik koordinatlar `—` olarak kalır; gösterilen değerlerin üzerine gelmek yuvarlanmamış sayı değerini verir.

Arşivde ilk seçim, tıklanan olayın kendi değerlerini gösterir. Oynatma veya zaman seçimi ardından seçili katılımcının ilgili parmağının son kayıtlı konumu izlenir; ara koordinat üretilmez. Nota bitişi, bağlantı kesilmesi, eksik koordinat veya **1,2 saniyeden uzun** veri boşluğu çizgiyi keser. Son konum gerekirse görünür kalır ve etkin bir jest olarak etiketlenmez. Dokunuş kimliği bilinmeyen olaylar tekil noktalardır; uydurulmuş bir parmak çizgisine bağlanmaz.

X/Y kaynağı eser bilgisinde belirtilir:

- **X/Y kayıt mevcut:** `gestures.bin`, ham JSONL'de bulunan X, Y, zaman ve parmak bilgisini Float64 olarak taşır; eksik alanlar korunur.
- **Eski paket · 16-bit X/Y:** eski `events.bin` içinde U ve V zaten bulunur. Bu değerler nicemlenmiştir; parmak kimliği ve bir sıfırın gerçek değer mi, eski eksik-alan varsayımı mı olduğu ayırt edilemez.
- **Örnek X/Y verisi:** sentetik örnek kayıttır.

Eski paketlerde X zaman bilgisinden türetilmez, Y başka bir eksenden uydurulmaz. Ham JSONL daha ayrıntılı koordinat ve parmak bilgisi içeriyorsa yeniden paketlemek bunu yan dosyaya taşır; ham kayıtta bulunmayan bilgi geri üretilemez.

## Örnekleme ve sayım sınırları

Nebula en fazla **230.000 gerçek nota / hareket örneği**, **7.000 ışık halesi** ve **100.000 aynı bilinen parmağa ait ardışık hareket bağlantısı** tutar. Haleler mevcut örneklerin görsel katmanıdır; ek kayıt olayı değildir. İki geçerli koordinatı bulunmayan olaylar nokta bulutuna eklenmez.

Arşivde nota başlangıçlarına ayrılan nokta üst sınırı 26.000'dir; örnekler deterministik seçilir. Canlı görünümde artan akış sınırlı bir örnek havuzuna alınır. Paket tamamlanınca arşivin örnek seçimi farklı olabilir; kaynak koordinatlar ve görsel eşleme korunur. **Milyonlarca olayın tamamı ayrı GPU noktaları olarak gösterilmez.**

Katılımcı / olay sayıları nokta sayısından türetilmez; kaynak oturum veya manifest sayımlarıdır. Toplam olay sayısı yaşam döngüsü mesajlarını da kapsar. Arşivde seçili katılımcının X/Y oynatımı ve akış yoğunluğu, görsel örneklemeden bağımsız olarak kayıt verisini okur. Canlı görselleştirme tamponları ham kayıt deposundan ayrıdır; işletim sınırları [operatör kılavuzunda](OPERATOR.md) bulunur.

## Görseli kaydetmek

**Görseli kaydet**, tamamlanmış Nebula'yı **4096 × 4096 PNG** olarak hazırlar. Önizlemede eseri inceleyin ve **PNG'yi indir** bağlantısıyla dosyayı kaydedin. Çıktı tüm kayıt süresinin son hâlini ve o andaki kayıtlı akış yoğunluğunu kullanır; kullanıcının kamera kaydırması, yakınlaşması, ek eğimi, seçim vurgusu ve arayüzü içermez. Standart eğik bakış korunur. Etkileşim durumu işlemden sonra geri yüklenir. Önizleme kapandığında geçici görsel belleği serbest bırakılır; JSONL ve paket dosyaları değişmez.

Kaynaklar: [Nebula](../viz/src/nebula.js), [canlı Nebula](../viz/src/live-nebula.js), [görsel malzemeler](../viz/src/nebula-shaders.js), [X/Y oynatımı](../viz/src/gesture-replay.js), [akış yoğunluğu](../viz/src/flow-energy.js), [PNG çıktısı](../viz/src/export-still.js).
