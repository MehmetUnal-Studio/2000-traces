# Eseri okumak

2000 TRACES, bir kayıt oturumundaki ses ve hareket olaylarını dairesel bir veri eserine dönüştürür. **Atlas** ışıklı koyu zemin, **Mürekkep** ise açık kâğıt üzerinde grafik bir baskı yorumudur. İki görünüm aynı veriyi, konumları ve geometriyi kullanır.

## Görsel karşılıklar

| İşaret | Verideki karşılığı |
| --- | --- |
| İç içe hücre halkaları | Katılımcı sırasına göre oluşturulan **en fazla 96 grup**, merkezden dışarı doğru yerleşir. Gruplar birden çok oturma bölgesini kapsayabilir. |
| Hücre halkalarındaki açısal dilimler | Kayıt süresinin **360 eşit zaman aralığı**. Zaman tepeden başlar, saat yönünde ilerler. 90 saniyelik kayıtta her dilim 250 ms'dir. |
| Hücrenin alanı, tonu ve kabartısı | O gruptaki nota başlangıcı + hareket sayısı, kaydın en yoğun hücresine oranlanır: `(aktivite / en yüksek aktivite)^0,60`. Alan, ışık ve kabartı bu değerden görsel eğrilerle türetilir. **Ses yüksekliği, akustik enerji veya duygu ölçümü değildir.** |
| Atlas'taki hücre rengi | Yalnız **nota başlangıçları** arasındaki baskın müzik hattı. Nota içermeyen hareket hücreleri aktivitesini koruyarak nötr çizilir. Standart palet on nota hattını ayırır; diğer hat değerleri metaveride korunur ve nötr çizilir. Dış çubukların gövdesi nötrdür; uç rengi katılımcının baskın nota hattını taşır. Mürekkep'te renk ayrımı tek renk baskıya dönüşür. |
| Dış çeperdeki işaretler | Açısal konum burada zamanı değil, katılımcı sırasını belirtir. Her katılımcının ayrı konumu vardır. Olay üretmiş katılımcılarda uzun çubuk toplam olay sayısını, küçük iç çubuk nota başlangıçlarının tüm olaylara oranını gösterir. Uzunluklar aynı kayıt içinde ölçeklenir. |
| Merkezdeki bağlantılar | **Aynı katılımcının zaman sırasındaki ardışık nota başlangıçları**. Uçlar iki notanın zamanına bağlıdır. Eğrinin yolu bir görsel düzenleme tercihidir; kişiler arasında sosyal bağ veya nedensellik iddiası taşımaz. |

Örnekte 2.000 katılımcı bulunur; gerçek bir kaydın çeperindeki katılımcı sayısı kendi manifestinden gelir. Henüz olay üretmemiş katılımcılar için ölçek işareti bulunur, aktivite çubuğu bulunmaz.

## Keşfetmek

- Bir hücreye dokunun: katılımcı aralığını, zaman dilimini, olay / nota / hareket sayılarını inceleyin. Dış çeperdeki bir çubuğa dokunarak o katılımcıyı seçin.
- Sürükleyerek kaydırın; tekerlekle veya dokunmatik ekranda iki parmakla yakınlaşın.
- **Shift + dikey sürükleme** ile kabartıya farklı açılardan bakın. **Eseri oku → Kabartı / eğim** aynı işlemi dokunmatik ekran ve klavyeyle de sağlar.
- **F / ekrana sığdır** kaydırma, yakınlaşma ve eğimi sıfırlar. **Esc** seçimi / açık açıklamayı kapatır. **H** arayüzü gizler; H veya görünür geri dönüş düğmesi arayüzü geri getirir.
- Alt denetimlerle oynatın, zamanı seçin, hızı değiştirin veya son hâle dönün. Arşivden başka bir kayıt açabilirsiniz.

Seçtiğiniz eser ve görünüm sayfa adresine yazılır. Örneğin `?pack=kayit-adi&style=ink`, aynı yerel paketi Mürekkep görünümünde; `?demo=1&style=ink` örneği açar. Sayfayı yenilemek eser / görünüm seçimini korur; URL kayıt dosyalarını başka bir makineye taşımaz.

## Tam sayımlar, özetlenmiş çizim

Kaydın bütün olayları taranır; hücre ve katılımcı sayımları örnekleme yapılmadan hesaplanır. Toplam olay sayısına bağlantı / yaşam döngüsü kayıtları da dahildir. Görsel aktivite hücreleri yalnız nota başlangıcı veya hareket içeren aralıklar için çizilir.

İnceleme panelindeki **log yoğunluk**, `log1p(aktivite) / log1p(en yüksek aktivite)` oranıdır. Bu sayısal özet ile geometriyi süren üs eğrisi farklıdır; ikisi de aynı gerçek aktivite sayımlarından türetilir.

GPU'da her olay için ayrı bir nokta tutulmaz: halkalar en fazla **96 × 360 = 34.560 hücreyle** sınırlandırılır. Katılımcı çubukları bireyseldir. Merkezde en fazla **5.000 gerçek ardışık nota geçişi**, tüm geçişler üzerinden eşit aralıklı ve deterministik olarak seçilir. Bu çizgiler bütün nota geçişlerini temsil etmez. Hücre sayımları bu bağlantı örneklemesinden etkilenmez.

Oynatma bu özetleri açığa çıkarır: bir hücre, zaman dilimi tamamlandığında; bir bağlantı, ikinci nota gerçekleştiğinde; bir katılımcı çubuğu, o katılımcının son olayı geçildiğinde görünür. Bu nedenle oynatma, her olayın ayrı animasyonu değildir. Yoğunluklar tüm kayıt üzerinden ölçeklenir. Alan, uzunluk, parlaklık ve kabartı için uygulanan görsel eğriler ek ölçümler değildir; iki kaydın görsel parlaklığı tek başına mutlak bir aktivite karşılaştırması vermez.

Canlı kayıt sürerken ayrı, artan veriyle çalışan görünüm kullanılır. Tam atlas kayıt tamamlanıp paket yüklendikten sonra oluşur. Örnek eser sentetik veridir; canlı kayıt başlatmaz ve gerçek bir performansın kanıtı değildir.

## Görseli kaydetmek

**Görseli kaydet**, seçili Atlas / Mürekkep yorumunu **4096 × 4096 PNG** olarak hazırlar. Açılan önizlemede eseri inceleyin ve **PNG'yi indir** bağlantısıyla dosyayı kaydedin. Çıktı tüm kaydın tamamlanmış hâlidir; kamera kaydırması, yakınlaşma, eğim, katılımcı seçimi, hover vurgusu ve arayüz içermez. Etkileşim durumu işlemden sonra geri yüklenir. Önizleme kapandığında geçici görsel belleği serbest bırakılır. Dışa aktarma kaydın JSONL veya paket dosyalarını değiştirmez.

Uygulama kaynağı: [veri özeti](../viz/src/atlas-data.js), [geometri ve seçim](../viz/src/atlas.js), [görsel malzemeler](../viz/src/atlas-shaders.js), [PNG çıktısı](../viz/src/export-still.js). Kayıt ve kurtarma işlemleri için [operatör kılavuzuna](OPERATOR.md) bakın.
