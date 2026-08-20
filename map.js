#!/usr/bin/env node
'use strict';

/**
 * Imprime el mapa de butacas de una función en la terminal, para verificar a
 * ojo lo que decidió el bot.
 *
 *   node map.js --perf 568054 --cinema 18 --date 2026-08-25 --show 86868A
 *   node map.js --perf 568054 --cinema 18 --date 2026-08-25 --show 86868A --rows 4-8
 */

const fs = require('node:fs');
const path = require('node:path');
const seats = require('./seats');

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  inv: (s) => `\x1b[7m${s}\x1b[0m`,
};

const o = { film: 5875, need: 2, price: 'General', zone: 'middle', rowFrom: 1, rowTo: 99 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  const next = () => process.argv[++i];
  if (a === '--film') o.film = Number(next());
  else if (a === '--perf') o.perfId = Number(next());
  else if (a === '--cinema') o.cinemaId = Number(next());
  else if (a === '--date') o.date = next();
  else if (a === '--show') o.showId = next();
  else if (a === '--seats') o.need = Number(next());
  else if (a === '--price') o.price = next();
  else if (a === '--zone') o.zone = next();
  else if (a === '--rows') {
    const m = String(next()).match(/^(\d+)\s*[-:]\s*(\d+)$/);
    o.rowFrom = Number(m[1]); o.rowTo = Number(m[2]);
  }
}
if (!o.perfId || !o.cinemaId || !o.date || !o.showId) {
  console.error('uso: node map.js --perf <id> --cinema <id> --date YYYY-MM-DD --show <showId> [--rows 4-8]');
  process.exit(1);
}

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  const session = new seats.Session(cfg.cookie);
  const info = await seats.inspect(session, o.film, o, {
    need: o.need, price: o.price, rowFrom: o.rowFrom, rowTo: o.rowTo, zone: o.zone, adjacent: true,
  });

  if (!info.layout) {
    console.log(C.red(`sin mapa: ${info.reason}`));
    return;
  }

  const { blocks, middle } = info.layout;
  const inZone = (c) => c >= middle.from && c <= middle.to;

  // reconstruir la grilla para dibujarla
  const q = `filmid=${o.film}&perf=${o.perfId}&cinema=${o.cinemaId}&date=${o.date}&show=${o.showId}`;
  await session.go(`https://www.voyalcine.net/showcase/pelicula.aspx?${q}`);
  const r = await session.go('https://www.voyalcine.net/showcase/entradas.aspx');
  const { hit } = seats.findPriceSelect(r.body, o.price);
  const form = {};
  for (const m of r.body.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const n = m[0].match(/name="([^"]+)"/); const v = m[0].match(/value="([^"]*)"/);
    if (n) form[n[1]] = v ? v[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"') : '';
  }
  for (const m of r.body.matchAll(/<select name="([^"]+)"/g)) form[m[1]] = '0';
  form[hit.name] = String(o.need);
  form.__EVENTTARGET = 'ctl00$Contenido$btnContinue';
  const r2 = await session.go('https://www.voyalcine.net/showcase/entradas.aspx', {
    method: 'POST',
    body: new URLSearchParams(form).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://www.voyalcine.net' },
  });
  const grid = seats.parseGrid(r2.body);

  const width = Math.max(...grid.flatMap((row) => row.seats.map((s) => s.col))) + 1;
  console.log('');
  console.log('  ' + C.bold(' P A N T A L L A '.padStart(Math.floor(width / 2) + 9)));
  console.log('');
  for (const row of grid) {
    const cells = new Array(width).fill(' ');
    for (const s of row.seats) {
      const glyph = s.state === seats.SEAT_FREE ? C.green('O')
        : s.state === seats.SEAT_TAKEN ? C.dim('x')
        : s.state === seats.SEAT_PICKED ? C.cyan('*')
        : C.dim('·');
      cells[s.col] = s.state === seats.SEAT_FREE && inZone(s.col) ? C.inv(C.green('O')) : glyph;
    }
    const want = row.index >= o.rowFrom && row.index <= o.rowTo;
    const tag = `${String(row.index).padStart(2)} ${row.letter}`;
    console.log(`${want ? C.bold(tag) : C.dim(tag)} ${cells.join('')}${want ? C.dim('  ←') : ''}`);
  }
  console.log('');
  console.log(C.dim(`  bloques: ${blocks.map((b) => `${b.from}-${b.to}`).join('  ')}   ` +
    `medio = ${middle.from}-${middle.to}`));
  console.log(C.dim(`  O libre   x ocupada   · no disponible   invertido = zona "${o.zone}"`));
  console.log(`  libres en la sala: ${info.totalFree}`);
  console.log(info.ok
    ? C.green(`  MATCH: ${info.runs.map((x) => x.seats.map((s) => s.id).join('+')).join('  |  ')}`)
    : C.red(`  sin match: ${info.reason}`));
  console.log('');
})();
