# ADR 0004 — Persistencia de partidas por repetición de entradas

**Estado:** aceptada · 2026-11-01

## Contexto

Las salas vivían en memoria: un reinicio del servidor perdía todas las partidas. Queremos que sobrevivan sin acoplar el motor a la base de datos.

## Decisión

- Cada sala se guarda en PostgreSQL como un registro JSON (`rooms.data`): asientos, semilla del motor y **la lista de entradas aplicadas**, incluidos los pases automáticos.
- Al arrancar, el servidor reconstruye cada partida con `createGame(semilla, mazos)` y repite las entradas con `step`. El motor es determinista (RNG con semilla, sin relojes), así que el estado es idéntico; hay un test que lo comprueba.
- Los tokens de asiento se guardan como SHA-256: una copia de la base de datos no permite ocupar un asiento.
- Las escrituras van en cola, una tras otra, para que una foto antigua nunca pise a una nueva.
- Sin `DATABASE_URL`, todo sigue en memoria (desarrollo).
- Barrido cada minuto: quien está desconectado 15 minutos durante una partida mientras el rival espera, concede; las salas sin nadie conectado durante 6 horas se borran.

## Consecuencias

- Cambiar la definición de una carta puede hacer que una partida guardada ya no se pueda repetir; esa sala se descarta al arrancar (se registra el error).
- Se reescribe el registro completo en cada entrada (decenas de KB por partida). Si las partidas crecen mucho, pasar a una tabla de entradas solo de añadir.
- Si el servidor cae entre una entrada y su guardado, esa entrada se pierde.
- Los tests usan PGlite (PostgreSQL compilado a WebAssembly), porque el entorno de desarrollo no tiene Docker.
