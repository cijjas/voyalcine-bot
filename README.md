# voyalcine-bot

Avisa apenas una función de VoyAlCine deja de responder `agotada`.

## Arranque rápido (cualquier película)

Nada del bot está atado a La Odisea: `5875` es sólo el default de `--film`.
Para vigilar otra película:

1. Abrí la película en [voyalcine.net](https://www.voyalcine.net) y mirá la URL:
   `pelicula.aspx?filmid=6012&...` → el film id es `6012`.
2. Verificá que el árbol de funciones exista:
   `curl https://api.voyalcine.net/films/6012/tree/showcase`
3. Corré el bot con ese id:

```bash
node watch.js --film 6012 --list # ver qué funciones matchean
node watch.js --film 6012        # vigilar
```

Sin dependencias: sólo hace falta Node ≥ 18 (usa `fetch` nativo).

Fechas y horarios nuevos se detectan solos (salen de la API en cada ciclo).
Para dejarlo fijo corriendo, editá `ARGS` en `install-daemon.sh` (agregá
`--film 6012`) y reinstalá el daemon.

## El truco

El botón *Continuar* apunta a:

```
/showcase/pelicula.aspx?filmid=5875&perf=567636&cinema=18&date=2026-08-22&show=86868A
```

Ese endpoint es un oráculo binario limpio — no hace falta login, ni cookies, ni
navegador. Responde con un redirect según la disponibilidad:

| Respuesta                                    | Significado                              |
|----------------------------------------------|------------------------------------------|
| `302 → /showcase/entradas.aspx#heading1`      | **Hay lugar** — pasó el chequeo           |
| `302 → pelicula.aspx?filmId=…&agotada=1`      | Agotada                                   |
| `200` con `alert('Se produjo un error…')`     | El backend no pudo consultar disponibilidad |

El bot usa `HEAD`, así que ni siquiera baja el cuerpo de la respuesta: lee el
header `Location` y listo.

La lista de funciones sale de `api.voyalcine.net/films/<id>/tree/showcase`, o sea
que **fechas y horarios nuevos se detectan solos** — no hay ids hardcodeados.

## Etapa 2 — butacas

"No agotada" no alcanza: puede quedar una butaca suelta en la fila A pegada a la
pantalla. La etapa 2 recorre el flujo real con una sesión logueada:

```
pelicula.aspx?perf=..   fija la función en la sesión
entradas.aspx           grilla de precios -> General = N
POST btnContinue        -> butacas.aspx
butacas.aspx            <table id="ctl00_Contenido_tblMap">
```

Ese mapa es una tabla HTML de verdad, así que cada butaca tiene coordenadas
`(fila, columna)` exactas:

| `src` de la imagen | Estado |
|---|---|
| `AvSeat.jpg` | libre |
| `SoldSeat.jpg` | ocupada |
| `NotAvSeat.jpg` | no disponible |
| `SelSeat.jpg` | seleccionada |
| `HandSeat.jpg` | silla de ruedas |

Una butaca cuenta como agarrable si el `<input>` **no** viene con `disabled`
—la señal que usa la página misma— y es del tipo libre. Las de silla de ruedas
quedan afuera aunque estén libres, salvo que pases `--accessible`.

Las filas se numeran **desde la pantalla** (1 = la de más adelante), y los
bloques de la platea se detectan solos: una columna que casi ninguna fila usa es
un pasillo, y lo que queda entre pasillos son los bloques. Por eso `--zone
middle` sale de la geometría real de la sala y sigue andando en otras salas.

**La etapa 2 sólo lee el mapa. No selecciona butacas ni compra nada.**

### Sesión

`--seats` necesita `config.json` (gitignoreado, `chmod 600`):

```json
{ "cookie": "clientId=...; ASP.NET_SessionId=..." }
```

Sacalo de DevTools → Application → Cookies con la sesión abierta. Si vence, el
bot lo avisa y sigue funcionando en modo etapa 1.

> Esa cookie es una credencial: quien la tenga entra a tu cuenta hasta que
> expire. No la pegues en chats ni la subas a ningún repo.

## Uso

```bash
cd ~/voyalcine-bot

node watch.js --imax --list          # ver qué funciones matchean
node watch.js --imax --once          # un barrido y salir
node watch.js --imax                 # vigilar en loop (cada 90s)
node watch.js --imax --open          # además abre el navegador al encontrar lugar

# con chequeo de butacas: 2 General, juntas, filas 4-8, bloque del medio
node watch.js --imax --seats 2 --rows 4-8 --zone middle

# probá primero que los avisos se vean
node watch.js --test-alert

# vigilancia con aviso imposible de perderse
node watch.js --imax --seats 2 --rows 4-8 --alert sound,dialog,say
```

Ver el mapa de una función en la terminal, para verificar a ojo:

```bash
node map.js --perf 568054 --cinema 18 --date 2026-08-25 --show 86868A --rows 4-8
```

```
              P A N T A L L A

 1 A            ··  ················  ··
 2 B           OOO  OOOOOOOOOOOOOOO  OOO
 3 C          OOOO  OOOOOOOOOOOOOOO  OOOO
 4 D        OOOOxx  OOxxxxxxxxxxxxx  OOOOOO   ←
 5 E       OOOOxxx  xxxxxxxxxxxxxxx  xxxOOOO  ←
 ...
  bloques: 2-12  15-29  32-42   medio = 15-29
  MATCH: D-21+D-20
```

Cuando encuentra disponibilidad: notificación de macOS con sonido, campanita en
la terminal, banner verde, y una línea en `hits.log` con la URL directa.

Solo avisa en la **transición** a disponible. Una función que ya estaba abierta
no vuelve a notificar en cada ciclo.

### Filtros

| Flag | Qué hace |
|---|---|
| `--film <id>` | id de película (default `5875` = La Odisea) |
| `--imax` | solo funciones IMAX |
| `--format <regex>` | filtra `formatDescription`, ej. `--format Subtitulado` |
| `--cinema <ids>` | ids de cine, ej. `--cinema 18,13` |
| `--date <fechas>` | `YYYY-MM-DD` separadas por coma |
| `--after HH:MM` / `--before HH:MM` | ventana horaria |
| `--include-past` | no descartar funciones ya empezadas |

### Butacas

| Flag | Qué hace |
|---|---|
| `--seats <n>` | exigir n butacas libres antes de avisar (activa la etapa 2) |
| `--rows 4-8` | filas contando desde la pantalla (1 = la de adelante) |
| `--zone middle\|left\|right\|any` | bloque de la platea (default `middle`) |
| `--price <etiqueta>` | fila de precio a usar (default `General`) |
| `--anywhere` | no exigir que las butacas estén juntas |
| `--accessible` | incluir butacas de silla de ruedas (por defecto **no**) |

### Avisos

| Flag | Qué hace |
|---|---|
| `--test-alert` | dispara una alerta de prueba y sale |
| `--alert <canales>` | `bell,sound,notify,say,dialog,open` — o `all` / `none` |
| `--remind-every <n>` | re-avisar cada n ciclos mientras el match siga vivo |

Canales:

| Canal | Qué hace | ¿Se ve seguro? |
|---|---|---|
| `bell` | campanita en la terminal | sí |
| `sound` | sonido Glass ×3 | sí |
| `notify` | banner de notificación de macOS | **no** — ver abajo |
| `say` | te lo dice en voz alta | sí |
| `dialog` | ventana con botones Cerrar/Abrir | sí |
| `open` | abre el navegador en la función | sí |

Default: `bell,sound,notify`.

> **El banner de notificación puede no aparecer.** macOS lo descarta en silencio
> si Script Editor no tiene permiso: `osascript` sale con código 0 igual, así
> que no hay forma de detectarlo desde el script. Corré `--test-alert`: lo que
> no veas, ese canal no te sirve.
>
> Para arreglarlo: Ajustes del Sistema → Notificaciones → Script Editor →
> Permitir notificaciones. O evitá el problema con `--alert dialog,sound`, que
> no depende de ningún permiso.

**Al ejecutar el script, el primer ciclo avisa de todo lo que ya está bien**, no
sólo de los cambios. Los ciclos siguientes avisan sólo en la transición, así que
un match que sigue vivo no te spamea. `--remind-every 10` lo recuerda cada 10
ciclos por si te fuiste de la compu.

Las funciones pasadas se descartan usando la hora de Buenos Aires.

### Ejecución

| Flag | Qué hace |
|---|---|
| `--interval <seg>` | segundos entre ciclos (default `90`) |
| `--concurrency <n>` | requests en paralelo (default `4`) |
| `--once` | un solo barrido |
| `--list` | imprime las funciones que matchean y sale |
| `--open` | abre el navegador ante un hallazgo y termina |
| `--quiet` | solo cambios y hallazgos |
| `--max-checks <n>` | tope de funciones por ciclo (default `200`) |

### Ids de cine

| id | Cine |
|---|---|
| 11 | Showcase Haedo |
| 12 | Showcase Córdoba (Villa Cabrera) |
| 13 | Showcase Norcenter |
| 14 | Showcase Belgrano |
| 15 | Showcase Quilmes |
| 16 | Showcase Rosario |
| 17 | Showcase Villa Allende |
| 18 | IMAX Theatre (Norcenter) |

## Archivos

- `state.json` — último estado de cada función (base de la detección de cambios).
  Borralo para que el próximo ciclo re-avise todo lo que esté disponible.
- `hits.log` — histórico de hallazgos con timestamp y URL.

## Dejarlo corriendo

El bot sólo chequea **mientras está corriendo**. Si lo lanzás a mano en una
terminal y la cerrás, se muere y no te avisa más nada.

### Como LaunchAgent (recomendado)

Las rutas quedan grabadas en el plist, así que **si movés el proyecto hay que
reinstalar**: `./install-daemon.sh --uninstall`, mover, y `./install-daemon.sh`
de nuevo desde la ruta nueva.

```bash
./install-daemon.sh              # arranca al iniciar sesión, se revive si se cae
./install-daemon.sh --status     # ver si está vivo
./install-daemon.sh --logs       # seguir el log
./install-daemon.sh --uninstall  # sacarlo
```

Los argumentos se editan en `ARGS`, arriba de `install-daemon.sh`. El padre del
proceso pasa a ser `launchd`, así que sobrevive a cerrar la terminal y a
reiniciar la Mac.

Corre dentro de tu sesión gráfica —no como demonio de sistema— justamente para
que los avisos se vean.

> **No pongas `ProcessType: Background` en el plist.** En el dominio `gui`
> launchd lo rechaza con `EX_CONFIG` (78) y el job nunca arranca —
> `launchctl bootstrap` devuelve 0 igual, así que el fallo es silencioso. Por
> eso `install-daemon.sh` verifica el estado después de instalar.

> **Si la Mac se suspende, no chequea.** launchd no la despierta. Si querés
> cobertura de noche, dejala sin dormir (`caffeinate -s`) o asumí el hueco.

### A mano

```bash
node watch.js --imax --seats 2 --rows 4-8   # Ctrl+C para cortar
```

## Qué dispara un aviso

| Evento | Cuándo |
|---|---|
| **Butacas** | una función pasa a tener n butacas donde las querés |
| **Función nueva** | aparece una función que nunca vimos (fecha nueva a la venta) |
| **Sesión vencida** | la cookie murió y el chequeo de butacas quedó apagado |

Lo de "función nueva" sale de `known.json`, que guarda **todas** las funciones
vistas alguna vez, sin filtrar — va aparte de `state.json` a propósito, porque
`state.json` sólo tiene lo que entró por el filtro y cambiar `--cinema` haría
que todo parezca nuevo. La primera corrida sólo siembra el registro, no avisa.

En un cine con entradas escasas, la fecha nueva saliendo a la venta suele ser la
oportunidad buena — bastante antes de que se libere una butaca suelta.

## Cada cuánto chequear

El default a mano es 90s; el del daemon, **300s (5 min)**. Cuentas para elegir:

| Intervalo | Ciclos/día | Requests/día (~27 funciones) |
|---|---|---|
| 90s | 960 | ~26.000 |
| 300s | 288 | ~7.800 |
| 600s | 144 | ~3.900 |

El backend tarda ~2,5s por request. 5 minutos es de sobra: las butacas no se
liberan cada 90 segundos, y bajar de ahí es cargar el sitio sin ganar nada.

## Estados

| Estado | Significado |
|---|---|
| `AGOTADA` | la función está agotada |
| `DISPONIBLE` | pasó el chequeo (etapa 1, sin `--seats`) |
| `SIN_BUTACAS` | no está agotada, pero no hay lugar donde lo pediste |
| `BUTACAS_OK` | hay n butacas donde las querés — **esto dispara la alerta** |
| `ERROR_BACKEND` | el sitio no pudo consultar disponibilidad |

## Límites

- El bot avisa; **no selecciona butacas ni compra**. La compra sigue siendo
  manual desde el link, con las butacas ya identificadas.
- La etapa 2 va en serie, no en paralelo: el sitio rechaza sesiones concurrentes
  con "Ya existe otra ventana abierta de VoyAlCine.net". Con `--seats`, cada
  función disponible suma ~4 s al ciclo.
- El mapa se lee en el momento; entre el aviso y tu click alguien puede ganarte
  la butaca.
- El backend es lento (~2,5 s por request). Con concurrencia 4, 29 funciones
  tardan ~25 s por ciclo. Acotá con `--cinema` / `--date` si querés ciclos más
  cortos.
- El polling va con jitter y backoff exponencial ante `429`/`5xx`. No bajes
  `--interval` por debajo de ~60 s.
