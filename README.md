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
| D2a/D2b — Reglas | Hecho: 12 palabras clave, disparadas, activadas, estáticas, fichas, contadores, planeswalkers, tierras dobles y de choque, leyendas; 55 cartas, 5 mazos |
| B — Biblioteca (Scryfall) | Hecho: `pnpm cards:sync` importa todo Scryfall; búsqueda por filtros en `/api/cards` ([ADR 0002](docs/adr/0002-catalogo-en-memoria.md)) |
| C, F, D3, G, H | Pendiente |

## Jugar ya (interfaz 2D de depuración)

Requisitos: Node.js 22 (`.nvmrc`) y pnpm 10 (`corepack enable`).

```sh
pnpm install
pnpm build      # compila la web
pnpm start      # servidor de juego + web en http://localhost:3001
pnpm cards:sync # opcional: descarga el catálogo completo de Scryfall (necesita internet)
```

1. Abre `http://localhost:3001`, escribe tu nombre y pulsa **Crear sala**.
2. Pasa el código de 6 letras a tu amigo; él entra en la misma dirección, escribe el código y pulsa **Unirse**.
3. Cada uno elige uno de los mazos predefinidos de 60 cartas.

Para jugar desde otro ordenador, tu amigo necesita llegar a tu puerto 3001: misma red local (usa tu IP en vez de `localhost`) o un túnel como Cloudflare Tunnel. El despliegue definitivo es la fase H.

El servidor pasa la prioridad por ti cuando no puedes hacer nada útil; marca **Control total** para recibirla en todos los pasos.

## Desarrollo

```sh
pnpm dev        # servidor (3001) + web con recarga en caliente (5173)
pnpm check      # tipos + lint + tests unitarios, de reglas e integración
pnpm e2e        # dos navegadores Chrome reales juegan el primer turno
cp .env.example .env && pnpm db:up   # PostgreSQL 16 (se usará en la fase B2)
```

## Estructura

```
apps/
  server/    Node + Socket.IO: salas, autoridad de la partida, proyecciones; sirve la web compilada
  web/       React + Vite: vestíbulo, sala y mesa 2D de depuración (la mesa 3D llega en la fase F)
packages/
  engine/    motor de reglas puro: sin React, Three.js, red, base de datos ni APIs de Node
  cards/     definiciones de cartas (DSL), mazos predefinidos y tests de reglas con cartas reales
  protocol/  mensajes cliente-servidor validados con Zod
e2e/         pruebas con dos navegadores
infra/       docker-compose
docs/        decisiones (ADR), cobertura de reglas e incidencias
```

La pureza del motor no es una convención: ESLint rechaza cualquier import prohibido en `packages/engine`.
