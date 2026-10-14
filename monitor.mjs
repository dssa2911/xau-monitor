// DSSA strategy: XAU/USD monitor for GitHub Actions (runs every 15 minutes in market hours, no laptop needed). Data: setra.id.
// Task 1, every run while the market is open: are the M15, H1 and H4 candles above or below MA 20 (SMA of close)?
//   The trend is confirmed only when all three agree; every signal says whether it is.
// Task 2, H1 support/resistance:
//   - after every H1 close, rebuild S/R from H1 swing highs/lows and send the list when it changed;
//   - send a BUY/SELL breakout signal only when an M5 candle CLOSES beyond an H1 resistance/support
//     (all M5 candles closed since the previous run are checked);
//   - send a BUY/SELL retest signal when a closed H1 candle reaches the zone of the NEAREST support/resistance
//     and closes back on the holding side of it (support -> BUY, resistance -> SELL).
// Task 3, any time: BUY/SELL when an M5 candle closes with a body of 60+ pips that is at least 80% of the candle.
// Task 4: EMA 20 crossing EMA 50 on a closed M5 candle -> short BUY/SELL message (cross up = BUY, down = SELL).
// Task 5, "Sentuh EMA 20 M5": a closed M5 candle touches/crosses EMA 20 (every touch, no filter) -> bullish BUY, bearish SELL.
// Every BUY/SELL signal gets an entry range (1-5 pips) and a HOLD check: against the MA20 trend,
//   sideways or whipsawing EMAs, little room to the next S/R, price stretched from EMA 20, quiet hours,
//   Friday close, week open, high-impact USD news. Any hit marks the signal HOLD with the reasons.
// State (what was already reported) lives in state.json, kept between runs by actions/cache.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.   Local test: node monitor.mjs --dry
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { atrSeries } from './sd_zones.mjs';

const DRY = process.argv.includes('--dry');
// Tolerate common copy-paste mistakes in the secrets: surrounding quotes/spaces and a leading "bot".
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
const TELEGRAM_BOT_TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN).replace(/^bot/i, '');
const TELEGRAM_CHAT_ID = clean(process.env.TELEGRAM_CHAT_ID);
if (!DRY && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
  console.error('Set TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID');
  process.exit(1);
}

const SYMBOL = 'XAU/USD', LABEL = 'XAUUSD', STRATEGY = 'DSSA', MA_LEN = 20, STATE = 'state.json';
const PIVOT = 3;        // swing high/low = highest/lowest of 3 candles on each side
const MERGE_ATR = 0.3;  // levels closer than 0.3 ATR(H1) are merged into one
const MAX_LEVELS = 3;   // levels listed per side
const ZONE_ATR = 0.2;   // retest zone = level +/- 0.2 ATR(H1)
const BIG_BODY = 6.0;   // big M5 candle: body >= 60 pips (1 pip = 0.10)
const BIG_RATIO = 0.8;  // ... and body >= 80% of high-low
const EMA_FAST = 20, EMA_SLOW = 50;   // M5 EMA cross
const hhmm = (t) => new Date(t * 1000 + 8 * 3600e3).toISOString().slice(11, 16);
const ddhh = (t) => { const s = new Date(t * 1000 + 8 * 3600e3).toISOString(); return `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`; };
const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' (UTC+8)';
const fmt = (p) => p.toFixed(2);
// Entry range for a signal: 1-5 pips (0.10-0.50) below the entry for BUY, above it for SELL.
const PIP = 0.10, RANGE_MIN = 1, RANGE_MAX = 5;
const entryRange = (buy, p) => buy
  ? `Range BUY: ${fmt(p - RANGE_MAX * PIP)} – ${fmt(p - RANGE_MIN * PIP)} (${RANGE_MIN}-${RANGE_MAX} pips di bawah entry)`
  : `Range SELL: ${fmt(p + RANGE_MIN * PIP)} – ${fmt(p + RANGE_MAX * PIP)} (${RANGE_MIN}-${RANGE_MAX} pips di atas entry)`;

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state.done ??= [];     // level ids already signalled as broken
state.retests ??= [];  // "level id@H1 time" already signalled as retest
state.bigs ??= [];     // M5 candle times already signalled as big candles
state.crosses ??= [];  // "M5:time" EMA crosses already signalled
state.touches ??= [];  // "T5:time" M5 candles already signalled as touching EMA 20
const save = () => writeFileSync(STATE, JSON.stringify({ ...state, done: state.done.slice(-300), retests: state.retests.slice(-300), bigs: state.bigs.slice(-300), crosses: state.crosses.slice(-300), touches: state.touches.slice(-300) }));

// The TradingView alert ("DSSA Signal Telegram", signals within seconds of the close) sends the same messages
// until TV_ALERT_UNTIL (its expiry, ISO time). Until then this bot stays quiet so nothing arrives twice,
// and it takes over again by itself once the alert has expired.
const TV_UNTIL = Date.parse(clean(process.env.TV_ALERT_UNTIL)) || 0;
const MUTED = Date.now() < TV_UNTIL;

async function send(text, always = false) {
  if (MUTED && !always) { console.log('muted (TradingView alert active):', text.split('\n')[0]); return true; }
  if (DRY) { console.log('[DRY]\n' + text + '\n'); return true; }
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
  const j = await r.json();
  console.log(`telegram ${j.ok ? 'sent' : 'FAILED ' + JSON.stringify(j).slice(0, 200)}`);
  if (!j.ok) {
    process.exitCode = 1;   // mark the GitHub run red
    if (j.error_code === 404 || j.error_code === 401) console.log(`Token ditolak Telegram. Panjang token ${TELEGRAM_BOT_TOKEN.length} karakter, format ${/^\d+:[\w-]{30,}$/.test(TELEGRAM_BOT_TOKEN) ? 'benar' : 'SALAH (harus angka:huruf, mis. 123456:ABC...)'}.`);
  }
  return j.ok;
}

// Oldest first, times in unix seconds (UTC). `closed` drops the candle that is still forming.
async function series(tf, seconds, closed = true) {
  const r = await fetch(`https://setra.id/api/md/candles?symbol=${encodeURIComponent(SYMBOL)}&tf=${tf}&limit=500`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.data)) throw new Error(`setra ${tf}: ${j.error || r.status}`);
  const bars = j.data.map(v => ({ time: v.t / 1000, open: v.o, high: v.h, low: v.l, close: v.c })).sort((x, y) => x.time - y.time);
  return closed ? closedOnly(bars, seconds) : bars;
}

// The bot polls right after each close: a candle only counts as closed once setra shows the next one
// (its last ticks are in), or 15 s after its close time when no next candle comes (quiet market).
function closedOnly(bars, seconds) {
  const now = Date.now() / 1000;
  return bars.filter((x, i) => x.time + seconds <= now && (i < bars.length - 1 || now - x.time - seconds > 15));
}

// H4 built from H1 like OANDA on TradingView: H4 opens at 17/21/01/05/09/13 New York time.
const nyHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
const h4Start = (t) => t - ((Number(nyHour.format(new Date(t * 1000))) + 7) % 4) * 3600;
function toH4(h1) {
  const out = [];
  for (const b of h1) {
    const s = h4Start(b.time), cur = out[out.length - 1];
    if (cur && cur.time === s) { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; }
    else out.push({ ...b, time: s });
  }
  return out;
}

function ema(bars, n) {
  const k = 2 / (n + 1);
  let e = bars[0].close;
  return bars.map(b => (e += (b.close - e) * k));
}

const sma = (bars, end) => bars.slice(end - MA_LEN + 1, end + 1).reduce((s, b) => s + b.close, 0) / MA_LEN;
function maStatus(bars, i) {
  const b = bars[i], ma = sma(bars, i), above = b.close > ma, prevAbove = bars[i - 1].close > sma(bars, i - 1);
  const pos = b.low > ma ? 'penuh di atas' : b.high < ma ? 'penuh di bawah' : `menyentuh MA, close di ${above ? 'atas' : 'bawah'}`;
  const cross = above !== prevAbove ? `\n🔄 Baru cross ke ${above ? 'ATAS' : 'BAWAH'} MA 20` : '';
  return { above, text: `${above ? '🟢 DI ATAS' : '🔴 DI BAWAH'} MA 20 (${pos})\nClose ${fmt(b.close)} · MA20 ${fmt(ma)} · selisih ${b.close - ma >= 0 ? '+' : ''}${fmt(b.close - ma)}${cross}` };
}

// H1 support/resistance from confirmed swing highs/lows that no H1 candle has closed through since.
// Resistance = swing high above the last close, support = swing low below it. Near levels are merged.
function levels(bars) {
  const atr = atrSeries(bars), a = atr[atr.length - 1], last = bars[bars.length - 1].close;
  const found = [];
  for (let i = PIVOT; i < bars.length - PIVOT; i++) {
    const win = bars.slice(i - PIVOT, i + PIVOT + 1);
    const after = bars.slice(i + 1);
    if (bars[i].high === Math.max(...win.map(b => b.high)) && bars[i].high > last && !after.some(b => b.close > bars[i].high))
      found.push({ type: 'resistance', price: bars[i].high, time: bars[i].time });
    if (bars[i].low === Math.min(...win.map(b => b.low)) && bars[i].low < last && !after.some(b => b.close < bars[i].low))
      found.push({ type: 'support', price: bars[i].low, time: bars[i].time });
  }
  const pick = (type, dir) => {
    const out = [];
    for (const l of found.filter(l => l.type === type).sort((x, y) => dir * (x.price - y.price))) {
      if (out.some(o => Math.abs(o.price - l.price) < MERGE_ATR * a)) continue;
      out.push(l);
      if (out.length === MAX_LEVELS) break;
    }
    return out;
  };
  return { resistance: pick('resistance', 1), support: pick('support', -1) };   // nearest first
}
const levelId = (l) => `${l.type}:${l.time}`;

// ---- data ----
const h1All = await series('1h', 3600, false);
const h1 = closedOnly(h1All, 3600);
const h4 = toH4(h1All);   // keeps the forming H4 candle
const m5 = await series('5m', 300);
const m15 = await series('15m', 900);
const lastH1 = h1[h1.length - 1], lastM5 = m5[m5.length - 1];

// Market closed (weekend / daily break): nothing new since the last run, send nothing.
if (state.lastM5 && lastM5.time <= state.lastM5) { console.log('no new candle, skip'); save(); process.exit(0); }

const s1 = maStatus(h1, h1.length - 1);
const s4 = maStatus(h4, h4.length - 1);
const s15 = maStatus(m15, m15.length - 1);
// Trend is confirmed only when M15, H1 and H4 are all on the same side of MA 20.
const ups = [s15, s1, s4].filter(s => s.above).length;
const trendNote = (buy) => (buy ? ups === 3 : ups === 0) ? '✅ terkonfirmasi (M15, H1 & H4 searah)'
  : (buy ? ups === 0 : ups === 3) ? '⚠️ melawan tren M15, H1 & H4' : '⚖️ belum terkonfirmasi (M15/H1/H4 campuran)';
const lv = levels(h1);
let ok = true;

const emaPair = (bars) => ({ f: ema(bars, EMA_FAST), s: ema(bars, EMA_SLOW) });

// ---- HOLD advice: every BUY/SELL signal is checked for reasons not to enter yet ----
// The signal is still sent; when a reason applies it is marked HOLD with the analysis behind it.
// The EMA checks (sideways, whipsaw, stretch) use the timeframe of the signal: M15 by default, M5 for the M5 cross.
const HOLD_EMA_GAP = 0.1;   // sideways: EMA 20/50 closer than 0.1 ATR
const HOLD_WHIPSAW = 8;     // whipsaw: 2+ EMA 20/50 crosses within the last 8 candles
const HOLD_ROOM = 0.5;      // opposite H1 S/R closer than 0.5 ATR H1 to the entry
const HOLD_STRETCH = 1.5;   // entry more than 1.5 ATR away from EMA 20
const HOLD_NEWS_MIN = 30;   // high-impact USD news within 30 minutes before/after
const atrH1 = atrSeries(h1).at(-1);
const pips = (d) => `${(Math.abs(d) * 10).toFixed(0)} pips`;
function emaCtx(name, bars, minutes) {
  const e = emaPair(bars), n = bars.length - 1, side = (i) => Math.sign(e.f[i] - e.s[i]);
  let crosses = 0;
  for (let i = n - HOLD_WHIPSAW + 1; i <= n; i++) if (i > 0 && side(i) !== side(i - 1)) crosses++;
  return { name, bars, minutes, e, n, side, crosses, atr: atrSeries(bars)[n] };
}
const c15 = emaCtx('M15', m15, 15), c5 = emaCtx('M5', m5, 5);

// Week open = first H1 candle after a gap of more than a day.
let weekOpen = null;
for (let i = h1All.length - 1; i > 0; i--) if (h1All[i].time - h1All[i - 1].time > 24 * 3600) { weekOpen = { time: h1All[i].time, gap: h1All[i].open - h1All[i - 1].close }; break; }
let news = [];
try {
  const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const j = await r.json();
  if (Array.isArray(j)) news = j.filter(n => n.country === 'USD' && n.impact === 'High').map(n => ({ title: n.title, time: Date.parse(n.date) / 1000 }));
} catch (e) { console.log('news calendar unavailable:', e.message); }

// Each reason has a full analysis (`text`) and a few words (`short`) for the simple M5 signal.
function holdReasons(buy, entry, c = c15) {
  const why = [], now = Date.now() / 1000, dir = buy ? 'BUY' : 'SELL', add = (short, text) => why.push({ short, text });
  if (buy ? ups === 0 : ups === 3)
    add('melawan tren MA20', `Melawan tren MA20: M15, H1 & H4 semua ${buy ? 'di bawah' : 'di atas'} SMA20, jadi ${dir} melawan arus utama.`);
  const gap = Math.abs(c.e.f[c.n] - c.e.s[c.n]);
  if (gap < HOLD_EMA_GAP * c.atr)
    add('EMA rapat (sideways)', `Market sideways: EMA 20 & EMA 50 ${c.name} hanya berjarak ${pips(gap)} (batas ${pips(HOLD_EMA_GAP * c.atr)} = ${HOLD_EMA_GAP} ATR ${c.name}), belum ada trend yang jelas.`);
  if (c.crosses >= 2)
    add(`whipsaw ${c.crosses}× cross`, `Whipsaw: EMA 20/50 ${c.name} sudah crossing ${c.crosses}× dalam ${HOLD_WHIPSAW} candle terakhir (${HOLD_WHIPSAW * c.minutes} menit), arah sering berbalik.`);
  const opp = (buy ? lv.resistance : lv.support).find(l => !state.done.includes(levelId(l)) && (buy ? l.price > entry : l.price < entry));
  if (opp && Math.abs(opp.price - entry) < HOLD_ROOM * atrH1)
    add(`${buy ? 'resistance' : 'support'} ${fmt(opp.price)} dekat (${pips(opp.price - entry)})`,
      `Ruang sempit: ${buy ? 'resistance' : 'support'} H1 ${fmt(opp.price)} hanya ${pips(opp.price - entry)} ${buy ? 'di atas' : 'di bawah'} entry (batas ${pips(HOLD_ROOM * atrH1)} = ${HOLD_ROOM} ATR H1), harga bisa mental di situ.`);
  const stretch = buy ? entry - c.e.f[c.n] : c.e.f[c.n] - entry;
  if (stretch > HOLD_STRETCH * c.atr)
    add(`harga lari ${pips(stretch)} dari EMA20`, `Harga sudah lari: entry ${pips(stretch)} ${buy ? 'di atas' : 'di bawah'} EMA 20 ${c.name} (batas ${pips(HOLD_STRETCH * c.atr)} = ${HOLD_STRETCH} ATR ${c.name}), rawan pullback ke EMA dulu.`);
  const wib = new Date((now + 7 * 3600) * 1000), wibH = wib.getUTCHours(), utc = new Date(now * 1000);
  if (wibH >= 5 && wibH < 8)
    add('jam sepi', 'Jam sepi: 05:00–08:00 WIB (akhir sesi New York, rollover & awal Asia), likuiditas tipis dan spread lebar.');
  if (utc.getUTCDay() === 5 && utc.getUTCHours() >= 19)
    add('jelang close Jumat', 'Jelang close Jumat: posisi bisa terbawa gap weekend, banyak trader tutup posisi sehingga gerak harga tidak wajar.');
  if (weekOpen && now - weekOpen.time < 3 * 3600)
    add('awal minggu (gap)', `Awal minggu: market baru buka ${ddhh(weekOpen.time)} (gap weekend ${pips(weekOpen.gap)}), harga sering menutup gap dulu sebelum punya arah.`);
  for (const n of news.filter(n => Math.abs(n.time - now) <= HOLD_NEWS_MIN * 60))
    add(`berita USD ${n.title} ${hhmm(n.time)}`, `Berita besar USD: "${n.title}" jam ${ddhh(n.time)} (dalam ±${HOLD_NEWS_MIN} menit), volatilitas & spread bisa melonjak.`);
  return why;
}

// The 🎯 block of every signal: direction, entry, entry range, MA20 trend and the HOLD advice with its reasons.
function signalBlock(buy, entry, src) {
  const why = holdReasons(buy, entry).map(w => w.text), dir = buy ? 'BUY' : 'SELL';
  return `🎯 SINYAL ${STRATEGY}: ${buy ? 'BUY 🟢' : 'SELL 🔴'}${why.length ? ' → ⏸️ HOLD' : ''}\nEntry: ${fmt(entry)} (${src})\n${entryRange(buy, entry)}\nTren MA20: ${trendNote(buy)}\n` +
    (why.length ? `\n⏸️ SARAN: HOLD dulu, jangan entry ${dir} sekarang.\nAlasan analisa:\n${why.map(w => '• ' + w).join('\n')}\n`
      : `✅ Cek HOLD: tidak ada alasan menunda, setup ${dir} bersih.\n`);
}

// ---- Task 2b: breakout signals, only on an M5 close beyond the level ----
const newM5 = state.lastM5 ? m5.filter(b => b.time > state.lastM5) : m5.slice(-6);
for (const side of ['resistance', 'support']) {
  // nearest level first, so one candle breaking several levels gives one signal for the furthest level broken
  const broken = [];
  for (const l of lv[side]) {
    if (state.done.includes(levelId(l))) continue;
    const conf = newM5.find(b => side === 'resistance' ? b.close > l.price : b.close < l.price);
    if (conf) broken.push({ l, conf });
  }
  if (!broken.length) continue;
  const { l, conf } = broken[broken.length - 1];
  const buy = side === 'resistance';
  const others = broken.slice(0, -1).map(x => fmt(x.l.price)).join(', ');
  const sent = await send(`${buy ? '🔺 BREAKOUT RESISTANCE' : '🔻 BREAKOUT SUPPORT'} H1 ${fmt(l.price)}\n${STRATEGY} · ${LABEL} · ${stamp()}\n\n` +
    `✅ Konfirmasi M5: candle M5 ${hhmm(conf.time)} close ${fmt(conf.close)} ${buy ? 'di atas' : 'di bawah'} ${fmt(l.price)}.` +
    (others ? `\nIkut tertembus: ${others}.` : '') +
    `\n\n${signalBlock(buy, conf.close, `close M5 ${hhmm(conf.time)}`)}` +
    `Harga sekarang: ${fmt(lastM5.close)}\n\nBukan saran investasi.`);
  if (sent) broken.forEach(x => state.done.push(levelId(x.l)));
  ok = sent && ok;
}

// ---- Task 2c: retest of the nearest H1 support/resistance by the last closed H1 candle ----
// Support retest: low reaches support + zone and the close stays above support -> BUY.
// Resistance retest: high reaches resistance - zone and the close stays below resistance -> SELL.
// The previous H1 candle must still be outside the zone, so a candle sitting on the level doesn't repeat it.
if (lastH1.time !== state.lastH1 && h1.length > 1) {
  const atr = atrSeries(h1), zone = ZONE_ATR * atr[atr.length - 1], prev = h1[h1.length - 2];
  const checks = [
    { l: lv.support[0], buy: true, hit: (l) => lastH1.low <= l.price + zone && lastH1.close > l.price && prev.low > l.price + zone },
    { l: lv.resistance[0], buy: false, hit: (l) => lastH1.high >= l.price - zone && lastH1.close < l.price && prev.high < l.price - zone },
  ];
  for (const { l, buy, hit } of checks) {
    if (!l || !hit(l)) continue;
    const id = `${levelId(l)}@${lastH1.time}`;
    if (state.retests.includes(id)) continue;
    const sent = await send(`${buy ? '🟢 RETEST SUPPORT' : '🔴 RETEST RESISTANCE'} H1 ${fmt(l.price)}\n${STRATEGY} · ${LABEL} · ${stamp()}\n\n` +
      `✅ Candle H1 ${hhmm(lastH1.time)} masuk zona ${fmt(l.price - zone)}–${fmt(l.price + zone)} ` +
      `(${buy ? `low ${fmt(lastH1.low)}` : `high ${fmt(lastH1.high)}`}) lalu close ${fmt(lastH1.close)} ` +
      `${buy ? 'di atas support' : 'di bawah resistance'} (swing ${ddhh(l.time)}).` +
      `\n\n${signalBlock(buy, lastH1.close, `close H1 ${hhmm(lastH1.time)}`)}` +
      `Harga sekarang: ${fmt(lastM5.close)}\n\nBukan saran investasi.`);
    if (sent) state.retests.push(id);
    ok = sent && ok;
  }
}

// ---- Task 3: big M5 candle, any time of day ----
// Body (|close - open|) of at least 60 pips ($6.00) and at least 80% of the candle's high-low range.
// Bullish candle -> BUY, bearish candle -> SELL, entry at its close.
for (const b of newM5) {
  const body = Math.abs(b.close - b.open), range = b.high - b.low;
  if (body < BIG_BODY || body < BIG_RATIO * range || state.bigs.includes(b.time)) continue;
  const buy = b.close > b.open;
  const sent = await send(`${buy ? '🚀 CANDLE BESAR BULLISH' : '💥 CANDLE BESAR BEARISH'} M5 ${hhmm(b.time)}\n${STRATEGY} · ${LABEL} · ${stamp()}\n\n` +
    `Body ${(body * 10).toFixed(0)} pips (${(100 * body / range).toFixed(0)}% dari candle ${(range * 10).toFixed(0)} pips)\n` +
    `Open ${fmt(b.open)} · High ${fmt(b.high)} · Low ${fmt(b.low)} · Close ${fmt(b.close)}` +
    `\n\n${signalBlock(buy, b.close, `close M5 ${hhmm(b.time)}`)}` +
    `Harga sekarang: ${fmt(lastM5.close)}\n\nBukan saran investasi.`);
  if (sent) state.bigs.push(b.time);
  ok = sent && ok;
}

// ---- Task 4: EMA 20 x EMA 50 cross on closed M5 candles, as short as possible ----
// Cross up -> BUY, cross down -> SELL, entry at the M5 close, with the 1-5 pip range and the HOLD check in a few words.
const simpleSignal = (buy, b, what = `EMA 20 cross ${buy ? 'ke atas' : 'ke bawah'} EMA 50`) => {
  const why = holdReasons(buy, b.close, c5).map(w => w.short);
  const lo = buy ? b.close - RANGE_MAX * PIP : b.close + RANGE_MIN * PIP, hi = buy ? b.close - RANGE_MIN * PIP : b.close + RANGE_MAX * PIP;
  return `${buy ? '🟢 BUY' : '🔴 SELL'} ${LABEL} · M5 ${hhmm(b.time)}\n` +
    `${what}\n` +
    `Entry ${fmt(b.close)} · Range ${fmt(lo)}–${fmt(hi)}\n` +
    (why.length ? `⏸️ HOLD: ${why.join(', ')}` : '✅ Boleh entry') + `\n${STRATEGY}`;
};
if (m5.length > EMA_SLOW + 2) {
  const { e } = c5;
  // M5 candles closed since the previous run (first run: only the last one)
  const from = state.lastCrossM5 ? m5.findIndex(b => b.time > state.lastCrossM5) : m5.length - 1;
  let sentAll = true;
  for (let i = Math.max(from, 1); from >= 0 && i < m5.length; i++) {
    const up = e.f[i - 1] <= e.s[i - 1] && e.f[i] > e.s[i];
    const down = e.f[i - 1] >= e.s[i - 1] && e.f[i] < e.s[i];
    const id = `M5:${m5[i].time}`;
    if ((!up && !down) || state.crosses.includes(id)) continue;
    const sent = await send(simpleSignal(up, m5[i]));
    if (sent) state.crosses.push(id); else sentAll = false;
    ok = sent && ok;
  }
  if (sentAll) state.lastCrossM5 = m5[m5.length - 1].time;
}

// ---- Task 5: "Sentuh EMA 20 M5" - a closed M5 candle touches or crosses EMA 20 ----
// Bullish candle -> BUY, bearish candle -> SELL, entry at its close. Every touching candle is sent (no filter,
// as the user asked), so a ranging market gives many signals.
if (m5.length > EMA_SLOW) {
  const ef = c5.e.f, touches = (i) => m5[i].low <= ef[i] && m5[i].high >= ef[i];
  const from = state.lastTouchM5 ? m5.findIndex(b => b.time > state.lastTouchM5) : m5.length - 1;
  let sentAll = true;
  for (let i = Math.max(from, 0); from >= 0 && i < m5.length; i++) {
    const b = m5[i], id = `T5:${b.time}`;
    if (!touches(i) || b.close === b.open || state.touches.includes(id)) continue;
    const buy = b.close > b.open;
    const through = (b.open - ef[i]) * (b.close - ef[i]) < 0;   // open and close on opposite sides of EMA 20
    const sent = await send(`📍 Sentuh EMA 20 M5\n` + simpleSignal(buy, b,
      `Candle ${buy ? 'naik' : 'turun'} ${through ? 'menembus' : 'menyentuh'} EMA 20 (${fmt(ef[i])})`));
    if (sent) state.touches.push(id); else sentAll = false;
    ok = sent && ok;
  }
  if (sentAll) state.lastTouchM5 = m5[m5.length - 1].time;
}

// ---- Task 1: M15 / H1 / H4 vs MA 20 ----
const h4Bar = h4[h4.length - 1], lastM15 = m15[m15.length - 1];
const both = ups === 3 || ups === 0 ? `✅ Tren terkonfirmasi: M15, H1 & H4 ${ups ? 'DI ATAS MA 20 (bullish)' : 'DI BAWAH MA 20 (bearish)'}` : '⚖️ Tren belum terkonfirmasi: M15, H1 & H4 tidak searah';
// EMA 20 vs EMA 50 on M5: current side and the last cross (the cross itself is signalled by task 4).
let lastCross = c5.n;
while (lastCross > 0 && c5.side(lastCross - 1) === c5.side(lastCross)) lastCross--;
const emaUp = c5.side(c5.n) > 0;
const emaText = `EMA 20 ${fmt(c5.e.f[c5.n])} ${emaUp ? '> ' : '< '}EMA 50 ${fmt(c5.e.s[c5.n])} → ${emaUp ? '🟢 BULLISH' : '🔴 BEARISH'}\n` +
  `Cross terakhir: ${emaUp ? 'ke ATAS' : 'ke BAWAH'} di candle ${ddhh(m5[lastCross].time)} (${c5.n - lastCross} candle lalu)`;
// The workflow checks every M5 close; the MA 20 status report still goes out once per 30-minute slot.
const slot = Math.floor(Date.now() / 1800e3);
if (slot !== state.lastReport) {
  const sent = await send(`📊 ${STRATEGY} · ${LABEL} · MA 20 · ${stamp()}\n\n` +
    `M15 (candle ${hhmm(lastM15.time)} close):\n${s15.text}\n\n` +
    `H1 (candle ${hhmm(lastH1.time)} close):\n${s1.text}\n\n` +
    `H4 (candle ${hhmm(h4Bar.time)} berjalan, close ${hhmm(h4Bar.time + 4 * 3600)}):\n${s4.text}\n\n${both}\n\n` +
    `📈 EMA 20 × EMA 50 · M5 (candle ${hhmm(lastM5.time)} close):\n${emaText}`);
  if (sent) state.lastReport = slot;
  ok = sent && ok;
}

// ---- Task 2a: S/R list after a new H1 close, only when it changed ----
// Levels already broken on M5 are left out until the H1 close drops them for good.
const res = lv.resistance.filter(l => !state.done.includes(levelId(l)));
const sup = lv.support.filter(l => !state.done.includes(levelId(l)));
const key = JSON.stringify([res.map(levelId), sup.map(levelId)]);
if (lastH1.time !== state.lastH1 && key !== state.levelsKey) {
  const list = (arr) => arr.length ? arr.map(l => `${fmt(l.price)} (swing ${ddhh(l.time)})`).join('\n') : '- belum ada';
  ok = await send(`📐 Support/Resistance H1 · update candle ${hhmm(lastH1.time)}\n${STRATEGY} · ${LABEL} · ${stamp()}\n\n` +
    `🔴 Resistance:\n${list([...res].reverse())}\n💰 Harga: ${fmt(lastM5.close)}\n🟢 Support:\n${list(sup)}\n\n` +
    `Sinyal breakout: candle M5 close menembus level. Sinyal retest: candle H1 masuk zona S/R terdekat lalu close bertahan.`) && ok;
  if (ok) state.levelsKey = key;
}

// Reminder once a day during the last 3 days before the TradingView alert expires.
const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
if (MUTED && TV_UNTIL - Date.now() < 3 * 86400e3 && state.tvReminder !== day) {
  const sent = await send(`⏰ Alert TradingView "DSSA Signal Telegram" habis ${new Date(TV_UNTIL + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} (UTC+8).\n` +
    `Perpanjang/buat ulang alert-nya. Setelah habis, bot GitHub otomatis mengirim sinyal lagi (lebih lambat, ±6 detik setelah close).`, true);
  if (sent) state.tvReminder = day;
}

// Only advance when everything went out, so a failed send is retried on the next run.
if (ok) { state.lastH1 = lastH1.time; state.lastM5 = lastM5.time; }
save();
