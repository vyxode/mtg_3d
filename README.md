# mtg_3d

Simulador web de Magic: The Gathering para dos jugadores, con mesa 3D, motor de reglas fiel a las Comprehensive Rules y servidor autoritativo.

Proyecto de fans, no oficial y sin ánimo de lucro. Magic: The Gathering y sus imágenes son propiedad de Wizards of the Coast. Los datos e imágenes de cartas proceden de Scryfall bajo sus condiciones de uso.

**Diseño completo:** [Análisis técnico (Fase A)](https://claude.ai/artifact/9mMpbxFAsEbEUucPQntZ2U) · decisiones en [`docs/adr/`](docs/adr/) · incidencias en [`docs/issues-log.md`](docs/issues-log.md).

## Estado

| Fase | Estado |
| --- | --- |
| A — Base del proyecto | En curso |
| D1 — Núcleo del motor | Generador aleatorio determinista hecho |
| Resto | Pendiente |

## Requisitos

- Node.js 22 (`.nvmrc`) y pnpm 10 (`corepack enable`)
- Docker, para PostgreSQL

## Puesta en marcha

```sh
pnpm install
cp .env.example .env   # cambia la contraseña
pnpm db:up             # PostgreSQL 16 en localhost
pnpm check             # tipos + lint + tests
```

## Estructura

```
apps/        aplicaciones (web, server) — se crean en sus fases
packages/
  engine/    motor de reglas puro: sin React, Three.js, red, base de datos ni APIs de Node
infra/       docker-compose
docs/        decisiones (ADR) e incidencias
```

La pureza del motor no es una convención: ESLint rechaza cualquier import prohibido en `packages/engine`.
