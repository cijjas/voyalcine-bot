#!/usr/bin/env node
'use strict';

/**
 * voyalcine-bot — watches VoyAlCine showtimes and alerts the moment a
 * performance stops answering "agotada".
 *
 * How it works
 * ------------
 * 1. Pulls the public showtime tree from api.voyalcine.net (source of truth for
 *    which performances exist — new dates/times get picked up automatically).
 * 2. For each performance it wants to watch, it asks the booking entry point:
 *      GET /showcase/pelicula.aspx?filmid=..&perf=..&cinema=..&date=..&show=..
 *    The server answers with a redirect that is a clean binary oracle:
 *      302 -> /showcase/entradas.aspx        => seats available
 *      302 -> pelicula.aspx?...&agotada=1    => sold out
 *      200 (inline alert)                    => backend availability lookup failed
 * 3. Alerts only on a transition into "available", so a show that stays open
 *    doesn't spam you every cycle.
 *
 * Requests are HEAD (no body downloaded), pooled at low concurrency, jittered,
 * and backed off on server errors.
 */

const fs = require('node:fs');
const path = require('node:path');
const seats = require('./seats');
const alerts = require('./alert');

// ---------------------------------------------------------------- config ----

const API = 'https://api.voyalcine.net/films/{film}/tree/showcase';
const BOOK = 'https://www.voyalcine.net/showcase/pelicula.aspx';
const TZ = 'America/Argentina/Buenos_Aires';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const STATE_DIR = __dirname;
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const HITS_FILE = path.join(STATE_DIR, 'hits.log');
const CONFIG_FILE = path.join(STATE_DIR, 'config.json');
const KNOWN_FILE = path.join(STATE_DIR, 'known.json');

// Response classes.
const AVAILABLE = 'DISPONIBLE';
const SOLD_OUT = 'AGOTADA';
const BACKEND_ERR = 'ERROR_BACKEND';
const UNKNOWN = 'DESCONOCIDO';
const SEATS_OK = 'BUTACAS_OK';   // pasó etapa 1 y hay butacas donde las querés
const SEATS_NO = 'SIN_BUTACAS';  // no está agotada, pero no sirve el lugar

/** Sesión logueada para la etapa 2. Se apaga sola si la cookie vence. */
let session = null;

// ------------------------------------------------------------- arg parse ----

function parseArgs(argv) {
  const o = {
    film: 5875,
    cinemas: null,       // Set of cinema ids, null = all
    formats: null,       // RegExp against formatDescription, null = all
    dates: null,         // Set of YYYY-MM-DD, null = all
    after: null,         // "HH:MM" earliest showtime
    before: null,        // "HH:MM" latest showtime
    interval: 90,        // seconds between cycles
    concurrency: 4,
    once: false,
    list: false,
    open: false,         // open the booking page in a browser on a hit
    includePast: false,
    quiet: false,
    maxChecks: 200,
    // etapa 2 — inspección de butacas (requiere sesión logueada en config.json)
    seats: 0,            // 0 = desactivado; N = exigir N butacas
    price: 'General',
    rowFrom: 1,
    rowTo: 99,
    zone: 'middle',
    adjacent: true,
    includeAccessible: false,
    // avisos
    alert: null,          // null = canales por defecto
    testAlert: false,
    remindEvery: 0,       // re-avisar cada N ciclos si el match sigue vivo
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--film': o.film = Number(next()); break;
      case '--cinema':
      case '--cinemas':
        o.cinemas = new Set(next().split(',').map((s) => Number(s.trim())));
        break;
      case '--imax': o.formats = /imax/i; break;
      case '--format': o.formats = new RegExp(next(), 'i'); break;
      case '--date':
      case '--dates':
        o.dates = new Set(next().split(',').map((s) => s.trim()));
        break;
      case '--after': o.after = next(); break;
      case '--before': o.before = next(); break;
      case '--interval': o.interval = Number(next()); break;
      case '--concurrency': o.concurrency = Number(next()); break;
      case '--once': o.once = true; break;
      case '--list': o.list = true; break;
      case '--open': o.open = true; break;
      case '--include-past': o.includePast = true; break;
      case '--quiet': o.quiet = true; break;
      case '--max-checks': o.maxChecks = Number(next()); break;
      case '--seats': o.seats = Number(next()); break;
      case '--price': o.price = next(); break;
      case '--zone': o.zone = next(); break;
      case '--anywhere': o.adjacent = false; break;
      case '--accessible': o.includeAccessible = true; break;
      case '--alert': o.alert = next(); break;
      case '--test-alert': o.testAlert = true; break;
      case '--remind-every': o.remindEvery = Number(next()); break;
      case '--rows': {
        const m = String(next()).match(/^(\d+)\s*[-:]\s*(\d+)$/);
        if (!m) { console.error('--rows espera algo como 4-8'); process.exit(1); }
        o.rowFrom = Number(m[1]); o.rowTo = Number(m[2]);
        break;
      }
      case '-h':
      case '--help': usage(); process.exit(0);
      default:
        console.error(`unknown flag: ${a}\n`);
        usage();
        process.exit(1);
    }
  }
  return o;
}

function usage() {
  console.log(`
voyalcine-bot — alerta cuando una función deja de estar agotada

  node watch.js [opciones]

Filtros
  --film <id>            film id (default 5875 = La Odisea)
  --imax                 solo funciones IMAX
  --format <regex>       filtra formatDescription, ej: "Subtitulado"
  --cinema <ids>         ids de cine separados por coma, ej: 18,13
  --date <fechas>        YYYY-MM-DD separadas por coma
  --after HH:MM          solo funciones desde esa hora
  --before HH:MM         solo funciones hasta esa hora
  --include-past         no descartar funciones ya empezadas

Butacas (etapa 2 — necesita sesión logueada en config.json)
  --seats <n>            exigir n butacas libres antes de avisar
  --rows 4-8             filas contando desde la pantalla (1 = la de adelante)
  --zone middle|left|right|any   bloque de la platea (default middle)
  --price <etiqueta>     fila de precio a usar (default "General")
  --anywhere             no exigir que las butacas estén juntas
  --accessible           incluir butacas de silla de ruedas (por defecto no)

Avisos
  --test-alert           dispara una alerta de prueba y sale
  --alert <canales>      bell,sound,notify,say,dialog,open  (o "all" / "none")
                         default: bell,sound,notify
  --remind-every <n>     re-avisar cada n ciclos mientras el match siga vivo

Ejecución
  --interval <seg>       segundos entre ciclos (default 90)
  --concurrency <n>      requests en paralelo (default 4)
  --once                 un solo barrido y salir
  --list                 imprime las funciones que coinciden y sale
  --open                 abre el navegador cuando encuentra disponibilidad
  --quiet                solo imprime cambios y hallazgos
  --max-checks <n>       tope de funciones por ciclo (default 200)

Ejemplos
  node watch.js --imax --once
  node watch.js --imax --interval 60 --open
  node watch.js --imax --seats 2 --rows 4-8 --zone middle
  node watch.js --cinema 18,13 --after 18:00
`);
}

// ------------------------------------------------------------- utilities ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Current wall clock in Buenos Aires as "YYYY-MM-DD HH:MM" (lexically sortable). */
function nowInBA() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

function stamp() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
}

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function bookingUrl(film, p) {
  return `${BOOK}?filmid=${film}&perf=${p.perfId}&cinema=${p.cinemaId}` +
         `&date=${p.date}&show=${encodeURIComponent(p.showId)}`;
}

// --------------------------------------------------------------- fetching ---

async function getShowtimes(film) {
  const res = await fetch(API.replace('{film}', String(film)), {
    headers: {
      accept: '*/*',
      'user-agent': UA,
      origin: 'https://www.voyalcine.net',
      referer: 'https://www.voyalcine.net/',
      'cache-control': 'no-cache',
    },
  });
  if (!res.ok) throw new Error(`showtime API HTTP ${res.status}`);
  const json = await res.json();

  const out = [];
  for (const [date, cinemas] of Object.entries(json.days || {})) {
    for (const c of cinemas) {
      for (const f of c.formats || []) {
        for (const perf of f.performances || []) {
          out.push({
            film: json.id,
            filmName: json.name,
            date,
            cinemaId: c.id,
            cinemaName: c.name,
            format: f.formatDescription,
            showId: f.showId,
            perfId: perf.performanceId,
            showTime: perf.showTime,
          });
        }
      }
    }
  }
  out.sort((a, b) =>
    (a.date + a.showTime).localeCompare(b.date + b.showTime) || a.cinemaId - b.cinemaId);
  return { name: json.name, performances: out };
}

/**
 * Ask the booking entry point whether this performance can be booked.
 * Returns one of AVAILABLE / SOLD_OUT / BACKEND_ERR / UNKNOWN / HTTP_<code>.
 */
async function probe(film, p, attempt = 0) {
  const url = bookingUrl(film, p);
  const headers = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml',
    referer: `${BOOK}?filmId=${film}`,
    'cache-control': 'no-cache',
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers,
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (attempt < 2) {
      await sleep(1500 * (attempt + 1));
      return probe(film, p, attempt + 1);
    }
    return { status: UNKNOWN, detail: `net: ${err.message}` };
  }

  if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307) {
    const loc = res.headers.get('location') || '';
    if (/agotada=1/i.test(loc)) return { status: SOLD_OUT, detail: loc };
    if (/entradas\.aspx/i.test(loc)) return { status: AVAILABLE, detail: loc };
    return { status: UNKNOWN, detail: `redirect: ${loc}` };
  }

  if (res.status === 200) {
    // The page rendered inline, which means a JS alert() carries the reason.
    // Only this branch needs the body, and it is the rare case.
    try {
      const body = await (await fetch(url, { redirect: 'manual', headers })).text();
      if (/Se produjo un error al intentar obtener la disponibilidad/i.test(body)) {
        return { status: BACKEND_ERR, detail: 'availability lookup failed upstream' };
      }
      if (/agotada/i.test(body)) return { status: SOLD_OUT, detail: 'inline agotada' };
      const alert = body.match(/alert\('([^']{0,160})'\)/);
      return { status: UNKNOWN, detail: alert ? alert[1] : 'HTTP 200, sin alerta reconocida' };
    } catch (err) {
      return { status: UNKNOWN, detail: `HTTP 200, body: ${err.message}` };
    }
  }

  if (res.status === 429 || res.status >= 500) {
    if (attempt < 2) {
      await sleep(4000 * (attempt + 1));
      return probe(film, p, attempt + 1);
    }
  }
  return { status: `HTTP_${res.status}`, detail: '' };
}

/** Bounded-concurrency map with a small jitter so we don't burst the origin. */
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await sleep(120 + Math.floor(Math.random() * 240));
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// -------------------------------------------------------------- filtering ---

function matches(p, o, now) {
  if (o.cinemas && !o.cinemas.has(p.cinemaId)) return false;
  if (o.formats && !o.formats.test(p.format)) return false;
  if (o.dates && !o.dates.has(p.date)) return false;
  if (o.after && p.showTime < o.after) return false;
  if (o.before && p.showTime > o.before) return false;
  if (!o.includePast && `${p.date} ${p.showTime}` <= now) return false;
  return true;
}

const label = (p) =>
  `${p.date} ${p.showTime}  ${p.cinemaName} · ${p.format} (perf ${p.perfId})`;

/**
 * Fecha legible para los avisos: "martes 25 de agosto · 13:05".
 * Se formatea en UTC a propósito: p.date ya es una fecha de calendario del
 * cine, no un instante, así que convertirla de zona la correría un día.
 */
function prettyWhen(p) {
  const [y, m, d] = p.date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const txt = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long',
  }).format(dt).replace(',', '');            // "martes 25 de agosto"
  const cap = txt.charAt(0).toUpperCase() + txt.slice(1);
  return `${cap} · ${p.showTime}`;
}

// --------------------------------------------------------------- alerting ---

/**
 * Registro de un hallazgo: consola + hits.log. Siempre por función, aunque el
 * aviso después se agrupe.
 */
function announce(p, url, prev, o, seatInfo) {
  const seatTxt = seatInfo
    ? seatInfo.runs.map((r) => r.seats.map((s) => s.id).join('+')).join('  |  ')
    : '';
  const line = `${new Date().toISOString()}  ${label(p)}  ${seatTxt}  ${url}`;
  fs.appendFileSync(HITS_FILE, line + '\n');

  console.log('');
  console.log(C.green(C.bold('  ╔══════════════════════════════════════════════════════╗')));
  console.log(C.green(C.bold('  ║   ENTRADAS DISPONIBLES  (ya no está agotada)         ║')));
  console.log(C.green(C.bold('  ╚══════════════════════════════════════════════════════╝')));
  console.log(`  ${C.bold(p.filmName)}`);
  console.log(`  ${label(p)}`);
  console.log(`  estado anterior: ${prev || 'sin registro'}`);
  if (seatInfo) {
    console.log(`  butacas (${seatInfo.totalFree} libres en la sala):`);
    for (const r of seatInfo.runs) {
      console.log(`    fila ${r.row} (${r.letter})  ${C.bold(r.seats.map((s) => s.id).join('  '))}`);
    }
  }
  console.log(`  ${C.cyan(url)}`);
  console.log('');

}

/**
 * Consejo sobre las butacas encontradas. Sólo aplica cuando se leyó el mapa
 * (etapa 2) y la función es IMAX: el número de fila que menciona es de esa sala.
 */
const NOTA_IMAX = 'Butacas aceptables para IMAX, igual intentaría sacar de la fila H para arriba.';

function notaButacas(hits) {
  const aplica = hits.some((h) => h.seatInfo && /imax/i.test(h.p.format || ''));
  return aplica ? NOTA_IMAX : null;
}

/** Un solo hallazgo: el aviso puede ser específico. */
function alertHit({ p, url, seatInfo }, o) {
  const best = seatInfo ? seatInfo.runs[0].seats.map((s) => s.id).join(' + ') : null;
  const when = prettyWhen(p);

  const channels = [...o.channels];
  if (o.open && !channels.includes('open')) channels.push('open');

  // La fecha va sólo en `subtitle`: alert.js la pone arriba en los dos canales
  // (banner y ventana), así que repetirla en el cuerpo la mostraba dos veces.
  //
  // Cine y formato sólo se muestran si estás mirando más de uno; con --imax
  // son siempre los mismos y no aportan nada al aviso.
  const detail = [];
  if (o.showVenue) detail.push(`${p.cinemaName} · ${p.format}`);
  detail.push(best ? `Butacas ${best} · fila ${seatInfo.runs[0].row}` : 'Ya no está agotada');
  const nota = notaButacas([{ p, seatInfo }]);
  if (nota) detail.push(nota);

  alerts.fire(channels, {
    title: `🎟 ${p.filmName} — hay lugar`,
    subtitle: when,
    detail,
    speech: `${p.filmName}, ${when.replace('·', 'a las')}.` +
      (best ? ` Butacas ${best.replace(/-/g, ' ')}.` : ''),
    url,
    repeat: 3,
  });
}

/**
 * Varios hallazgos en el mismo ciclo: UN aviso con la lista, no uno por función.
 *
 * Pasa siempre en el primer ciclo (que avisa de todo lo que ya está bien) y en
 * los recordatorios de `--remind-every`. Con el canal `dialog` eso eran siete
 * ventanas modales apiladas cuando el bot arrancaba, que además de molesto hacía
 * que el aviso importante se perdiera entre las otras seis.
 *
 * `open` abre sólo la primera: siete pestañas de navegador tampoco sirven.
 */
function alertHits(hits, o) {
  if (hits.length === 1) return alertHit(hits[0], o);

  const channels = [...o.channels];
  if (o.open && !channels.includes('open')) channels.push('open');

  const seatTxt = ({ seatInfo }) => (seatInfo
    ? ` — butacas ${seatInfo.runs[0].seats.map((s) => s.id).join(' + ')}`
    : '');
  const shown = hits.slice(0, 6).map((h) => `${prettyWhen(h.p)}${seatTxt(h)}`);
  if (hits.length > 6) shown.push(`…y ${hits.length - 6} más`);

  // `rows` es la lista elegible: cada fila abre SU función. `detail` es el mismo
  // contenido en texto plano, para el banner y la voz, que no tienen lista.
  const rows = hits.map((h) => ({
    label: `${prettyWhen(h.p)}${o.showVenue ? `  ·  ${h.p.cinemaName}` : ''}` +
      `${seatTxt(h)}`,
    url: h.url,
  }));

  // La nota va en el prompt (arriba de la lista) y no en cada fila: es el mismo
  // consejo para todas y repetirlo siete veces sólo ensucia.
  const nota = notaButacas(hits);

  alerts.fire(channels, {
    title: `🎟 ${hits[0].p.filmName} — ${hits.length} funciones con lugar`,
    subtitle: ['Elegí cuál querés ver:', nota].filter(Boolean).join('\n'),
    detail: nota ? [...shown, nota] : shown,
    rows,
    speech: `Hay ${hits.length} funciones con lugar para ${hits[0].p.filmName}.`,
    url: hits[0].url,
    repeat: 3,
  });
}

/** Aviso de funciones recién puestas a la venta. */
function announceNew(fresh, filmName, o) {
  for (const p of fresh) {
    fs.appendFileSync(HITS_FILE,
      `${new Date().toISOString()}  NUEVA FUNCION  ${label(p)}  ${bookingUrl(o.film, p)}\n`);
  }

  console.log('');
  console.log(C.cyan(C.bold('  ╔══════════════════════════════════════════════════════╗')));
  console.log(C.cyan(C.bold(`  ║   ${String(fresh.length).padStart(2)} FUNCIÓN(ES) NUEVA(S) A LA VENTA` .padEnd(53)) + '║'));
  console.log(C.cyan(C.bold('  ╚══════════════════════════════════════════════════════╝')));
  for (const p of fresh) console.log(`  ${label(p)}`);
  console.log(`  ${C.cyan(bookingUrl(o.film, fresh[0]))}`);
  console.log('');

  const first = fresh[0];
  const shown = fresh.slice(0, 6).map((p) =>
    o.showVenue ? `${prettyWhen(p)}  —  ${p.cinemaName}` : prettyWhen(p));
  if (fresh.length > 6) shown.push(`…y ${fresh.length - 6} más`);

  // Igual que los hallazgos: si son varias, la lista es elegible y cada fila
  // abre su función.
  const rows = fresh.map((p) => ({
    label: `${prettyWhen(p)}${o.showVenue ? `  ·  ${p.cinemaName}` : ''}`,
    url: bookingUrl(o.film, p),
  }));

  alerts.fire(o.channels, {
    title: `🆕 ${filmName} — ${fresh.length} función(es) nueva(s)`,
    subtitle: fresh.length > 1
      ? 'Salieron a la venta. Elegí cuál querés ver:'
      : prettyWhen(first),
    detail: shown,
    rows,
    speech: `Salieron ${fresh.length} funciones nuevas de ${filmName}. ` +
      `La primera, ${prettyWhen(first).replace('·', 'a las')}.`,
    url: bookingUrl(o.film, first),
    repeat: 3,
  });
}

// ------------------------------------------------------------- state file ---

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/**
 * Registro de TODAS las funciones vistas alguna vez, sin filtrar. Va aparte de
 * state.json a propósito: state sólo guarda lo que entró por el filtro, así que
 * si cambiás --cinema o --date todo parecería "nuevo". Esto no.
 */
function loadKnown() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8'));
  } catch {
    return null; // null = nunca corrió; se siembra sin avisar
  }
}

/**
 * Detecta funciones que nunca vimos: fechas que recién salen a la venta u
 * horarios agregados. En un cine con entradas escasas ese es el momento bueno,
 * mucho antes de que se libere una butaca suelta.
 */
function diffNew(performances, o) {
  const known = loadKnown();
  const now = {};
  for (const p of performances) {
    now[p.perfId] = `${p.date} ${p.showTime} · ${p.cinemaName} · ${p.format}`;
  }
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(now, null, 2));

  if (known === null) return { seeded: true, fresh: [] }; // primera vez
  const nowBA = nowInBA();
  const fresh = performances.filter((p) =>
    !(p.perfId in known) && matches(p, o, nowBA));
  return { seeded: false, fresh };
}

// ------------------------------------------------------------------- main ---

async function cycle(o, state, cycleNum) {
  const { name, performances } = await getShowtimes(o.film);
  const now = nowInBA();
  let watched = performances.filter((p) => matches(p, o, now));

  // ¿Salieron funciones nuevas a la venta desde el último ciclo?
  if (!o.list) {
    const { seeded, fresh } = diffNew(performances, o);
    if (seeded) {
      console.log(C.dim(`  (primera corrida: registro ${performances.length} funciones como base)`));
    } else if (fresh.length) {
      announceNew(fresh, name, o);
    }
  }

  // ¿Vale la pena nombrar el cine en los avisos? Sólo si hay más de uno.
  o.showVenue = new Set(watched.map((p) => `${p.cinemaName}|${p.format}`)).size > 1;

  if (watched.length > o.maxChecks) {
    console.log(C.yellow(
      `  [!] ${watched.length} funciones coinciden; se revisan las primeras ${o.maxChecks}. ` +
      `Acotá con --cinema/--date/--after o subí --max-checks.`));
    watched = watched.slice(0, o.maxChecks);
  }

  if (o.list) {
    console.log(`\n${C.bold(name)} — ${watched.length} funciones seleccionadas\n`);
    for (const p of watched) console.log(`  ${label(p)}\n    ${C.dim(bookingUrl(o.film, p))}`);
    return { watched, hits: [] };
  }

  const results = await pool(watched, o.concurrency, async (p) => {
    const r = await probe(o.film, p);
    return { p, ...r };
  });

  // Etapa 2: sólo sobre las que pasaron el filtro barato, y en serie — el sitio
  // rechaza sesiones concurrentes ("Ya existe otra ventana abierta").
  const seatOf = new Map();
  if (o.seats > 0 && session) {
    const candidates = results.filter((r) => r.status === AVAILABLE);
    for (const r of candidates) {
      try {
        const info = await seats.inspect(session, o.film, r.p, {
          need: o.seats, price: o.price, rowFrom: o.rowFrom, rowTo: o.rowTo,
          zone: o.zone, adjacent: o.adjacent, includeAccessible: o.includeAccessible,
        });
        seatOf.set(r.p.perfId, info);
        r.status = info.ok ? SEATS_OK : SEATS_NO;
        r.detail = info.ok
          ? info.runs.map((x) => x.seats.map((s) => s.id).join('+')).join(' | ')
          : info.reason;
      } catch (err) {
        if (err instanceof seats.SessionExpired) {
          console.log(C.red(`  [!] sesión vencida — actualizá "cookie" en ${CONFIG_FILE}`));
          console.log(C.red('      etapa 2 desactivada; se sigue avisando por "no agotada".'));
          // Corriendo de fondo nadie mira la consola: hay que avisar fuerte,
          // si no el bot queda medio ciego durante días sin que te enteres.
          alerts.fire(o.channels, {
            title: '⚠️ VoyAlCine — la sesión venció',
            subtitle: 'El chequeo de butacas quedó apagado',
            detail: ['Sigo avisando cuando una función deja de estar agotada.',
              'Para volver a mirar butacas: abrí el menú ./cine → Ajustes.'],
            speech: 'La sesión de voyalcine venció. El chequeo de butacas está desactivado.',
            repeat: 2,
          });
          session = null;
          break;
        }
        r.status = UNKNOWN;
        r.detail = `butacas: ${err.message}`;
      }
      await sleep(700 + Math.floor(Math.random() * 500));
    }
  }

  const goal = o.seats > 0 && session ? SEATS_OK : AVAILABLE;

  const hits = [];
  const porAvisar = [];   // se avisa junto al final del ciclo, no de a uno
  const tally = {};
  for (const r of results) {
    tally[r.status] = (tally[r.status] || 0) + 1;
    const key = String(r.p.perfId);
    const prev = state[key]?.status;

    // Se avisa en la transición a "sirve"; y además en el primer ciclo de cada
    // ejecución, para que arrancar el script te muestre lo que ya está bien
    // ahora en vez de quedarse mudo por lo que quedó en state.json.
    const isNew = prev !== goal;
    const remind = o.remindEvery > 0 && cycleNum % o.remindEvery === 0;
    if (r.status === goal && (isNew || cycleNum === 1 || remind)) {
      const url = bookingUrl(o.film, r.p);
      announce(r.p, url, prev, o, seatOf.get(r.p.perfId));
      hits.push(r);
      porAvisar.push({ p: r.p, url, seatInfo: seatOf.get(r.p.perfId) });
    } else if (!o.quiet && prev && prev !== r.status) {
      console.log(C.dim(`  ~ ${label(r.p)}: ${prev} → ${r.status}` +
        (r.status === SEATS_NO && r.detail ? ` (${r.detail})` : '')));
    }

    state[key] = {
      status: r.status,
      detail: r.detail,
      when: new Date().toISOString(),
      label: label(r.p),
      url: bookingUrl(o.film, r.p),
    };
  }
  saveState(state);

  if (porAvisar.length) alertHits(porAvisar, o);

  const summary = Object.entries(tally)
    .map(([k, v]) => {
      const paint = (k === AVAILABLE || k === SEATS_OK) ? C.green
        : (k === SOLD_OUT || k === SEATS_NO) ? C.red : C.yellow;
      return paint(`${k} ${v}`);
    })
    .join('  ');
  console.log(`  ${C.dim(stamp())}  ${watched.length} funciones →  ${summary || C.dim('nada que revisar')}`);

  return { watched, hits };
}

async function main() {
  const o = parseArgs(process.argv);

  try {
    o.channels = alerts.parseChannels(o.alert);
  } catch (err) {
    console.error(C.red(`\n${err.message}\n`));
    process.exit(1);
  }

  if (o.testAlert) {
    alerts.selfTest(o.channels);
    return;
  }

  const state = loadState();

  if (o.seats > 0) {
    let cfg = null;
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
      console.error(C.red(`\n--seats necesita una sesión logueada y no encuentro ${CONFIG_FILE}.`));
      console.error(`Creá el archivo así:\n\n  {\n    "cookie": "clientId=...; ASP.NET_SessionId=..."\n  }\n`);
      console.error('Sacá esos valores de DevTools → Application → Cookies con la sesión abierta.\n');
      process.exit(1);
    }
    if (!cfg.cookie || !/ASP\.NET_SessionId=/i.test(cfg.cookie)) {
      console.error(C.red(`\n${CONFIG_FILE} no tiene una cookie con ASP.NET_SessionId.\n`));
      process.exit(1);
    }
    session = new seats.Session(cfg.cookie);
  }

  console.log(C.bold('\nvoyalcine-bot'));
  console.log(C.dim(`  film ${o.film} · intervalo ${o.interval}s · concurrencia ${o.concurrency}` +
    (o.cinemas ? ` · cines ${[...o.cinemas].join(',')}` : '') +
    (o.formats ? ` · formato /${o.formats.source}/` : '') +
    (o.dates ? ` · fechas ${[...o.dates].join(',')}` : '')));
  if (o.seats > 0) {
    console.log(C.dim(`  butacas: ${o.seats}× "${o.price}"${o.adjacent ? ' juntas' : ''} · ` +
      `filas ${o.rowFrom}-${o.rowTo} desde la pantalla · zona ${o.zone}`));
  }
  console.log(C.dim(`  avisos: ${o.channels.join(', ') || 'ninguno'}` +
    (o.remindEvery ? ` · recordatorio cada ${o.remindEvery} ciclos` : '')));
  console.log(C.dim(`  estado: ${STATE_FILE}`));
  console.log(C.dim('  Ctrl+C para salir\n'));

  let running = true;
  process.on('SIGINT', () => {
    console.log(C.dim('\n  detenido.\n'));
    running = false;
    process.exit(0);
  });

  let backoff = 0;
  let cycleNum = 0;
  while (running) {
    try {
      const { hits } = await cycle(o, state, ++cycleNum);
      backoff = 0;
      if (o.once || o.list) return;
      if (hits.length && o.open) return; // browser abierto, no seguir pisando
    } catch (err) {
      backoff = Math.min(backoff ? backoff * 2 : 30, 600);
      console.log(C.red(`  ${stamp()}  error: ${err.message} — reintento en ${backoff}s`));
      await sleep(backoff * 1000);
      continue;
    }
    // jitter the interval so the polling pattern isn't perfectly periodic
    await sleep((o.interval + Math.floor(Math.random() * 10)) * 1000);
  }
}

main().catch((err) => {
  console.error(C.red(`fatal: ${err.stack || err.message}`));
  process.exit(1);
});
