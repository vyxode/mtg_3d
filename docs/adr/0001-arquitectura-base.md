# ADR 0001 — Arquitectura base

- Fecha: 2026-11-01
- Estado: aprobada
- Referencia: [Análisis técnico (Fase A)](https://claude.ai/artifact/9mMpbxFAsEbEUucPQntZ2U)

## Decisiones

1. **Monorepo pnpm** con `apps/*` (web, server) y `packages/*` (engine, cards, card-data, deck, protocol, test-utils).
2. **Motor de reglas propio en TypeScript**, puro y determinista: `step(estado, respuesta) → { estado, eventos, decisión pendiente }`. El RNG con semilla vive en el estado.
3. **Servidor autoritativo** (Node + Fastify + Socket.IO). Los clientes solo responden a decisiones y reciben su proyección del estado.
4. **Cobertura de cartas (D1 = a):** DSL tipado propio, cartas escritas y probadas a mano. Se reevalúa importar definiciones de Forge (GPL-3.0) al final de la fase D2.
5. **Cartas no implementadas (D2):** modo estricto por defecto; modo asistido opcional, aceptado por ambos jugadores y marcado en el registro.
6. **Orden de fases (D3):** A → D1 + B1 → E1 (esqueleto jugable 2D) → D2 → B2 + C → F (3D) → D3 → G → H.
7. **Sin Redis en v1 (D4):** estado en memoria + registro de entradas en PostgreSQL.
8. **Formato por defecto (D5):** casual construido, mínimo 60, máximo 4 copias, banquillo de 15, cualquier set.
9. **Alojamiento (D6):** pendiente hasta la fase H.

## Consecuencias

- La regla de dependencias del motor se aplica con ESLint (`no-restricted-imports`).
- Turborepo queda aplazado: con un solo paquete `pnpm -r` basta; se añade cuando haya varios paquetes y la caché compense.
