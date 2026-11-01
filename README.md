# mtg_3d

Simulador web de Magic: The Gathering para dos jugadores, con mesa 3D, motor de reglas fiel a las Comprehensive Rules y servidor autoritativo.

Proyecto de fans, no oficial y sin ánimo de lucro. Magic: The Gathering y sus imágenes son propiedad de Wizards of the Coast. Los datos e imágenes de cartas proceden de Scryfall bajo sus condiciones de uso.

**Diseño completo:** [Análisis técnico (Fase A)](https://claude.ai/artifact/9mMpbxFAsEbEUucPQntZ2U) · decisiones en [`docs/adr/`](docs/adr/) · reglas cubiertas en [`docs/rules-coverage.md`](docs/rules-coverage.md) · incidencias en [`docs/issues-log.md`](docs/issues-log.md).

## Estado

| Fase | Estado |
| --- | --- |
| A — Base del proyecto | Hecho |
| D1 — Núcleo del motor | Hecho: turnos, prioridad, pila, combate, acciones basadas en estado, mulligan |
| E1 — Esqueleto jugable | Hecho: salas con código, servidor autoritativo, proyección por jugador, reconexión, auto-pase, interfaz 2D de depuración |
| D2a/D2b — Reglas | Hecho: 12 palabras clave, disparadas, activadas, estáticas, fichas, contadores, planeswalkers, tierras dobles y de choque, leyendas; 55 cartas |
| B — Biblioteca (Scryfall) | Hecho: `pnpm cards:sync` importa todo Scryfall; búsqueda por filtros en `/api/cards` ([ADR 0002](docs/adr/0002-catalogo-en-memoria.md)) |
| C — Constructor de mazos | Hecho: búsqueda con filtros, explorador de expansiones, impresiones, añadir con clic o arrastrando, banquillo, curva y colores, validación por formato, importar/exportar lista, duplicar/borrar. Indica qué cartas no puede jugar aún el motor. Los mazos se guardan en este navegador (pasan al servidor en la fase G) |
| F — Mesa 3D | Hecho: React Three Fiber, animación de cambios de zona, combate visible, cartas usables resaltadas, vista previa al pasar el ratón, cámaras jugador/cenital, respaldo 2D ([ADR 0003](docs/adr/0003-mesa-3d.md)) |
| D3a — Cartas del meta | Hecho: aterrizaje, búsqueda de tierras, costes de sacrificar/exiliar, afinidad, tierras extra; 7 cartas de Mono-Green Landfall |
| G — Persistencia | Hecho: con `DATABASE_URL` las partidas sobreviven a reinicios (se repiten sus entradas, [ADR 0004](docs/adr/0004-persistencia-por-repeticion.md)); abandono a los 15 min; salas inactivas se borran a las 6 h. Los mazos siguen en el navegador |
| H — Despliegue | Hecho: imagen Docker, `docker compose --profile app`, guía con tres opciones ([docs/deploy.md](docs/deploy.md)); la CI construye y prueba la imagen. Falta elegir alojamiento (D6) |
| D3b — Más cartas del meta | Hecho: warp, tierra-bending, disparadas retardadas y reflejas, capas 4 y 7b; más cartas del mazo nº 1 de Standard |
| D3c — Auras y más | Hecho: auras, luchar, objetivos opcionales, exiliar desde cementerios; más cartas del meta |
| D3d — Mazo del meta completo | Hecho: flashback, doble cara, sagas, vigilar, vehículos. **Mono-Green Landfall (nº 1 de Standard) se juega con sus 60 cartas** |
| Siguiente | Más mazos del meta (Dimir Midrange, Izzet Spellementals) |

## Jugar ya

**Sin instalar nada:** https://vyxode.github.io/mtg_3d/ (GitHub Pages; uno crea la sala y le pasa el código al otro; [cómo funciona](docs/deploy.md#0-github-pages-sin-servidor)).

### Con tu propio servidor

Requisitos: Node.js 22 (`.nvmrc`) y pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm build      # compila la web
pnpm start      # servidor de juego + web en http://localhost:3001
pnpm cards:sync # opcional: descarga el catálogo completo de Scryfall (necesita internet)
```

1. Abre `http://localhost:3001`, escribe tu nombre y pulsa **Crear sala**.
2. Pasa el código de 6 letras a tu amigo; él entra en la misma dirección, escribe el código y pulsa **Unirse**.
3. Cada uno elige un mazo predefinido o uno suyo de «Mis mazos» (solo con cartas que el motor ya implementa).

Para jugar desde otro ordenador, tu amigo necesita llegar a tu puerto 3001: misma red local (usa tu IP en vez de `localhost`) o un túnel como Cloudflare Tunnel. Para un servidor permanente, mira [docs/deploy.md](docs/deploy.md).

El servidor pasa la prioridad por ti cuando no puedes hacer nada útil; marca **Control total** para recibirla en todos los pasos.

## Desarrollo

```sh
pnpm dev        # servidor (3001) + web con recarga en caliente (5173)
pnpm check      # tipos + lint + tests unitarios, de reglas e integración
pnpm e2e        # dos navegadores Chrome reales juegan el primer turno
cp .env.example .env && pnpm db:up   # PostgreSQL 16: con DATABASE_URL las partidas sobreviven a reinicios
```

## Estructura

```
apps/
  server/    Node + Socket.IO: salas, autoridad de la partida, proyecciones; sirve la web compilada
  web/       React + Vite: vestíbulo, sala, constructor de mazos, mesa 3D (`src/table/`) y mesa 2D de respaldo
packages/
  engine/    motor de reglas puro: sin React, Three.js, red, base de datos ni APIs de Node
  cards/     definiciones de cartas (DSL), mazos predefinidos y tests de reglas con cartas reales
  protocol/  mensajes cliente-servidor validados con Zod
e2e/         pruebas con dos navegadores
infra/       docker-compose
docs/        decisiones (ADR), cobertura de reglas e incidencias
```

La pureza del motor no es una convención: ESLint rechaza cualquier import prohibido en `packages/engine`.
