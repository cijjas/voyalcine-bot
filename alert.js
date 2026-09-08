'use strict';

/**
 * Sistema de avisos.
 *
 * El problema con `display notification` es que macOS lo descarta en silencio
 * si el binario que lo dispara no tiene permiso de notificaciones: osascript
 * termina con exit 0 y no aparece nada. Por eso acá hay varios canales y uno
 * (`dialog`) abre una ventana real, que no depende de ningún permiso.
 *
 * Canales: bell, sound, notify, say, dialog, open
 */

const { spawn, execFileSync } = require('node:child_process');

/**
 * Lanza un helper sin que nos ate el proceso. Sin `unref`, una ventana modal
 * abierta mantiene vivo el event loop de Node y el script no termina nunca.
 * `onExit` es opcional y sólo se usa para encadenar sonidos.
 */
function detached(cmd, args, onExit) {
  // Con VOYALCINE_DEBUG=<archivo> se guarda lo que escupe el helper. Sin esto un
  // error de AppleScript se pierde: osascript falla, nadie lo ve, y el síntoma
  // es "no me llegó el aviso" sin ninguna pista.
  let stdio = 'ignore';
  const dbg = process.env.VOYALCINE_DEBUG;
  if (dbg) {
    try {
      const fd = require('node:fs').openSync(dbg, 'a');
      stdio = ['ignore', fd, fd];
    } catch { /* si no se puede, seguimos en silencio */ }
  }
  const child = spawn(cmd, args, { stdio, detached: true });
  child.on('error', () => {});
  if (onExit) child.on('exit', onExit);
  child.unref();
  return child;
}

const MAC = process.platform === 'darwin';
const SOUND = '/System/Library/Sounds/Glass.aiff';
const CHANNELS = ['bell', 'sound', 'notify', 'say', 'dialog', 'open'];
// `dialog` en vez de `notify` a propósito: el banner de macOS se descarta en
// silencio si falta el permiso, la ventana siempre se ve. Ver selfTest().
const DEFAULT = ['bell', 'sound', 'dialog'];

/**
 * Escapa para incrustar dentro de un string de AppleScript.
 * Los saltos de línea se convierten al escape \n de AppleScript en vez de
 * aplastarse a espacio, así el diálogo puede tener varias líneas.
 */
const as = (s) => String(s)
  .replace(/[\\"]/g, '\\$&')
  .replace(/\n/g, '\\n');

function parseChannels(spec) {
  if (!spec) return [...DEFAULT];
  const want = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (want.includes('all')) return [...CHANNELS];
  if (want.includes('none')) return [];
  const bad = want.filter((c) => !CHANNELS.includes(c));
  if (bad.length) {
    throw new Error(`canal de alerta desconocido: ${bad.join(', ')}. Válidos: ${CHANNELS.join(', ')}, all, none`);
  }
  return want;
}

function bell() {
  process.stdout.write('\x07');
}

function sound(times = 3) {
  if (!MAC) return;
  // Se agendan de una y quedan ref'd: son ~2s y así el proceso no se va antes
  // de que suenen, que es justo lo que queremos con --once.
  for (let i = 0; i < times; i++) {
    setTimeout(() => detached('afplay', [SOUND]), i * 700);
  }
}

/**
 * Cuerpo del aviso sin repetir lo que ya va en el subtítulo. `detail` son las
 * líneas nuevas; `message` queda como respaldo para llamadas viejas.
 */
function body({ detail, message, subtitle }, sep) {
  const lines = (Array.isArray(detail) ? detail : String(message ?? '').split('\n'))
    .map((l) => String(l).trim())
    .filter((l) => l && l !== subtitle);
  return lines.join(sep);
}

/**
 * Banner de macOS. El banner aplasta los saltos de línea, así que las líneas
 * van separadas por " · ".
 *
 * `silent` llega en true cuando el canal `sound` también está activo: sin eso
 * suenan el Glass del banner y los tres del canal encimados, que es justo lo
 * que hacía que el aviso se escuchara como un ruido raro en vez de una campana.
 */
function notify(payload, silent) {
  if (!MAC) return;
  const parts = [`display notification "${as(body(payload, ' · '))}"`,
    `with title "${as(payload.title)}"`];
  if (payload.subtitle) parts.push(`subtitle "${as(payload.subtitle)}"`);
  if (!silent) parts.push('sound name "Glass"');
  detached('osascript', ['-e', parts.join(' ')]);
}

function say(text) {
  if (!MAC) return;
  detached('say', [String(text)]);
}

/**
 * Ventana modal. A diferencia del banner, esto SIEMPRE se ve: no depende de
 * ningún permiso de notificaciones, que es el motivo por el que es el canal
 * recomendado.
 *
 * Dos formas:
 *
 * - un solo hallazgo  -> `display dialog` con botón "Ver entradas"
 * - varios (`rows`)   -> `choose from list`: una lista donde cada fila es una
 *   función y abre SU función. Es la única lista nativa de macOS con selección,
 *   así que es lo más parecido a una tabla con links que se puede tener sin
 *   escribir una app.
 *
 * `tell me to activate` la trae al frente; sin eso la ventana puede quedar
 * detrás de lo que estés usando y el aviso pasa desapercibido.
 */
function dialog(payload) {
  if (!MAC) return;
  const rows = Array.isArray(payload.rows) ? payload.rows.filter((r) => r && r.label) : [];
  if (rows.length > 1) return dialogList(payload, rows);

  const text = [payload.subtitle, body(payload, '\n')].filter(Boolean).join('\n\n');
  const head = 'tell me to activate\n';
  const url = payload.url || (rows[0] && rows[0].url);
  const script = url
    ? head +
      `set r to button returned of (display dialog "${as(text)}" with title "${as(payload.title)}" ` +
      `buttons {"Cerrar", "Ver entradas"} default button "Ver entradas" with icon note giving up after 1800)\n` +
      `if r is "Ver entradas" then open location "${as(url)}"`
    : head +
      `display dialog "${as(text)}" with title "${as(payload.title)}" buttons {"Entendido"} ` +
      `default button "Entendido" with icon note giving up after 1800`;
  detached('osascript', ['-e', script]);
}

/**
 * Lista elegible: se marca UNA función y abre esa. Sin multi-selección a
 * propósito — abrir seis pestañas de compra a la vez no ayuda a comprar ninguna.
 */
function dialogList(payload, rows) {
  const listOf = (arr) => `{${arr.map((v) => `"${as(v)}"`).join(', ')}}`;
  // El número adelante hace que dos funciones con el mismo texto no se
  // confundan: la fila se busca por texto exacto para saber qué URL abrir.
  const labels = rows.map((r, i) => `${i + 1}.  ${r.label}`);

  const script = [
    'tell me to activate',
    `set filas to ${listOf(labels)}`,
    `set links to ${listOf(rows.map((r) => r.url || ''))}`,
    // Ojo con la gramática: los parámetros booleanos van con `with` y
    // `default items` va SIN `with`. Al revés, osascript falla con -2741 y no
    // se ve ninguna ventana.
    `set elegidas to choose from list filas with title "${as(payload.title)}" ` +
      `with prompt "${as(payload.subtitle || 'Elegí cuál querés ver:')}" ` +
      'default items {item 1 of filas} ' +
      'OK button name "Ver entradas" cancel button name "Cerrar" ' +
      'without multiple selections allowed',
    // `choose from list` devuelve una lista igual con selección simple.
    'if elegidas is not false then',
    '  set eleccion to (item 1 of elegidas) as text',
    '  repeat with i from 1 to count of filas',
    '    if (item i of filas) is eleccion and (item i of links) is not "" then',
    '      open location (item i of links)',
    '      exit repeat',
    '    end if',
    '  end repeat',
    'end if',
  ].join('\n');

  detached('osascript', ['-e', script]);
}

function openUrl(url) {
  if (!url) return;
  detached(MAC ? 'open' : 'xdg-open', [url]);
}

/** Dispara todos los canales pedidos. No lanza: un canal roto no frena el bot. */
function fire(channels, payload) {
  for (const c of channels) {
    try {
      if (c === 'bell') bell();
      else if (c === 'sound') sound(payload.repeat ?? 3);
      else if (c === 'notify') notify(payload, channels.includes('sound'));
      else if (c === 'say') say(payload.speech || payload.message);
      else if (c === 'dialog') dialog(payload);
      else if (c === 'open') openUrl(payload.url);
    } catch (err) {
      console.error(`  [!] canal de alerta "${c}" falló: ${err.message}`);
    }
  }
}

/**
 * Comprueba que los avisos realmente se vean, con el mismo formato que usa un
 * aviso de verdad. Es la respuesta a "no me llegó nada": lo que no notes acá,
 * ese canal no te sirve.
 */
function selfTest(channels) {
  const NOMBRES = {
    bell: 'una campanita en la terminal',
    sound: 'el sonido Glass (2 veces)',
    notify: 'un banner arriba a la derecha',
    say: 'una voz que lo dice en voz alta',
    dialog: 'una ventana con la lista de funciones para elegir',
    open: 'el navegador abriéndose en la película',
  };

  console.log('');
  console.log('  Disparando un aviso de prueba igual a uno de verdad.');
  console.log('  Mirá la pantalla y escuchá los próximos 5 segundos.\n');

  if (!MAC) {
    console.log('  Esto no es una Mac: sólo van a funcionar `bell` y `open`.\n');
  }

  // Se prueba con varias funciones porque es el caso normal: así ves la lista
  // elegible, que es lo que te va a llegar de verdad. Con una sola función el
  // aviso es una ventana más simple, con el botón "Ver entradas".
  const demo = 'https://www.voyalcine.net/showcase/pelicula.aspx?filmId=5875';
  fire(channels, {
    title: '🎟 La Odisea — 3 funciones con lugar  (PRUEBA)',
    subtitle: 'Elegí cuál querés ver:\n' +
      'Butacas aceptables para IMAX, igual intentaría sacar de la fila H para arriba.',
    detail: [
      'Martes 25 de agosto · 13:05',
      'Martes 25 de agosto · 19:30 — butacas D-21 + D-20',
      'Miércoles 26 de agosto · 22:00',
    ],
    rows: [
      { label: 'Martes 25 de agosto · 13:05', url: demo },
      { label: 'Martes 25 de agosto · 19:30 — butacas D-21 + D-20', url: demo },
      { label: 'Miércoles 26 de agosto · 22:00', url: demo },
    ],
    speech: 'Prueba. Hay tres funciones con lugar para La Odisea.',
    url: demo,
    repeat: 2,
  });

  console.log('  Tendrías que haber notado:\n');
  for (const c of channels) {
    console.log(`    ${c.padEnd(7)} ${NOMBRES[c] || c}`);
  }
  if (!channels.length) console.log('    (ninguno: los avisos están apagados)');

  if (MAC && channels.includes('notify')) {
    console.log('\n  Si el banner no apareció, no es un error del programa:');
    console.log('  macOS lo descarta sin avisar cuando falta el permiso.');
    console.log('  Arreglo: Ajustes del Sistema → Notificaciones → Script Editor');
    console.log('  → Permitir notificaciones. O usá la ventana, que siempre se ve.');
  }
  console.log('');
}

module.exports = { fire, selfTest, parseChannels, CHANNELS, DEFAULT };
