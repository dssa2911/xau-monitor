// Shared supply/demand zone and order block detection on closed OHLC bars.
export const ATR_LEN = 14;

export function atrSeries(bars) {
  const out = [];
  let atr = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i], pc = i ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    atr = atr === null ? tr : (atr * (ATR_LEN - 1) + tr) / ATR_LEN;
    out.push(atr);
  }
  return out;
}

// Merge overlapping zones of the same type (newest wins the time stamp).
function merge(zones) {
  const merged = [];
  for (const z of zones) {
    const m = merged.find(o => o.type === z.type && z.bottom <= o.top && z.top >= o.bottom);
    if (m) { m.top = Math.max(m.top, z.top); m.bottom = Math.min(m.bottom, z.bottom); m.fresh = m.fresh && z.fresh; m.time = z.time; }
    else merged.push({ ...z });
  }
  return merged;
}

// Walk bars after `from`; a zone is broken once a candle closes through it, and no longer fresh once touched.
function track(z, bars, from, end) {
  for (let k = from; k < end; k++) {
    const b = bars[k];
    if (z.type === 'demand') {
      if (b.close < z.bottom) { z.broken = true; return z; }
      if (b.low <= z.top) z.fresh = false;
    } else {
      if (b.close > z.top) { z.broken = true; return z; }
      if (b.high >= z.bottom) z.fresh = false;
    }
  }
  return z;
}

// Zone = base candle right before an impulsive candle (body >= impulseAtr x ATR).
// Zones from all bars except the last one, which is the candle being evaluated for a signal.
export function detectZones(bars, atr, impulseAtr = 1.5) {
  const zones = [];
  const last = bars.length - 1;
  for (let j = ATR_LEN + 1; j < last; j++) {
    const imp = bars[j], base = bars[j - 1];
    if (Math.abs(imp.close - imp.open) < impulseAtr * atr[j - 1]) continue;
    const type = imp.close > imp.open ? 'demand' : 'supply';
    const z = track({ type, top: base.high, bottom: base.low, time: base.time, fresh: true, broken: false }, bars, j + 1, last);
    if (!z.broken) zones.push(z);
  }
  return merge(zones);
}

// Order block = last opposite-colour candle before a move that closes beyond its extreme by >= moveAtr x ATR
// within the next `lookahead` candles. Bullish OB (demand side) = last bearish candle before the rally,
// bearish OB (supply side) = last bullish candle before the drop. Returns OBs not yet closed through.
export function detectOrderBlocks(bars, atr, { moveAtr = 1.0, lookahead = 3 } = {}) {
  const obs = [];
  const end = bars.length;
  for (let i = ATR_LEN + 1; i < end - 1; i++) {
    const b = bars[i];
    const ahead = bars.slice(i + 1, Math.min(end, i + 1 + lookahead));
    if (b.close < b.open && ahead.some(a => a.close > b.high + moveAtr * atr[i]))
      obs.push({ type: 'demand', top: b.high, bottom: b.low, time: b.time, fresh: true, broken: false, i });
    else if (b.close > b.open && ahead.some(a => a.close < b.low - moveAtr * atr[i]))
      obs.push({ type: 'supply', top: b.high, bottom: b.low, time: b.time, fresh: true, broken: false, i });
  }
  return merge(obs.map(o => track(o, bars, o.i + 1 + lookahead, end)).filter(o => !o.broken)).map(({ i, ...o }) => o);
}

export function nearest(zones, price, max = 4) {
  const supply = zones.filter(z => z.type === 'supply' && z.bottom > price).sort((a, b) => a.bottom - b.bottom).slice(0, max);
  const demand = zones.filter(z => z.type === 'demand' && z.top < price).sort((a, b) => b.top - a.top).slice(0, max);
  return { supply, demand };
}
