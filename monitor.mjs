// XAU/USD monitor for GitHub Actions (runs every 30 minutes, no laptop needed). Data: setra.id candles.
// Each run sends:
//   - H1 and H4 candle vs MA 20, H1 supply/demand zones and H1 order blocks;
//   - every H1 order block an H1 candle closed through since the last run, with its M5 confirmation;
//   - for every M5 candle closed since the last run: confirmed breakout when it closed beyond an intact
//     H1 order block, warning when it only wicked through.
// State (what was already reported) lives in state.json, kept between runs by actions/cache.
//
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.   Local test: node monitor.mjs --dry
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { atrSeries, detectZones, detectOrderBlocks, nearest } from './sd_zones.mjs';

const DRY = process.argv.includes('--dry');
// Tolerate common copy-paste mistakes in the secrets: surrounding quotes/spaces and a leading "bot".
const clean = (v) => (v || '').trim().replace(/^["']|["']$/g, '').trim();
const TELEGRAM_BOT_TOKEN = clean(process.env.TELEGRAM_BOT_TOKEN).replace(/^bot/i, '');
const TELEGRAM_CHAT_ID = clean(process.env.TELEGRAM_CHAT_ID);
if (!DRY && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
  console.error('Set TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID');
  process.exit(1);
}

const SYMBOL = 'XAU/USD', LABEL = 'XAUUSD', MA_LEN = 20, MAX_LIST = 3, STATE = 'state.json';
const hhmm = (t) => new Date(t * 1000 + 8 * 3600e3).toISOString().slice(11, 16);
const stamp = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') + ' (UTC+8)';
const fmt = (p) => p.toFixed(2);
const range = (z) => `${fmt(z.bottom)} – ${fmt(z.top)}`;

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
state.done ??= [];   // order block ids already confirmed or closed through
state.warned ??= []; // order block ids already warned about a wick-only break
const save = () => writeFileSync(STATE, JSON.stringify({ ...state, done: state.done.slice(-200), warned: state.warned.slice(-200) }));

async function send(text) {
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
  const now = Date.now() / 1000;
  return closed ? bars.filter(x => x.time + seconds <= now) : bars;
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

const sma = (bars, end) => bars.slice(end - MA_LEN + 1, end + 1).reduce((s, b) => s + b.close, 0) / MA_LEN;
function maStatus(bars, i) {
  const b = bars[i], ma = sma(bars, i), above = b.close > ma, prevAbove = bars[i - 1].close > sma(bars, i - 1);
  const pos = b.low > ma ? 'penuh di atas' : b.high < ma ? 'penuh di bawah' : `menyentuh MA, close di ${above ? 'atas' : 'bawah'}`;
  const cross = above !== prevAbove ? `\n🔄 Baru cross ke ${above ? 'ATAS' : 'BAWAH'} MA 20` : '';
  return { above, text: `${above ? '🟢 DI ATAS' : '🔴 DI BAWAH'} MA 20 (${pos})\nClose ${fmt(b.close)} · MA20 ${fmt(ma)} · selisih ${b.close - ma >= 0 ? '+' : ''}${fmt(b.close - ma)}${cross}` };
}

const obName = (ob) => ob.type === 'demand' ? 'Bullish OB' : 'Bearish OB';
const obId = (ob) => `${ob.type}:${ob.time}`;
const beyond = (ob, c) => ob.type === 'demand' ? c < ob.bottom : c > ob.top;
const pierced = (ob, b) => ob.type === 'demand' ? b.low < ob.bottom : b.high > ob.top;
const breakDir = (ob) => ob.type === 'demand' ? '🔻 BREAKOUT KE BAWAH' : '🔺 BREAKOUT KE ATAS';
const edge = (ob) => ob.type === 'demand' ? `di bawah ${fmt(ob.bottom)}` : `di atas ${fmt(ob.top)}`;
const mark = (list, id) => { if (!list.includes(id)) list.push(id); };

const h1All = await series('1h', 3600, false);
const h1 = h1All.filter(b => b.time + 3600 <= Date.now() / 1000);
const h4 = toH4(h1All);   // keeps the forming H4 candle
const m5All = await series('5m', 300);
const lastH1 = h1[h1.length - 1], lastM5 = m5All[m5All.length - 1];

// Market closed (weekend / daily break): nothing new since the last run.
if (state.lastM5 && lastM5.time <= state.lastM5) { console.log('no new candle, skip'); save(); process.exit(0); }

const atr = atrSeries(h1);
const obs = detectOrderBlocks(h1, atr);
const zonesAll = detectZones(h1, atr);
const s1 = maStatus(h1, h1.length - 1);
const s4 = maStatus(h4, h4.length - 1);
const m5Atr = atrSeries(m5All);

// Entry after an M5-confirmed breakout: BUY when a bearish OB is broken upward, SELL when a bullish OB is broken
// downward. Entry = close of the M5 confirmation candle. SL = just behind the broken OB edge - 0.3 ATR(M5)
// (that edge should now hold as support/resistance). TP1 = 1R; TP2 = nearest opposite zone / OB edge giving
// >= 1.5R, else 2R.
function entrySignal(ob, conf) {
  const buy = ob.type === 'supply';
  const a = m5Atr[m5All.indexOf(conf)];
  const e = conf.close;
  const sl = buy ? ob.top - 0.3 * a : ob.bottom + 0.3 * a;
  const risk = Math.abs(e - sl);
  const tp1 = buy ? e + risk : e - risk;
  const { supply, demand } = nearest([...zonesAll, ...obs].filter(z => obId(z) !== obId(ob)), e, 10);
  const target = buy ? supply.find(z => z.bottom - e >= 1.5 * risk)?.bottom : demand.find(z => e - z.top >= 1.5 * risk)?.top;
  const tp2 = target ?? (buy ? e + 2 * risk : e - 2 * risk);
  const withTrend = buy ? s1.above && s4.above : !s1.above && !s4.above;
  const against = buy ? !s1.above && !s4.above : s1.above && s4.above;
  const p = lastM5.close;
  const status = (buy ? p <= sl : p >= sl) ? '❌ Harga sudah menyentuh SL, sinyal batal'
    : (buy ? p >= tp1 : p <= tp1) ? '⚠️ Harga sudah melewati TP1, jangan kejar (tunggu retest)'
    : '🟢 Masih valid';
  return `\n\n🎯 SINYAL ${buy ? 'BUY 🟢' : 'SELL 🔴'}\n` +
    `Entry: ${fmt(e)} (close M5 ${hhmm(conf.time)})\nStop loss: ${fmt(sl)}\n` +
    `TP1: ${fmt(tp1)} (1:1)\nTP2: ${fmt(tp2)} (1:${(Math.abs(tp2 - e) / risk).toFixed(1)})\n` +
    `Tren MA20: ${withTrend ? '✅ searah H1 & H4' : against ? '⚠️ melawan H1 & H4' : '⚖️ H1/H4 campuran'}\n` +
    `Harga sekarang ${fmt(p)} · ${status}`;
}

// 1. H1 candles closed since the last run that went through an H1 order block, with M5 confirmation.
const newH1 = state.lastH1 ? h1.filter(b => b.time > state.lastH1) : [lastH1];
const broke = [];
for (const bar of newH1) {
  const idx = h1.indexOf(bar), before = h1.slice(0, idx);
  for (const ob of detectOrderBlocks(before, atrSeries(before))) {
    if (!beyond(ob, bar.close)) continue;   // each H1 candle is checked once (state.lastH1)
    const conf = m5All.find(b => b.time >= bar.time && b.time < bar.time + 3600 && beyond(ob, b.close));
    const signalled = state.done.includes(obId(ob));   // entry already sent by an earlier M5 alert
    mark(state.done, obId(ob)); mark(state.warned, obId(ob));
    broke.push(`${breakDir(ob)} · ${obName(ob)} ${range(ob)}\nCandle H1 ${hhmm(bar.time)} close ${fmt(bar.close)} ${edge(ob)}.\n` +
      (conf ? `✅ M5 konfirmasi: candle M5 ${hhmm(conf.time)} close ${fmt(conf.close)} ${edge(ob)}.` + (signalled ? '' : entrySignal(ob, conf))
            : '❌ Tidak ada candle M5 yang close di luar OB.'));
  }
}

// 2. M5 candles closed since the last run against the H1 order blocks that are still intact.
const newM5 = state.lastM5 ? m5All.filter(b => b.time > state.lastM5) : m5All.slice(-6);
const alerts = [];
const confirmed = { supply: [], demand: [] };   // broken OBs per side, each with its first confirming M5 candle
for (const ob of obs) {
  const id = obId(ob);
  if (state.done.includes(id)) continue;
  const conf = newM5.find(b => beyond(ob, b.close));
  if (conf) {
    mark(state.done, id);
    confirmed[ob.type].push({ ob, conf });
    continue;
  }
  const wick = newM5.find(b => pierced(ob, b));
  if (wick && !state.warned.includes(id)) {
    mark(state.warned, id);
    alerts.push(`⚠️ Harga menembus ${obName(ob)} H1 ${range(ob)}\n❌ BELUM TERKONFIRMASI M5: candle M5 ${hhmm(wick.time)} sempat ${ob.type === 'demand' ? `turun ke ${fmt(wick.low)}` : `naik ke ${fmt(wick.high)}`}, tapi close ${fmt(wick.close)} kembali di dalam/sisi OB. Waspada false breakout.`);
  }
}
// One message and one entry per direction; the entry uses the broken OB closest to price (last level broken).
for (const side of ['supply', 'demand']) {
  const list = confirmed[side];
  if (!list.length) continue;
  list.sort((a, b) => side === 'supply' ? b.ob.top - a.ob.top : a.ob.bottom - b.ob.bottom);
  const { ob, conf } = list[0];
  const others = list.slice(1).map(x => `${obName(x.ob)} ${range(x.ob)}`).join(', ');
  alerts.push(`${breakDir(ob)} · ${obName(ob)} H1 ${range(ob)}\n✅ TERKONFIRMASI M5: candle M5 ${hhmm(conf.time)} close ${fmt(conf.close)} ${edge(ob)}.` +
    (others ? `\nIkut tertembus: ${others}.` : '') +
    entrySignal(ob, conf) + `\n\n⏳ Konfirmasi H1 menyusul setelah candle H1 ${hhmm(lastH1.time + 3600)} close.`);
}
for (const a of alerts) await send(`${a}\n${LABEL} · ${stamp()}\nBukan saran investasi.`);

// 3. Report.
const h4Bar = h4[h4.length - 1];
const both = s1.above === s4.above ? `✅ H1 & H4 searah: ${s1.above ? 'DI ATAS MA 20 (bullish)' : 'DI BAWAH MA 20 (bearish)'}` : '⚖️ H1 & H4 tidak searah';
const price = lastM5.close;
const zones = nearest(zonesAll, price, MAX_LIST);
const near = nearest(obs, price, MAX_LIST);
const list = (arr, fresh) => arr.length ? arr.map(z => range(z) + (fresh && z.fresh ? ' (fresh)' : '')).join('\n') : '-';

const sent = await send(`📈 ${LABEL} · ${stamp()}\n\n` +
  `H1 (candle ${hhmm(lastH1.time)} close):\n${s1.text}\n\nH4 (candle ${hhmm(h4Bar.time)} berjalan, close ${hhmm(h4Bar.time + 4 * 3600)}):\n${s4.text}\n\n${both}\n\n` +
  `━━ Zona H1 ━━\n🔴 Supply:\n${list([...zones.supply].reverse(), true)}\n🟢 Demand:\n${list(zones.demand, true)}\n\n` +
  `━━ Order Block H1 ━━\n🔴 Bearish OB:\n${list([...near.supply].reverse())}\n💰 Harga: ${fmt(price)}\n🟢 Bullish OB:\n${list(near.demand)}` +
  (broke.length ? `\n\n━━ Breakout OB H1 ━━\n${broke.join('\n\n')}` : ''));

// Only advance when the report went out, so a failed send is retried on the next run.
if (sent) { state.lastH1 = lastH1.time; state.lastM5 = lastM5.time; }
save();
