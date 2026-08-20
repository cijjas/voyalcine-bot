'use strict';

/**
 * Etapa 2 — inspección del mapa de butacas.
 *
 * La etapa 1 (watch.js) sólo sabe si la función está agotada o no. Eso no
 * alcanza: una función puede "no estar agotada" y tener una sola butaca suelta
 * en la fila A pegada a la pantalla.
 *
 * Acá se recorre el flujo real de compra con una sesión logueada:
 *   pelicula.aspx?perf=..   -> fija la función en la sesión
 *   entradas.aspx           -> grilla de precios; se pone General = N
 *   POST btnContinue        -> butacas.aspx
 *   butacas.aspx            -> <table id="ctl00_Contenido_tblMap"> = grilla real
 *
 * La grilla es una tabla HTML de verdad, así que cada butaca tiene coordenadas
 * (fila, columna) exactas y se puede razonar sobre geometría: fila N desde la
 * pantalla, bloque del medio, y butacas contiguas.
 *
 * Este módulo NO selecciona ni compra nada. Sólo lee el mapa.
 */

const SEAT_FREE = 'AvSeat';       // DISPONIBLE
const SEAT_TAKEN = 'SoldSeat';    // OCUPADO
const SEAT_BLOCKED = 'NotAvSeat'; // NO DISPONIBLE
const SEAT_PICKED = 'SelSeat';    // SELECCIONADO
const SEAT_ACCESSIBLE = 'HandSeat'; // silla de ruedas

/**
 * Una butaca cuenta como agarrable si el sitio la deja clickear (el <input> no
 * viene con disabled) y es del tipo libre. Nos apoyamos en `disabled` en vez de
 * confiar sólo en el nombre de la imagen: es la señal que usa la página misma.
 *
 * Las HandSeat (sillas de ruedas) quedan afuera a propósito aunque estén
 * libres; son para quien las necesita. `includeAccessible` las suma.
 */
function isFree(seat, includeAccessible = false) {
  if (seat.disabled) return false;
  if (seat.state === SEAT_FREE) return true;
  return includeAccessible && seat.state === SEAT_ACCESSIBLE;
}

const BASE = 'https://www.voyalcine.net/showcase/';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
   .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'");

/** Sesión ASP.NET con cookie jar propio. Es de un solo hilo a propósito: el
 *  sitio se queja con "Ya existe otra ventana abierta" si se lo usa en paralelo. */
class Session {
  constructor(cookie) {
    this.jar = new Map();
    for (const part of String(cookie).split(';')) {
      const kv = part.trim();
      if (!kv) continue;
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }

  get cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
  }

  async go(url, opts = {}) {
    let cur = url;
    let cfg = opts;
    for (let hop = 0; hop < 6; hop++) {
      const res = await fetch(cur, {
        ...cfg,
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
        headers: {
          'user-agent': UA,
          cookie: this.cookieHeader,
          accept: 'text/html,application/xhtml+xml,*/*',
          ...(cfg.headers || {}),
        },
      });
      this.absorb(res);
      if ([301, 302, 303, 307].includes(res.status)) {
        cur = new URL(res.headers.get('location'), cur).href;
        cfg = {}; // los saltos siguientes son GET
        continue;
      }
      return { url: cur, status: res.status, body: await res.text() };
    }
    throw new Error('demasiados redirects');
  }
}

// ------------------------------------------------------------ formularios ---

function hiddenFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const n = m[0].match(/name="([^"]+)"/);
    const v = m[0].match(/value="([^"]*)"/);
    if (n) out[n[1]] = v ? decode(v[1]) : '';
  }
  return out;
}

/** Todos los <select> con su opción seleccionada (por defecto 0). */
function selectFields(html) {
  const out = {};
  for (const m of html.matchAll(/<select name="([^"]+)"[\s\S]*?<\/select>/g)) {
    const sel = m[0].match(/<option selected="selected" value="([^"]*)"/);
    out[m[1]] = sel ? sel[1] : '0';
  }
  return out;
}

/** Fila de precio -> nombre del <select>, buscando por etiqueta (ej. "General"). */
function findPriceSelect(html, label) {
  const re = /<td>([^<]{2,40})<\/td><td>(?:[\s\S]{0,200}?)<\/td><td>\s*<select name="([^"]+)"/g;
  const rows = [];
  for (const m of html.matchAll(re)) rows.push({ label: m[1].trim(), name: m[2] });
  const hit = rows.find((r) => new RegExp(`^${label}$`, 'i').test(r.label)) ||
              rows.find((r) => new RegExp(label, 'i').test(r.label));
  return { hit: hit || null, all: rows };
}

// -------------------------------------------------------------- la grilla ---

/**
 * Parsea <table id="ctl00_Contenido_tblMap"> a filas de butacas con columna real.
 * Las <tr> sin butacas (pasillos horizontales) se descartan, así el índice de
 * fila que devolvemos es el que ve el usuario contando desde la pantalla.
 */
function parseGrid(html) {
  const start = html.indexOf('id="ctl00_Contenido_tblMap"');
  if (start < 0) return null;
  const table = html.slice(start, html.indexOf('</table>', start));

  const rows = [];
  for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const seats = [];
    let col = 0;
    for (const td of tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)) {
      const m = td[1].match(/name="([^"]+)"[\s\S]*?title="([^"]+)"[\s\S]*?src="img\/(\w+)\.jpg"/);
      if (m) {
        seats.push({
          col, control: m[1], id: m[2], state: m[3],
          disabled: /disabled="disabled"/.test(td[1]),
        });
      }
      col++;
    }
    if (seats.length) rows.push(seats);
  }
  if (!rows.length) return null;

  return rows.map((seats, i) => ({
    index: i + 1,                       // 1 = fila pegada a la pantalla
    letter: (seats[0].id.split('-')[0] || '?'),
    seats,
  }));
}

/**
 * Detecta los bloques de platea a partir de la ocupación por columna.
 * Un pasillo es una columna que casi ninguna fila usa; el resto son bloques
 * contiguos. Así "el medio" sale de la geometría real de la sala y no de un
 * número mágico, y sigue funcionando en otras salas.
 */
function detectBlocks(grid) {
  const occ = new Map();
  for (const row of grid) for (const s of row.seats) occ.set(s.col, (occ.get(s.col) || 0) + 1);

  const cols = [...occ.keys()].sort((a, b) => a - b);
  const max = Math.max(...occ.values());
  const isAisle = (c) => (occ.get(c) || 0) <= Math.max(1, max * 0.2);

  const blocks = [];
  let cur = null;
  for (let c = cols[0]; c <= cols[cols.length - 1]; c++) {
    if (occ.has(c) && !isAisle(c)) {
      if (!cur) { cur = { from: c, to: c }; blocks.push(cur); }
      else cur.to = c;
    } else {
      cur = null;
    }
  }

  const span = { from: cols[0], to: cols[cols.length - 1] };
  const mid = (span.from + span.to) / 2;
  // el bloque "del medio" es el que contiene el centro de la sala
  let middle = blocks.find((b) => mid >= b.from && mid <= b.to);
  if (!middle && blocks.length) {
    middle = blocks.reduce((best, b) =>
      Math.abs((b.from + b.to) / 2 - mid) < Math.abs((best.from + best.to) / 2 - mid) ? b : best);
  }
  return { blocks, middle, span };
}

function zoneRange(zoneName, layout) {
  const { blocks, middle, span } = layout;
  switch (zoneName) {
    case 'middle': return middle || span;
    case 'left': return blocks[0] || span;
    case 'right': return blocks[blocks.length - 1] || span;
    case 'any':
    default: return span;
  }
}

/**
 * Busca tramos de `need` butacas libres, contiguas, dentro de la zona y del
 * rango de filas pedido. Devuelve los candidatos ordenados por cercanía al
 * centro de la zona.
 */
function findRuns(grid, layout, { rowFrom, rowTo, need, zone, adjacent, includeAccessible }) {
  const range = zoneRange(zone, layout);
  const center = (range.from + range.to) / 2;
  const out = [];

  for (const row of grid) {
    if (row.index < rowFrom || row.index > rowTo) continue;
    const free = row.seats
      .filter((s) => isFree(s, includeAccessible) && s.col >= range.from && s.col <= range.to)
      .sort((a, b) => a.col - b.col);
    if (free.length < need) continue;

    if (!adjacent) {
      out.push({ row: row.index, letter: row.letter, seats: free.slice(0, need) });
      continue;
    }
    // tramos de columnas consecutivas
    let run = [];
    const flush = () => {
      for (let i = 0; i + need <= run.length; i++) {
        out.push({ row: row.index, letter: row.letter, seats: run.slice(i, i + need) });
      }
      run = [];
    };
    for (const s of free) {
      if (run.length && s.col !== run[run.length - 1].col + 1) flush();
      run.push(s);
    }
    flush();
  }

  return out.sort((a, b) => {
    const ac = a.seats.reduce((t, s) => t + s.col, 0) / a.seats.length;
    const bc = b.seats.reduce((t, s) => t + s.col, 0) / b.seats.length;
    return Math.abs(ac - center) - Math.abs(bc - center);
  });
}

// ------------------------------------------------------------- el chequeo ---

class SessionExpired extends Error {}

/**
 * Recorre el flujo para una función y devuelve qué butacas cumplen el criterio.
 * No selecciona ni compra: sólo lee.
 */
async function inspect(session, film, perf, opts) {
  const {
    need = 2, price = 'General', rowFrom = 1, rowTo = 99,
    zone = 'middle', adjacent = true, includeAccessible = false,
  } = opts;

  // 1. fijar la función en la sesión
  const q = `filmid=${film}&perf=${perf.perfId}&cinema=${perf.cinemaId}` +
            `&date=${perf.date}&show=${encodeURIComponent(perf.showId)}`;
  let r = await session.go(`${BASE}pelicula.aspx?${q}`);
  if (/ingresar\.aspx/i.test(r.url)) throw new SessionExpired('la sesión no está logueada');
  if (/agotada=1/i.test(r.url)) return { ok: false, reason: 'agotada' };

  // 2. grilla de precios
  r = await session.go(`${BASE}entradas.aspx`);
  if (/ingresar\.aspx/i.test(r.url)) throw new SessionExpired('la sesión no está logueada');
  if (!/entradas\.aspx/i.test(r.url)) {
    return { ok: false, reason: `no llegó a entradas (${r.url.split('/').pop()})` };
  }

  const { hit, all } = findPriceSelect(r.body, price);
  if (!hit) {
    return { ok: false, reason: `no hay fila de precio "${price}" (hay: ${all.map((x) => x.label).join(', ') || 'ninguna'})` };
  }

  // 3. poner N entradas y darle a CONTINUAR
  const form = { ...hiddenFields(r.body), ...selectFields(r.body) };
  for (const k of Object.keys(form)) if (/cbo\w*Quantity$/.test(k)) form[k] = '0';
  form[hit.name] = String(need);
  form.__EVENTTARGET = 'ctl00$Contenido$btnContinue';
  form.__EVENTARGUMENT = '';

  r = await session.go(`${BASE}entradas.aspx`, {
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: `${BASE}entradas.aspx`,
      origin: 'https://www.voyalcine.net',
    },
  });

  // 4. leer el mapa
  const grid = parseGrid(r.body);
  if (!grid) {
    const alert = r.body.match(/alert\('([^']{0,160})'\)/);
    return { ok: false, reason: alert ? alert[1] : `sin mapa de butacas (${r.url.split('/').pop()})` };
  }

  const layout = detectBlocks(grid);
  const runs = findRuns(grid, layout, { rowFrom, rowTo, need, zone, adjacent, includeAccessible });
  const totalFree = grid.reduce(
    (t, row) => t + row.seats.filter((s) => isFree(s, includeAccessible)).length, 0);

  return {
    ok: runs.length > 0,
    reason: runs.length ? null : `sin ${need} butacas${adjacent ? ' juntas' : ''} en filas ${rowFrom}-${rowTo} zona ${zone}`,
    runs: runs.slice(0, 5),
    totalFree,
    rows: grid.length,
    layout,
  };
}

module.exports = {
  Session, SessionExpired, inspect, isFree,
  parseGrid, detectBlocks, findRuns, findPriceSelect,
  SEAT_FREE, SEAT_TAKEN, SEAT_BLOCKED, SEAT_PICKED, SEAT_ACCESSIBLE,
};
