#!/bin/bash
#
# Instala voyalcine-bot como LaunchAgent: arranca solo al iniciar sesión,
# se reinicia si se cae, y sigue vivo aunque cierres la terminal.
#
#   ./install-daemon.sh                 # instalar con los defaults
#   ./install-daemon.sh --uninstall     # sacarlo
#   ./install-daemon.sh --status        # ver si está corriendo
#   ./install-daemon.sh --logs          # seguir el log en vivo
#
# Los argumentos del bot se editan en ARGS, abajo.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="net.voyalcine.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
LOG="$DIR/watch.out"

# --- qué vigila y cada cuánto -------------------------------------------------
# 300s = 5 min. Ver el README para por qué no menos.
ARGS=(--imax --seats 2 --rows 4-8 --zone middle --interval 300 --alert sound,notify,dialog --quiet)
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
esac

if [ -z "$NODE" ]; then
  echo "no encuentro node en el PATH." >&2
  exit 1
fi

if [ ! -f "$DIR/config.json" ]; then
  echo "falta $DIR/config.json (lo necesita --seats). Ver el README." >&2
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
