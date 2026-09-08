# Instrucciones para un asistente

<!-- AGENTS.md es un symlink a este archivo: Claude Code lee CLAUDE.md y Codex
     lee AGENTS.md, y así los dos ven lo mismo sin copiar el contenido. -->

Si alguien te pidió "instalame esto para que me avise cuando haya entradas",
seguí esto. Asumí que **no** usa la terminal y no va a querer aprender: dejale
todo andando y contale en dos líneas qué hacer.

## No corras `./cine` a secas

Es un menú interactivo: se queda esperando que alguien conteste. Usá los
comandos sin preguntas:

```bash
./cine buscar odisea          # -> "5875<TAB>La Odisea"   (busca por nombre)
./cine cines 5875             # -> "14<TAB>Showcase Belgrano"  (id de cada cine)
./cine configurar --film 5875 --cine 14 --minutos 5 --activar
./cine estado                 # ¿está vigilando?
./cine probar                 # dispara un aviso de prueba
./cine off                    # desactivar
./cine borrar-todo            # saca todo de la computadora (pide confirmación)
```

`configurar` valida contra la API: si el film id no existe, o el cine no
proyecta esa película, falla y te dice por qué en vez de dejar un daemon
corriendo para siempre sin encontrar nada.

## Receta

1. **Node ≥ 18.** `node -v`. Si falta, instalalo (`brew install node`, o el
   instalador de [nodejs.org](https://nodejs.org)) antes de seguir.
2. **Qué película.** Si te dijeron el nombre, `./cine buscar <nombre>`. Si te
   pasaron un link de voyalcine.net, el film id está en la URL
   (`pelicula.aspx?filmid=5875`). Si hay varias parecidas, preguntá cuál.
3. **Qué cine.** `./cine cines <film-id>` y preguntale en cuál va — son cines de
   todo el país y avisarle de uno a 700 km no le sirve. Si sólo le interesa
   IMAX, usá `--imax` y no hace falta `--cine`.
4. **Configurar y activar** en un solo paso, con `--activar`.
5. **Probar el aviso**: `./cine probar`. Preguntale si vio la ventana y escuchó
   el sonido. Si no vio nada, revisá el volumen; la ventana no depende de
   ningún permiso de macOS, así que siempre se ve.
6. **Contale sólo esto**: que tiene un acceso **VoyAlCine** en el Escritorio
   para abrir el menú, que la opción **1** prende y apaga, y que la **9** borra
   todo. Nada más.

## Lo que hay que avisarle

- **La Mac tiene que estar prendida y despierta.** Suspendida no revisa nada.
- **No compra la entrada.** Avisa y abre la página; pagar es cosa suya.
- Sigue andando con la terminal cerrada y después de reiniciar.

## Cosas que no valen la pena

- **No toques `--seats`** (el chequeo del mapa de butacas) salvo que la persona
  sepa sacar cookies de DevTools: necesita una sesión logueada en
  `config.json`, se vence sola, y es una credencial. Sin eso el bot igual sirve:
  avisa cuando una función deja de estar agotada.
- **No bajes el intervalo de 2 minutos.** Las butacas no se liberan cada 30
  segundos; sólo carga el sitio.
- **No edites `ajustes.conf` a mano** si podés usar `./cine configurar`: valida
  y resuelve los nombres para mostrarlos lindo.

Detalle de cómo funciona por dentro: [TECNICO.md](TECNICO.md).
