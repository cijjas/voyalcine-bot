# 🎟 VoyAlCine

**Te avisa en cuanto aparece un lugar para la película que querés ver.**

Las funciones buenas se agotan. Cuando alguien cancela o el cine libera butacas,
vuelven a aparecer lugares — pero por poco tiempo y sin que nadie te avise. Este
programa mira la página cada 5 minutos y te avisa apenas pasa.

No hay que saber nada de computación. Son tres preguntas y listo.

---

## 1. Instalarlo (una sola vez)

Abrí la **Terminal**: apretá `⌘ + barra espaciadora`, escribí `terminal` y Enter.

Copiá esta línea entera, pegala ahí y apretá Enter:

```
git clone https://github.com/cijjas/voyalcine-bot.git ~/voyalcine-bot && cd ~/voyalcine-bot && ./cine
```

Eso es todo. Se abre solo y te pregunta:

1. **¿Qué película?** — escribís parte del nombre y elegís de una lista
2. **¿En qué cine?** — elegís de una lista
3. **¿Cómo te aviso?** — con Enter alcanza

Y arranca.

> **Si te pide instalar "herramientas de desarrollo"**, aceptá y esperá: es de
> Apple, tarda unos minutos, y después volvé a pegar la misma línea.
>
> **Si te dice que falta Node.js**, te ofrece abrir la página de descarga. Bajás
> el instalador de macOS, doble clic, Siguiente hasta el final, y volvés a
> abrir el programa. Es gratis y no toca nada de tu Mac.

---

## 2. Usarlo

**Te queda un acceso `VoyAlCine` en el Escritorio: doble clic y se abre el
menú.** (O en la Terminal: `cd ~/voyalcine-bot` y `./cine`.)

```
  🎟  VoyAlCine  ·  te aviso cuando hay lugar
  ────────────────────────────────────────────

   ● ACTIVADO   te aviso cuando haya lugar

   Película  La Odisea
   Filtro    Showcase Belgrano · reviso cada 5 min
   Avisos    ventana en pantalla + sonido

   1  Desactivar
   2  Ver estado y actividad
   3  Probar los avisos
   4  Ver qué encontró
   5  Ajustes (película, avisos, frecuencia)
   9  Borrar todo de la computadora
   0  Salir
```

Elegís un número y Enter. Nada más.

### Activar y desactivar

La opción **1** prende y apaga. Es lo único importante:

| Arriba dice | Qué significa |
|---|---|
| ● **ACTIVADO** | está mirando. Te va a avisar. |
| ○ **DESACTIVADO** | no está mirando. No te va a avisar de nada. |

**Activado sigue funcionando aunque cierres la Terminal y aunque reinicies la
Mac.** No hace falta dejar ninguna ventana abierta.

Salir del menú con **0** *no* lo desactiva — sigue mirando en segundo plano. Eso
es a propósito.

---

## 3. Cuando encuentra algo

Aparece una ventana en el medio de la pantalla, con sonido.

**Si hay una sola función**, te la muestra directo:

```
  ┌────────────────────────────────────────┐
  │  🎟 La Odisea — hay lugar              │
  │                                        │
  │  Martes 25 de agosto · 13:05           │
  │                                        │
  │  Showcase Belgrano · 2D-Subtitulado    │
  │  Ya no está agotada                    │
  │                                        │
  │            [ Cerrar ]  [ Ver entradas ]│
  └────────────────────────────────────────┘
```

**Si hay varias**, te llega **un solo aviso** con la lista, y cada línea abre esa
función:

```
  ┌────────────────────────────────────────────────────┐
  │  🎟 La Odisea — 7 funciones con lugar              │
  │                                                    │
  │  Elegí cuál querés ver:                            │
  │  ┌──────────────────────────────────────────────┐  │
  │  │ 1.  Martes 8 de septiembre · 18:30           │  │
  │  │ 2.  Martes 8 de septiembre · 19:00           │  │
  │  │ 3.  Martes 8 de septiembre · 22:00           │  │
  │  │ 4.  Miércoles 9 de septiembre · 15:25        │  │
  │  │ 5.  Miércoles 9 de septiembre · 18:30        │  │
  │  └──────────────────────────────────────────────┘  │
  │                                                    │
  │                    [ Cerrar ]  [ Ver entradas ]    │
  └────────────────────────────────────────────────────┘
```

Marcás la que te interesa y **"Ver entradas"** abre el navegador justo en esa
función — no en la página general. **De a una por vez**: abrir seis pestañas de
compra juntas no ayuda a comprar ninguna.

Nunca te llegan siete avisos seguidos: uno por vez, con todo adentro.

Si además está prendido el chequeo de butacas (la [etapa 2](TECNICO.md), sólo
para IMAX), el aviso agrega:

> Butacas aceptables para IMAX, igual intentaría sacar de la fila H para arriba.

La compra la hacés vos, como siempre: el programa avisa, no compra ni paga nada.
La ventana de una sola función espera 30 minutos por si estabas lejos de la compu.

Para ver cómo se ve y se escucha antes de que pase de verdad, usá la opción
**3 · Probar los avisos**.

> **Si el aviso no te llega**, probá la opción 3 y subí el volumen. La ventana no
> depende de ningún permiso de macOS, así que siempre se ve. (El globo de
> notificación de arriba a la derecha sí depende de un permiso, y macOS lo tapa
> sin avisar — por eso no viene puesto por defecto.)

---

## 4. Borrar todo

Opción **9** del menú. Te pide escribir `BORRAR` para confirmar y saca todo:

- el arranque automático
- los ajustes, el historial y los archivos que fue creando
- el acceso del Escritorio
- la carpeta del programa entera, si le decís que sí

No queda nada dando vueltas. Lo único que **no** borra es Node.js, porque no lo
instaló este programa y puede que lo use otra cosa en tu Mac.

También sirve desde la Terminal: `./cine borrar-todo`

---

## Preguntas

**¿Tengo que dejar la computadora prendida?**
Sí. Y despierta: mientras la Mac está suspendida no puede mirar nada. Si la
cerrás toda la noche, a la mañana sigue sola donde quedó.

**¿Me compra la entrada?**
No. Te avisa y te abre la página. Comprar es cosa tuya.

**¿Le pide mi contraseña o mi tarjeta a alguien?**
No. Para avisarte cuando una función deja de estar agotada no necesita ninguna
cuenta: mira la página pública, igual que si la abrieras vos.

**¿Le pega mucho al sitio del cine?**
No. Con un cine elegido son unas dos docenas de consultas cada 5 minutos, menos
que tener la página abierta y apretar F5 un rato. Por eso el mínimo es 2 minutos:
más seguido no te consigue nada y sólo carga el sitio al vicio.

**¿Puedo vigilar otra película?**
Sí, opción **5 · Ajustes**. Podés cambiar película, cine, frecuencia y avisos
cuando quieras, y se aplica solo.

**¿Y si todavía no hay funciones a la venta?**
Igual sirve, y de hecho es el mejor momento: te avisa apenas salen a la venta,
que suele ser la oportunidad real de conseguir buenos lugares.

**¿Funciona en Windows?**
No. Los avisos usan cosas propias de macOS.

---

## Lo que necesita

- una Mac
- Node.js 18 o más nuevo — si falta, el programa te guía para instalarlo
- internet

Nada más: no instala paquetes, no pide permisos de administrador y no manda tus
datos a ningún lado.

---

## Desde la Terminal

Para quien la prefiera:

```bash
./cine              # menú
./cine on           # activar
./cine off          # desactivar
./cine estado       # ¿está mirando?
./cine probar       # aviso de prueba
./cine borrar-todo  # sacar todo
```

---

## Si te está ayudando alguien (o Claude)

Se puede instalar y dejar andando sin tocar el menú:

```bash
./cine buscar odisea                                  # nombre -> id
./cine cines 5875                                     # cines de esa película
./cine configurar --film 5875 --cine 14 --activar     # configura y arranca
```

Las instrucciones completas para un asistente están en
[CLAUDE.md](CLAUDE.md).

---

## Para curiosos

Hay una **etapa 2** que además mira el mapa de butacas de la sala, para no
avisarte por una butaca suelta en primera fila. Eso sí necesita pegar la sesión
del navegador a mano y es para gente cómoda con la Terminal.

Cómo funciona por dentro, todos los filtros, el lector del mapa de butacas y las
trampas de `launchd` de macOS: **[TECNICO.md](TECNICO.md)**.
