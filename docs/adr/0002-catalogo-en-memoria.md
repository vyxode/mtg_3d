# ADR 0002 — Catálogo de cartas en memoria

- Fecha: 2026-11-01
- Estado: aceptada (cambia el diseño del análisis, sección 7)

## Contexto

El análisis preveía guardar el catálogo de Scryfall en PostgreSQL y buscar con índices GIN y trigramas. Son unas 30.000 cartas Oracle; además, el entorno de desarrollo no puede ejecutar Docker ni llegar a Scryfall.

## Decisión

- `pnpm cards:sync` descarga el archivo masivo *Default Cards* de Scryfall, lo procesa línea a línea y escribe `data/catalog.json` (una entrada por carta Oracle con todas sus impresiones) y `data/sets.json`. No descarga nada si Scryfall no ha publicado una versión nueva.
- El servidor carga el catálogo en memoria y lo sirve en `/api/cards`, `/api/cards/:oracleId`, `/api/sets` y `/api/status`.
- Las impresiones solo digitales (Alchemy) se excluyen.
- PostgreSQL sigue previsto para usuarios, mazos compartidos y el registro de partidas (fase G).

## Consecuencias

- Buscar en memoria cuesta milisegundos y no requiere otro servicio.
- El servidor usa unos cientos de MB más de memoria; aceptable para un servidor de dos jugadores.
- Sin sintaxis de búsqueda tipo Scryfall: filtros estructurados (nombre, texto, tipo, colores, identidad, valor de maná, F/R, set, rareza, formato).
