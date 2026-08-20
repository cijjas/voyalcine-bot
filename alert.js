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
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  if (onExit) child.on('exit', onExit);
  child.unref();
  return child;
}

const MAC = process.platform === 'darwin';
const SOUND = '/System/Library/Sounds/Glass.aiff';
const CHANNELS = ['bell', 'sound', 'notify', 'say', 'dialog', 'open'];
const DEFAULT = ['bell', 'sound', 'notify'];

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

function notify({ title, subtitle, message }) {
  if (!MAC) return;
  const parts = [`display notification "${as(message)}"`, `with title "${as(title)}"`];
  if (subtitle) parts.push(`subtitle "${as(subtitle)}"`);
  parts.push('sound name "Glass"');
  detached('osascript', ['-e', parts.join(' ')]);
}

function say(text) {
  if (!MAC) return;
  detached('say', [String(text)]);
}

/**
 * Ventana modal. A diferencia de la notificación, esto siempre se ve.
 * Se lanza en segundo plano para no frenar el ciclo; si tocás "Abrir",
 * abre la URL de la función.
 */
function dialog({ title, subtitle, message, url }) {
  if (!MAC) return;
  // `display dialog` no tiene subtítulo: si no lo pegamos acá, se pierde.
  const body = subtitle && !String(message).includes(subtitle)
    ? `${subtitle}\n\n${message}`
    : message;
  const script = url
    ? `set r to button returned of (display dialog "${as(body)}" with title "${as(title)}" ` +
      `buttons {"Cerrar", "Abrir"} default button "Abrir" with icon note giving up after 300)\n` +
      `if r is "Abrir" then open location "${as(url)}"`
    : `display dialog "${as(body)}" with title "${as(title)}" buttons {"OK"} ` +
      `default button "OK" with icon note giving up after 300`;
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
      else if (c === 'notify') notify(payload);
      else if (c === 'say') say(payload.speech || payload.message);
      else if (c === 'dialog') dialog(payload);
      else if (c === 'open') openUrl(payload.url);
    } catch (err) {
      console.error(`  [!] canal de alerta "${c}" falló: ${err.message}`);
    }
  }
}

/**
 * Comprueba que los avisos realmente se vean. Dispara uno de prueba por cada
 * canal y además revisa si el permiso de notificaciones está otorgado, que es
 * el motivo habitual de "no me llega nada".
 */
function selfTest(channels) {
  console.log(`\nProbando canales: ${channels.join(', ')}\n`);

  if (!MAC) {
    console.log('  No es macOS: sólo `bell` y `open` van a funcionar.\n');
  }

  if (MAC && channels.includes('notify')) {
    let enabled = null;
    try {
      const out = execFileSync('defaults', ['read', 'com.apple.ncprefs', 'apps'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      // flags impares con el bit 0 en 0 = banners apagados para ese bundle
      const m = out.match(/"com\.apple\.ScriptEditor2"[\s\S]{0,400}?flags = (\d+)/);
      if (m) enabled = (Number(m[1]) & 0x1000) !== 0 || (Number(m[1]) & 0x2) !== 0;
    } catch { /* no pasa nada, es sólo un diagnóstico */ }

    console.log('  notify → osascript "display notification"');
    console.log('    Ojo: macOS lo descarta EN SILENCIO si no está el permiso.');
    console.log('    Si no ves el banner: Ajustes del Sistema → Notificaciones →');
    console.log('    Script Editor (y tu terminal) → Permitir notificaciones.');
    if (enabled === false) console.log('    Diagnóstico: parece DESACTIVADO para Script Editor.');
    console.log('    Si no querés depender de eso, usá --alert dialog,sound.\n');
  }

  // Payload realista: así ves exactamente cómo se va a leer el aviso de verdad.
  fire(channels, {
    title: '🎟️  La Odisea — hay lugar  (PRUEBA)',
    subtitle: 'Martes 25 de agosto · 13:05',
    message: [
      'Martes 25 de agosto · 13:05',
      'Butacas D-21 + D-20  ·  fila 4',
    ].join('\n'),
    speech: 'Prueba. La Odisea, martes 25 de agosto a las 13:05.',
    url: 'https://www.voyalcine.net/showcase/pelicula.aspx?filmId=5875',
    repeat: 2,
  });

  console.log('  Disparado. Deberías haber notado:');
  for (const c of channels) {
    const what = {
      bell: 'una campanita en la terminal',
      sound: 'el sonido Glass (x2)',
      notify: 'un banner de notificación',
      say: 'una voz',
      dialog: 'una ventana con botones Cerrar/Abrir',
      open: 'el navegador abriéndose',
    }[c];
    console.log(`    - ${c.padEnd(7)} ${what}`);
  }
  console.log('\n  Lo que no hayas notado, ese canal no te sirve. Elegí con --alert.\n');
}

module.exports = { fire, selfTest, parseChannels, CHANNELS, DEFAULT };
