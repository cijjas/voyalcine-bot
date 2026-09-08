#!/bin/bash
#
# Instala voyalcine-bot como LaunchAgent: arranca solo al iniciar sesión,
# se reinicia si se cae, y sigue vivo aunque cierres la terminal.
#
#   ./install-daemon.sh                 # instalar
#   ./install-daemon.sh --uninstall     # sacarlo
#   ./install-daemon.sh --status        # ver si está corriendo
#   ./install-daemon.sh --logs          # seguir el log en vivo
#   ./install-daemon.sh --print-args    # ver con qué argumentos arrancaría
#
# Normalmente no hace falta tocar esto: usá el menú (./cine), que escribe
# ajustes.conf y llama a este script. Lo de abajo son los valores por defecto
# para cuando ajustes.conf no existe.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="net.voyalcine.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
LOG="$DIR/watch.out"

CONF="$DIR/ajustes.conf"

# --- qué vigila y cada cuánto -------------------------------------------------
# Defaults; ajustes.conf (que escribe ./cine) los sobreescribe.
# 300s = 5 min. Ver el README para por qué no menos.
FILM=5875
SOLO_IMAX=0
FORMAT=""
CINEMAS=""
INTERVAL=300
ALERT="bell,sound,dialog"
SEATS=0            # 0 = no mirar butacas (no necesita sesión/cookie)
ROWS=""
ZONE=""
PRICE=""
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"

# Traduce los ajustes a los flags de watch.js. Un solo lugar, así el menú y el
# daemon no pueden quedar desincronizados.
build_args() {
  ARGS=(--film "$FILM")
  [ "${SOLO_IMAX:-0}" = "1" ] && ARGS+=(--imax)
  [ -n "${FORMAT:-}" ]  && ARGS+=(--format "$FORMAT")
  [ -n "${CINEMAS:-}" ] && ARGS+=(--cinema "$CINEMAS")
  if [ "${SEATS:-0}" -gt 0 ]; then
    ARGS+=(--seats "$SEATS")
    [ -n "${ROWS:-}" ]  && ARGS+=(--rows "$ROWS")
    [ -n "${ZONE:-}" ]  && ARGS+=(--zone "$ZONE")
    [ -n "${PRICE:-}" ] && ARGS+=(--price "$PRICE")
  fi
  ARGS+=(--interval "${INTERVAL:-300}" --alert "${ALERT:-bell,sound,dialog}" --quiet)
}
build_args
# ------------------------------------------------------------------------------

case "${1:-}" in
  --uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "desinstalado."
    exit 0
    ;;
  --status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
      echo "corriendo:"
      launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid|last exit" | head -5
    else
      echo "no está instalado ni corriendo."
    fi
    exit 0
    ;;
  --logs)
    tail -f "$LOG"
    exit 0
    ;;
  --print-args)
    printf '%s\n' "${ARGS[@]}"
    exit 0
    ;;
esac

if [ -z "$NODE" ]; then
  echo "no encuentro node en el PATH." >&2
  exit 1
fi

# La ruta de node queda grabada en el plist. Si es de nvm, desaparece el día que
# desinstalés esa versión y el daemon muere sin decir nada: launchd sólo lo
# reintenta y falla. Avisar es más honesto que elegir otro node por atrás, que
# podría ser más viejo que el que estás usando.
case "$NODE" in
  */.nvm/*)
    echo "ojo: node viene de nvm ($NODE)."
    echo "     Si borrás esa versión de node, el arranque automático deja de"
    echo "     funcionar en silencio. Reinstalá el daemon después de cambiar de"
    echo "     versión: ./cine off && ./cine on"
    echo
    ;;
esac

# Sólo el chequeo de butacas necesita sesión. Antes esto se exigía siempre, así
# que la instalación fallaba aunque no estuvieras mirando butacas.
if [ "${SEATS:-0}" -gt 0 ] && [ ! -f "$DIR/config.json" ]; then
  echo "El chequeo de butacas (SEATS=$SEATS) necesita $DIR/config.json." >&2
  echo "Poné SEATS=0 en ajustes.conf, o cargá la sesión desde ./cine → Ajustes." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents"

# construir el bloque <string> de argumentos
ARGS_XML=""
for a in "${ARGS[@]}"; do
  ARGS_XML="$ARGS_XML
      <string>$a</string>"
done

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/watch.js</string>$ARGS_XML
  </array>

  <key>WorkingDirectory</key>
  <string>$DIR</string>

  <!-- arranca al iniciar sesión y se levanta solo si se cae -->
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>

  <key>StandardOutPath</key>
  <string>$LOG</string>
  <key>StandardErrorPath</key>
  <string>$LOG</string>

  <!-- Sin <ProcessType>Background</ProcessType> a propósito: en el dominio gui
       launchd rechaza el job con EX_CONFIG (78) y nunca llega a arrancar.
       Igual no lo queremos: le bajaría la prioridad de I/O a un proceso que
       tiene que disparar avisos en la sesión gráfica. -->
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "instalado: $PLIST"
echo "argumentos: ${ARGS[*]}"
echo

# Verificar que de verdad arrancó. launchctl bootstrap devuelve 0 aunque el job
# después muera, así que sin este chequeo un fallo pasa desapercibido y te
# quedás días creyendo que te está vigilando.
sleep 3
STATE="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk -F'= ' '/^\tstate = /{print $2; exit}')"
EXIT_CODE="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | awk -F'= ' '/last exit code/{print $2; exit}')"

if [ "$STATE" = "running" ]; then
  echo "✓ corriendo (state=$STATE)"
else
  echo "✗ NO está corriendo: state=${STATE:-desconocido}, last exit=${EXIT_CODE:-?}" >&2
  echo "  Revisá el log: $LOG" >&2
  echo "  Y el estado completo: launchctl print gui/$(id -u)/$LABEL" >&2
  exit 1
fi
echo
echo "  ./install-daemon.sh --status     ver estado"
echo "  ./install-daemon.sh --logs       seguir el log"
echo "  ./install-daemon.sh --uninstall  sacarlo"
echo
echo "Corre en tu sesión gráfica, así que los avisos se ven."
echo "Ojo: si la Mac se suspende, no chequea hasta que despierte."
