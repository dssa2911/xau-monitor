# DSSA Signal — XAU/USD (GitHub Actions)

Bot XAU/USD yang berjalan di server GitHub setiap 15 menit selama market buka, gratis, tanpa laptop dan tanpa VPS.
Data harga dari setra.id (XAU/USD), tanpa API key. Pesan dikirim ke Telegram.

Tugas:
1. **Setiap 15 menit selama market buka** — candle H1 dan H4 berada di atas atau di bawah MA 20.
2. **Support/resistance H1** — setiap candle H1 close, S/R dihitung ulang dari swing high/low H1 (dikirim
   kalau berubah). Sinyal **BUY** saat resistance H1 ditembus, **SELL** saat support H1 ditembus —
   hanya jika ada candle M5 yang **close** menembus level tersebut. Entry = close candle M5 itu.
   Semua candle M5 sejak run sebelumnya ikut dicek, jadi sinyal bisa terlambat sampai ±15 menit.
3. **Retest S/R H1 terdekat** — setiap candle H1 close: kalau candle masuk zona support terdekat
   (support ± 0,2 ATR H1) lalu close tetap di atas support → **BUY**; kalau masuk zona resistance terdekat
   lalu close tetap di bawah resistance → **SELL**. Entry = close candle H1 itu. Candle H1 sebelumnya harus
   masih di luar zona, supaya harga yang menempel di level tidak memicu sinyal berulang.

## Setup (sekali saja)

1. **Repo GitHub** — buat akun di https://github.com, lalu *New repository* → nama bebas (mis. `xau-monitor`) → **Private** → Create.
2. **Upload file** — di repo baru: *Add file → Upload files*, upload isi folder ini:
   `monitor.mjs`, `sd_zones.mjs`, `README.md`, dan folder `.github/workflows/xau-monitor.yml`.
   Folder `.github` tersembunyi di Windows Explorer; kalau tidak bisa di-upload, buat file lewat
   *Add file → Create new file* dengan nama `.github/workflows/xau-monitor.yml` lalu tempel isinya.
3. **Secrets** — *Settings → Secrets and variables → Actions → New repository secret*, buat dua:
   - `TELEGRAM_BOT_TOKEN` = token bot dari @BotFather
   - `TELEGRAM_CHAT_ID` = chat ID Telegram Anda
4. **Tes** — tab *Actions* → *DSSA Signal* → *Run workflow*. Dalam ±1 menit laporan masuk ke Telegram.

Setelah itu bot jalan sendiri setiap 15 menit selama market buka.

## Catatan

- Jadwal GitHub bisa telat beberapa menit saat server sibuk.
- Repo private gratis 2.000 menit/bulan; jadwal 15 menit memakai ±2.050 menit/bulan (sedikit di atas kuota). Repo public tidak dibatasi.
- Kalau bot berhenti mengirim, buka tab *Actions*: cek apakah workflow dinonaktifkan atau ada run yang gagal (merah).
- Saat pasar tutup (akhir pekan), tidak ada pesan.
- Harga setra.id bisa beda sedikit dari OANDA (TradingView) atau Exness (MT5).
- Data diambil dari endpoint chart setra.id yang tidak resmi; kalau setra mengubahnya, bot perlu disesuaikan.
