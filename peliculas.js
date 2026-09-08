'use strict';

/**
 * Ayudante para el menú (`cine`): traduce la API de VoyAlCine a líneas que bash
 * pueda leer sin parsear JSON.
 *
 *   node peliculas.js list        -> "<id>\t<nombre>" de todas las películas
 *   node peliculas.js info <id>   -> CLAVE=valor con lo que hay a la venta
 *
 * Sin dependencias (fetch nativo, Node >= 18). Nunca tira excepción cruda: si
 * la API no responde, imprime ERROR=... y sale con 1, que es lo que el menú
 * sabe mostrar.
 */

const API = 'https://api.voyalcine.net';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

async function getJson(path) {
  const res = await fetch(API + path);
  if (!res.ok) throw new Error(`la API respondió ${res.status}`);
  const text = await res.text();
  if (!text.trim()) throw new Error('la API respondió vacío');
  return JSON.parse(text);
}

async function list() {
  const films = await getJson('/films');
  const seen = new Set();
  for (const f of films) {
    if (!f || !f.id || !f.name || seen.has(f.id)) continue;
    seen.add(f.id);
    // El nombre va sin tabs ni saltos: bash corta por tab.
    console.log(`${f.id}\t${String(f.name).replace(/\s+/g, ' ').trim()}`);
  }
}

/** "2026-09-08" + "19:05" -> "lunes 8 de septiembre · 19:05" */
function pretty(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${d} de ${MESES[m - 1]}${time ? ` · ${time}` : ''}`;
}

async function info(id) {
  const tree = await getJson(`/films/${id}/tree/showcase`);
  const days = Object.keys(tree.days || {}).sort();
  const formats = new Set();
  const cinemas = new Map();
  let perfs = 0;
  let first = null;

  for (const date of days) {
    for (const cinema of tree.days[date] || []) {
      cinemas.set(cinema.id, cinema.name);
      for (const fmt of cinema.formats || []) {
        formats.add(fmt.formatDescription);
        for (const p of fmt.performances || []) {
          perfs++;
          if (!first) first = pretty(date, p.showTime);
        }
      }
    }
  }

  const fmts = [...formats];
  console.log(`NAME=${tree.name || `película ${id}`}`);
  console.log(`DAYS=${days.length}`);
  console.log(`PERFS=${perfs}`);
  console.log(`IMAX=${fmts.some((f) => /imax/i.test(f)) ? 1 : 0}`);
  console.log(`SUBS=${fmts.some((f) => /subtitul/i.test(f)) ? 1 : 0}`);
  console.log(`DUB=${fmts.some((f) => /dobl/i.test(f)) ? 1 : 0}`);
  console.log(`FORMATS=${fmts.join(' | ')}`);
  // "id:nombre" separado por " | ": el menú necesita el id para --cinema.
  console.log(`CINEMAS=${[...cinemas].map(([id, name]) => `${id}:${name}`).join(' | ')}`);
  console.log(`NCINEMAS=${cinemas.size}`);
  console.log(`FIRST=${first || ''}`);
}

const [cmd, arg] = process.argv.slice(2);

(async () => {
  if (cmd === 'list') await list();
  else if (cmd === 'info' && arg) await info(arg);
  else {
    console.log('uso: node peliculas.js list | info <id>');
    process.exit(2);
  }
})().catch((err) => {
  console.log(`ERROR=${err.message}`);
  process.exit(1);
});
