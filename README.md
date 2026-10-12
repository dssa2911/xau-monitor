# XAU Telegram Monitor (GitHub Actions)

Bot XAU/USD yang berjalan di server GitHub setiap 30 menit, gratis, tanpa laptop dan tanpa VPS.
Data harga dari setra.id (XAU/USD), tanpa API key. Pesan dikirim ke Telegram.

Setiap 30 menit:
- Candle H1 dan H4 terhadap MA 20
- Zona supply/demand H1 dan order block H1
- Breakout order block H1 + konfirmasi candle M5 (dicek untuk semua candle M5 sejak run sebelumnya)
- Sinyal entry BUY/SELL setelah breakout terkonfirmasi M5 (entry di close candle M5, tanpa SL/TP)

## Setup (sekali saja)

1. **Repo GitHub** — buat akun di https://github.com, lalu *New repository* → nama bebas (mis. `xau-monitor`) → **Private** → Create.
2. **Upload file** — di repo baru: *Add file → Upload files*, upload isi folder ini:
   `monitor.mjs`, `sd_zones.mjs`, `README.md`, dan folder `.github/workflows/xau-monitor.yml`.
   Folder `.github` tersembunyi di Windows Explorer; kalau tidak bisa di-upload, buat file lewat
   *Add file → Create new file* dengan nama `.github/workflows/xau-monitor.yml` lalu tempel isinya.
3. **Secrets** — *Settings → Secrets and variables → Actions → New repository secret*, buat dua:
   - `TELEGRAM_BOT_TOKEN` = token bot dari @BotFather
   - `TELEGRAM_CHAT_ID` = chat ID Telegram Anda
4. **Tes** — tab *Actions* → *XAU Telegram Monitor* → *Run workflow*. Dalam ±1 menit laporan masuk ke Telegram.

Setelah itu bot jalan sendiri setiap 30 menit.

## Catatan

- Jadwal GitHub bisa telat beberapa menit saat server sibuk.
- Repo private gratis 2.000 menit/bulan; bot ini memakai ±1.440 menit/bulan.
- Kalau bot berhenti mengirim, buka tab *Actions*: cek apakah workflow dinonaktifkan atau ada run yang gagal (merah).
- Saat pasar tutup (akhir pekan), tidak ada pesan.
- Harga setra.id bisa beda sedikit dari OANDA (TradingView) atau Exness (MT5).
- Data diambil dari endpoint chart setra.id yang tidak resmi; kalau setra mengubahnya, bot perlu disesuaikan.
