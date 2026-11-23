// sun.js: where the sun is right now for Tigran, shared by every version of the site.
//
// Location comes from location.json (rough, whole-degree coordinates), with a
// built-in default. The day's sunrise, sunset and twilight times come from
// api.sunrise-sunset.org; if that fails, they're computed locally from the
// same astronomical formulas. The sun's height is always computed locally so
// it can move smoothly between API events.
//
// Each minute it sets CSS variables and data attributes on <html> and fires
// a "sun" event on document with the current state in event.detail.
//
// Preview another time of day with ?at=HH:MM (Tigran's local time).

(() => {
  const DEFAULT_LOCATION = { lat: 37.8, lng: -122.4, tz: 'America/Los_Angeles' };
  const TICK_MS = 60 * 1000;
  const LOCATION_CHECK_MS = 30 * 60 * 1000;
  const RAD = Math.PI / 180;
  const MIN = 60 * 1000;

  let loc = { ...DEFAULT_LOCATION };
  let events = null; // today's events at loc, as Dates
  let eventsKey = '';
  let source = 'local';
  let offsetMs = 0; // set by ?at= for previews

  // ---------- time-zone helpers ----------
  function tzParts(date, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const o = {};
    for (const p of parts) if (p.type !== 'literal') o[p.type] = Number(p.value);
    return o;
  }
  function tzOffsetMs(date, tz) {
    const p = tzParts(date, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
  }
  function localDateString(date, tz) {
    const p = tzParts(date, tz);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  }
  function localMidnight(date, tz) {
    const p = tzParts(date, tz);
    return Date.UTC(p.year, p.month - 1, p.day) - tzOffsetMs(date, tz);
  }
  const now = () => new Date(Date.now() + offsetMs);

  // ---------- astronomy ----------
  // Sun elevation in degrees (low-precision solar position, good to ~0.01°).
  function elevation(date, lat, lng) {
    const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
    const eps = (23.439 - 0.0000004 * n) * RAD;
    const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam));
    const dec = Math.asin(Math.sin(eps) * Math.sin(lam));
    const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
    const H = (gmst * 15 + lng) * RAD - ra;
    const phi = lat * RAD;
    return Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
  }

  // Fallback: scan the local day minute by minute for threshold crossings.
  function computeEvents(dayStart, lat, lng) {
    const thresholds = [['astro', -18], ['nautical', -12], ['civil', -6], ['sun', -0.833]];
    const ev = {};
    let prev = elevation(new Date(dayStart), lat, lng);
    let maxE = -90, maxT = dayStart;
    for (let i = 1; i <= 1440; i++) {
      const t = dayStart + i * MIN;
      const e = elevation(new Date(t), lat, lng);
      for (const [k, v] of thresholds) {
        const at = () => new Date(t - MIN + MIN * (v - prev) / (e - prev));
        if (prev < v && e >= v) ev[k + 'Begin'] = at();
        if (prev >= v && e < v) ev[k + 'End'] = at();
      }
      if (e > maxE) { maxE = e; maxT = t; }
      prev = e;
    }
    return {
      astroBegin: ev.astroBegin, civilBegin: ev.civilBegin, sunrise: ev.sunBegin,
      noon: new Date(maxT), sunset: ev.sunEnd, civilEnd: ev.civilEnd, astroEnd: ev.astroEnd,
      noonElevation: maxE,
    };
  }

  async function fetchEvents(dateStr, lat, lng, tz) {
    const key = `sun:${lat},${lng}:${dateStr}`;
    try {
      const cached = localStorage.getItem(key);
      if (cached) return revive(JSON.parse(cached));
    } catch (_) {}
    const url = `https://api.sunrise-sunset.org/json?lat=${lat}&lng=${lng}&date=${dateStr}&formatted=0&tzid=${encodeURIComponent(tz)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const data = await res.json();
      if (data.status !== 'OK') throw new Error(data.status);
      const r = data.results;
      const raw = {
        astroBegin: r.astronomical_twilight_begin, civilBegin: r.civil_twilight_begin,
        sunrise: r.sunrise, noon: r.solar_noon, sunset: r.sunset,
        civilEnd: r.civil_twilight_end, astroEnd: r.astronomical_twilight_end,
      };
      try { localStorage.setItem(key, JSON.stringify(raw)); } catch (_) {}
      return revive(raw);
    } finally {
      clearTimeout(timer);
    }
  }
  function revive(raw) {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      const d = new Date(v);
      out[k] = d.getUTCFullYear() < 2000 ? undefined : d; // API uses 1970 for "doesn't happen"
    }
    return out;
  }

  async function ensureEvents(t) {
    const dateStr = localDateString(t, loc.tz);
    const key = `${loc.lat},${loc.lng},${loc.tz},${dateStr}`;
    if (key === eventsKey && events) return;
    const local = computeEvents(localMidnight(t, loc.tz), loc.lat, loc.lng);
    events = local;
    source = 'local';
    eventsKey = key;
    try {
      const api = await fetchEvents(dateStr, loc.lat, loc.lng, loc.tz);
      if (eventsKey !== key) return;
      events = { ...api, noonElevation: local.noonElevation };
      source = 'sunrise-sunset.org';
    } catch (err) {
      console.info('[sun] API unavailable, using local calculation:', err.message || err);
    }
  }

  async function loadLocation() {
    try {
      const res = await fetch('location.json', { cache: 'no-store' });
      if (!res.ok) return;
      const j = await res.json();
      if (typeof j.lat === 'number' && typeof j.lng === 'number') {
        loc = { lat: j.lat, lng: j.lng, tz: j.tz || loc.tz };
      }
    } catch (_) { /* keep the current location */ }
  }

  // ---------- turning the sun into a look ----------
  // Sky colors keyed by sun elevation (same going up and coming down).
  const SKY = [
    [-18, '#0D1226', '#181F3B'],
    [-12, '#121935', '#262D55'],
    [-6,  '#1F2A55', '#5A4C7E'],
    [-2,  '#3A5285', '#D9906F'],
    [2,   '#6A95C4', '#F0BC8C'],
    [8,   '#8CB6DA', '#EAD8C0'],
    [20,  '#9CC4E4', '#DCE7EF'],
    [45,  '#80B3E0', '#D6E5F1'],
  ];
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, f) => {
    const A = hex(a), B = hex(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * f).toString(16).padStart(2, '0')).join('');
  };
  function sky(elev) {
    if (elev <= SKY[0][0]) return [SKY[0][1], SKY[0][2]];
    for (let i = 1; i < SKY.length; i++) {
      if (elev <= SKY[i][0]) {
        const f = (elev - SKY[i - 1][0]) / (SKY[i][0] - SKY[i - 1][0]);
        return [mix(SKY[i - 1][1], SKY[i][1], f), mix(SKY[i - 1][2], SKY[i][2], f)];
      }
    }
    const last = SKY[SKY.length - 1];
    return [last[1], last[2]];
  }

  function phaseAt(t, e) {
    const T = t.getTime();
    const before = d => d && T < d.getTime();
    if (!e.sunrise || !e.sunset) return 'night'; // polar edge case
    if (e.astroBegin && before(e.astroBegin)) return 'night';
    if (before(e.civilBegin)) return 'dawn';
    if (before(e.sunrise)) return 'blue-hour';
    if (T < e.sunrise.getTime() + 45 * MIN) return 'sunrise';
    if (T < e.sunset.getTime() - 60 * MIN) return 'day';
    if (before(e.sunset)) return 'golden-hour';
    if (before(e.civilEnd)) return 'dusk';
    if (before(e.astroEnd)) return 'twilight';
    return 'night';
  }

  function duration(ms) {
    const m = Math.round(Math.abs(ms) / MIN);
    if (m < 1) return 'a moment';
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.floor(m / 60), r = m % 60;
    if (h >= 3 || r === 0) return `${Math.round(m / 60)} hours`;
    return `${h} hour${h === 1 ? '' : 's'} ${r} minute${r === 1 ? '' : 's'}`;
  }
  const clock = (d, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    .format(d).replace(' AM', ' am').replace(' PM', ' pm');

  function sentence(t, phase, e) {
    const T = t.getTime();
    const DAY = 24 * 60 * MIN;
    switch (phase) {
      case 'night': {
        const next = T > e.noon.getTime() ? e.sunrise.getTime() + DAY : e.sunrise.getTime();
        return `The sun comes up in ${duration(next - T)}.`;
      }
      case 'dawn':
      case 'blue-hour': return `The sun comes up in ${duration(e.sunrise - T)}.`;
      case 'sunrise': return `The sun came up ${duration(T - e.sunrise)} ago.`;
      case 'day': return e.sunset - T > 3 * 60 * MIN
        ? `The sun sets at ${clock(e.sunset, loc.tz)}.`
        : `The sun sets in ${duration(e.sunset - T)}.`;
      case 'golden-hour': return `It's golden hour. The sun sets in ${duration(e.sunset - T)}.`;
      case 'dusk':
      case 'twilight': return `The sun set ${duration(T - e.sunset)} ago.`;
    }
    return '';
  }

  const state = {};
  function update() {
    if (!events) return;
    const t = now();
    const elev = elevation(t, loc.lat, loc.lng);
    const e = events;
    const phase = phaseAt(t, e);
    const [top, bottom] = sky(elev);

    // Sun position across the hero: x follows sunrise→sunset, y follows elevation.
    const span = (e.sunset && e.sunrise) ? e.sunset - e.sunrise : 12 * 60 * MIN;
    const progress = e.sunrise ? (t - e.sunrise) / span : 0.5;
    const x = 40 + Math.min(1.1, Math.max(-0.1, progress)) * 52; // keep the arc to the right of the headline
    const peak = Math.max(10, e.noonElevation || 45);
    const y = 100 - (elev / peak) * 78; // horizon = bottom edge of the hero

    const root = document.documentElement;
    root.style.setProperty('--sky-top', top);
    root.style.setProperty('--sky-bottom', bottom);
    root.style.setProperty('--sun-x', x.toFixed(2) + '%');
    root.style.setProperty('--sun-y', y.toFixed(2) + '%');
    root.style.setProperty('--stars', Math.min(1, Math.max(0, (-elev - 3) / 12)).toFixed(2));
    root.dataset.phase = phase;
    root.dataset.dark = elev < -3 ? 'true' : 'false';
    // Only animate changes after the first paint, so nothing slides in from a default.
    if (!root.dataset.ready) requestAnimationFrame(() => requestAnimationFrame(() => { root.dataset.ready = 'true'; }));

    Object.assign(state, {
      time: t, localTime: clock(t, loc.tz), localHour: tzParts(t, loc.tz).hour,
      elevation: elev, phase, events: e, source, location: { ...loc },
      sentence: sentence(t, phase, e),
    });
    document.dispatchEvent(new CustomEvent('sun', { detail: state }));
  }

  async function tick() {
    await ensureEvents(now());
    update();
  }

  async function start() {
    await loadLocation();
    const at = new URLSearchParams(location.search).get('at');
    const m = at && at.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const real = new Date();
      const p = tzParts(real, loc.tz);
      const target = Date.UTC(p.year, p.month - 1, p.day, +m[1], +m[2]) - tzOffsetMs(real, loc.tz);
      offsetMs = target - real.getTime();
    }
    // Paint right away from the local calculation, then refine with the API.
    events = computeEvents(localMidnight(now(), loc.tz), loc.lat, loc.lng);
    update();
    await tick();
    setInterval(tick, TICK_MS);
    setInterval(async () => {
      const before = `${loc.lat},${loc.lng},${loc.tz}`;
      await loadLocation();
      if (`${loc.lat},${loc.lng},${loc.tz}` !== before) tick();
    }, LOCATION_CHECK_MS);
  }

  window.Sun = { state, elevation };
  start();
})();
