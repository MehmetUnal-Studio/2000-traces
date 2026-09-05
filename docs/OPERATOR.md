# 2000 TRACES — Operatör kılavuzu

Bu kılavuz kayıt masasını, görselleştiriciyi ve oturum arşivini yerel makinede kullanmak içindir. Kayıt sunucusu `127.0.0.1` üzerinde çalışır. Tarayıcıyı yenilemek, bir kayıt başlatmak veya durdurmak anlamına gelmez.

## 1. Güvenli önizleme

Node.js 22.12+ ile proje kökünde:

```sh
npm ci
npm run viz
```

[Ana adres](http://127.0.0.1:5174/), **Stars of The Year / Senenin Yıldızları** girişini açar. **Deneyime gir** arşivdeki esere, arşiv boşsa örneğe geçer; **Kayıtları keşfet** kütüphaneyi açar. **Canlı kayıt başlat** kayıt akışını başlatır. Üstteki **Başlangıç** giriş ekranına geri döner; devam eden kaydı durdurmaz. Sunucuda zaten kayıt sürüyorsa sade ana adres doğrudan o oturuma katılır.

[Örnek evren bağlantısı](http://127.0.0.1:5174/?demo=1), girişi atlayarak bellekte üretilen, 2.000 katılımcılı ve **90 saniyelik** sentetik veriyi açar. Kayıt başlatmaz, ham oturum yazmaz ve upstream SSE bağlantısı gerektirmez. Yeni kayıtların **180 saniyelik** varsayılan süresi bu örneğin veya eski kayıtların süresini değiştirmez.

`npm run build` uygulamayı `dist-viz/` içine üretir; kayıt paketlerini bu dizine kopyalamaz. `npm run preview` derlenmiş uygulamayı sunar. Yerel dev ve preview sunucuları `/packs/` isteklerini `viz/public/packs/` dizininden okur; taşınabilir `dist-viz/` tek başına yerel kayıtları içermez.

## 2. Kayıt için başlatma

Canlı akış bilgileri yerel `.env` dosyasında veya süreç ortamında bulunmalıdır. Değerleri Git'e, ekran görüntülerine veya raporlara eklemeyin.

| Değişken | Kullanım |
| --- | --- |
| `CS_EVENTS_URL` | Upstream SSE akışının URL'i; zorunlu |
| `CS_EVENTS_TOKEN` | Bearer kimlik bilgisi; TOKEN veya AUTH gerekir |
| `CS_EVENTS_AUTH` | Basic kimlik bilgisi; TOKEN veya AUTH gerekir |
| `PANEL_PORT` | Panel portu; varsayılan `8787` |

TOKEN ve AUTH birlikte verilirse TOKEN kullanılır; sunucu konsolu bunu bildirir. Ortam değişkenleri `.env` değerlerinden önce gelir. Sürekli 401/403 yanıtı bir kez yeniden denenir, ardından kayıt hatası bildirilir.

İki ayrı terminal açın:

```sh
npm run panel
```

```sh
npm run viz
```

- Kayıt masası: [127.0.0.1:8787](http://127.0.0.1:8787/)
- Görselleştirici: [127.0.0.1:5174](http://127.0.0.1:5174/)

Paneli açmak upstream'e bağlanmaz; bağlantı ancak kayıt başladığında kurulur. Sunucunun çalışıyor olması, upstream'den veri alınabildiği anlamına gelmez. Özel `PANEL_PORT` kullanılıyorsa panel adresini buna göre değiştirin; görselleştiricinin API adresi ayrıca bu yapılandırmayla eşleşmelidir.

## 3. Kayıt masasından oturum alma

Durum akışı: `IDLE → ARMED → RECORDING → FINALIZING → COMPLETE`.

1. İsteğe bağlı **Oturum etiketi** girin. En fazla 40 karakter; harf, rakam, boşluk, `_` ve `-` desteklenir. API de bu sınırı uygular.
2. **ARM · Hazırla** düğmesi kaydı hazırlar. Bu noktada veri kaydedilmez. **DISARM · İptal** ile beklemeye dönebilirsiniz.
3. **Kaydı başlat** düğmesi tek bir oturum başlatır. Durum sunucudan onaylandıktan sonra **KAYDEDİLİYOR** görünür.
4. Yeni kayıtların varsayılan penceresi 180 saniyedir (3 dakika). Önceden kaydedilen oturumların süreleri değişmez. **Durdur** düğmesi erken bitirir; duraklat/devam et yoktur.
5. **PAKETLENİYOR** sırasında yeni kayıt veya durdurma komutu verilemez. **TAMAMLANDI** durumunda ham kayıt arşivde görünür; görsel paket hazırsa ayrıca belirtilir.

Zaman göstergesi sunucunun oturum başlangıç/bitiş zamanlarından hesaplanır. Sayfa kayıt ortasında yeniden açıldığında aynı oturum kimliği, etiketi ve zaman bilgisi alınır. Kayıt sırasında olay akışı susarsa sonlandırma zamanlayıcısı 180 saniyeye ek 5 saniyelik toleransla kaydı kapatır; dolayısıyla süre göstergesi 03:00'ı kısa süre aşabilir.

Veri kartı, **kayda giren katılımcı**, **kaydedilen olay**, **alınan**, **hatalı**, **geç / erken**, **tekrar** sayılarını ayrı gösterir. Kayıt bittiğinde kart **SON OTURUM** olarak işaretlenir; eski sayılar yeni bir kayıt gibi sunulmaz.

Panel durumunu yaklaşık saniyede bir, arşivi beş saniyede bir yeniler. Bağlantı yoksa kontroller kilitlenir, sayılar **SON BİLİNEN VERİ** olarak kalır ve yeniden deneme seçeneği gösterilir. Tarayıcı bağlantısının kaybolması sunucudaki kaydı durdurmaz. Bir komut zaman aşımına uğradığında komut sunucuya ulaşmış olabilir; tekrar denemeden önce güncel durumun doğrulanmasını bekleyin.

## 4. Görselleştirici

- **Nebula**, canlı kayıt ve arşiv oynatımı için tek görünümdür. X yörüngenin açısal kıvrımını, Y yarıçap ve derinliği değiştirir. Seçilen izin koordinatları, olay zamanı ve varsa dokunuş kimliği inceleme panelinde görünür. **Yörünge hareketi** ek görsel harekettir; yeni canlı veri alındığını belirtmez.
- Akış yoğunluğu son nota başlangıcı ve hareket olaylarının hızından hesaplanır; merkez çevresindeki ışık ve korona buna tepki verir. Akış susunca yoğunluk yaklaşık bir saniyelik üstel sönümle azalır; bağlantı ve durum mesajları hareket üretmez. Canlı görünüm ve arşiv aynı sabit ölçeği kullanır; geri sarma önceki oynatmanın yoğunluğunu taşımaz. Bu değer akustik enerji ölçümü değildir. Ayrıntılı eşlemeler [Eseri okumak](ARTWORK.md) belgesindedir.
- Oynatma, zaman çizelgesi ve hız kontrolü kayıtların zaman içindeki gelişimini gösterir.
- Bir ize tıklayarak katılımcıyı seçin ve X/Y hareketini inceleyin. Tekerlek veya iki parmakla yakınlaşın; sürükleyerek kaydırın. **Eseri oku → Bakış / eğim** ya da Shift + dikey sürükleme üç boyutlu yapının bakışını değiştirir. Eğim ve yörünge denetimleri canlı kayıtta da kullanılabilir. **F** görünümü sıfırlar. **Esc** veya boş alana tıklamak seçimi temizler. Geri sarma, seçili katılımcının geçmişteki konumunu gösterir; henüz gerçekleşmemiş koordinatları göstermez.
- **Sahne modu** arayüzü gizler; **H** veya arayüzü göster düğmesi geri getirir.
- **Görseli kaydet** eserin tamamlanmış hâlini 4096 × 4096 PNG önizlemesi olarak hazırlar. Önizlemedeki **PNG'yi indir** bağlantısı dosyayı kaydeder. Çıktı kullanıcının kamera konumunu, ek eğimini, arayüzü ve seçim vurgularını içermez; Nebula standart eğik bakışını korur. Canlı kayıt sürerken dışa aktarma kapalıdır.

Görselleştiricinin **Canlı kayıt** kontrolü aynı kayıt API'sini kullanır. Önce sunucu durumu okunur, yerel canlı SSE bağlantısı açılır, ardından arm/start akışı çalışır. Mevcut eser, sunucudan `RECORDING` onayı gelmeden kaldırılmaz. `?pack=...` ve `?demo=1` bağlantıları giriş ekranını atlayarak belirtilen arşiv/örnek eseri açar. Seçilen eser URL'de korunur; URL kaydı başka bir makineye taşımaz.

Boşluk tuşu kaydı durdurmaz; oynatma kontrolleri arşiv içindir. Kayıt kontrolü klavyeyle odaklandığında Enter, düğmenin normal başlat/durdur eylemini uygular. Kayıt bittiğinde paketleme durumu görünür ve oluşan pakete geçilir. Paket yükleme başarısızsa hata görünür; önceki açılmış eser korunur.

## 5. Arşiv ve kurtarma

Kayıt masasındaki **Oturumlar** listesi ham JSONL dosyalarını tarih, etiket, katılımcı, olay sayısı ve tamamlanma durumuyla gösterir. Aktif oturum indirme bağlantısı kayıt kapanana kadar sunulmaz. **Eksik oturum**, dosyanın tamamlanmış bir `end` satırı taşımadığını belirtir; bunu tamamlanmış gösteri kaydı olarak değerlendirmeyin.

Görselleştiricinin **Kütüphane** panelinde:

- Paketler açılabilir ve silinebilir.
- Paketlenmemiş ham oturumlar yeniden paketlenebilir veya silinebilir.
- Silme iki tıklama gerektirir; ilk tıklamadan sonraki dört saniye içinde ikinci tıklama işlemi uygular.
- Aktif veya paketlenmekte olan oturum sunucu tarafından silmeye ve tekrar paketlemeye karşı korunur (`409`).

**Kayıt hatası** ile **paketleme hatası** ayrıdır. Paketleme başarısız olsa da başarıyla kapanan ham JSONL diskte kalır. Kütüphaneden yeniden paketleyebilir veya şu komutu kullanabilirsiniz:

```sh
npm run viz:pack -- sessions/<oturum>.jsonl viz/public/packs/<paket>
```

Paketleyici `manifest.json`, ikili veri dosyaları ve `index.json` üretir. Yeni paketlerde `gestures.bin`, olaylarla aynı sırada X/Y, zaman ve dokunuş kimliğini korur; eksik alanlar eksik kalır. Eski paketlerdeki 16-bit U/V okunabilir, ancak kaybolmuş dokunuş / eksik-alan bilgisi paketten geri çıkarılamaz. Ham JSONL bu alanları içeriyorsa yukarıdaki komutla yeniden paketlemek ayrıntılı hareket yan dosyasını üretir; ham kaydı değiştirmez. Dizin düzeyindeki index atomik yazılır. Görselleştiricide paket görünmüyorsa `sessions/<oturum>.jsonl → viz/public/packs/<paket>/manifest.json → viz/public/packs/index.json` zincirini kontrol edin. Yeni paketler için Vite'ı yeniden başlatmak gerekmez.

## 6. Veri ve işletim sınırları

- `.env`, `sessions/`, `captures/*.raw`, `viz/public/packs/` ve `dist-viz/` Git dışında tutulur. Dosya paylaşımı veya dağıtımı öncesi hedef içeriğini kontrol edin.
- Ham kayıt, görsel paketten bağımsızdır. Ham JSONL yedeğini performans sonrası ayrıca alın.
- Panel `127.0.0.1`'e bağlıdır; venue LAN'ından erişilmez. Dış ağa yayınlamak bu yerel çalıştırma akışının parçası değildir.
- Canlı görselleştirmede geç katılımcılar için sınırlı yedek şerit vardır: snapshot roster için 64, türetilmiş roster için 256. Kapasite dolduğunda `dropped` sayacı artar.
- Roster geç geldiğinde tutulan canlı replay buffer 400.000 olayla sınırlıdır. Görselleştirici arabelleği, ham kayıt deposundan ayrıdır.
- Duran bir canlı izleyicinin çıkış tamponu 4 MiB sınırını aşarsa o istemci düşürülür; yeniden bağlanabilir.
- Testler fixture ve yerel sunucularla çalışır. Test/build başarısı gerçek upstream bağlantısı, venue yükü veya hedef GPU'da gösteri kabulü anlamına gelmez.

Geliştirme doğrulaması: `npm run check`. Uygulama kaynak haritası ve diğer komutlar için [README](../README.md).

Girişin yaratıcı bağlamı: Yıldız Holding'in [10.04.2025 tarihli Senenin Yıldızları duyurusu](https://www.medyamerkezi.yildizholding.com.tr/tr/basin-bultenleri/senenin-yildizlari-17nci-kez-odullendirildi). Kapak, mevcut deneyime yıl veya tören sıra numarası atamaz.
