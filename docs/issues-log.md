# Registro de incidencias

Problemas encontrados y su solución, más recientes primero.

| Fecha | Problema | Solución |
| --- | --- | --- |
| 2026-11-01 | Sin salida a Scryfall no se puede comprobar que sus imágenes lleguen a WebGL con CORS. | La mesa 3D muestra el nombre de la carta si la imagen no carga; si en producción fallase, añadir un proxy con caché en el servidor ([ADR 0003](adr/0003-mesa-3d.md)). |
| 2026-11-01 | En la mesa 3D se resaltaban cartas «jugables» que no se podían pagar (las acciones legales no comprueban el maná). | El panel de prioridad y la mesa usan la misma función `usableActions`, que filtra con el pago automático. |
| 2026-11-01 | Una carta que cambia de zona recibe id nuevo; si la posición antigua se borraba al desmontar, la nueva no podía animarse desde allí. | Las posiciones se podan después del commit de React, no al desmontar. |
| 2026-11-01 | El entorno de desarrollo en la nube no tiene salida a Scryfall (el proxy bloquea api.scryfall.com y cards.scryfall.io). | La importación masiva a PostgreSQL (B2) se ejecutará en una máquina con internet. Mientras, la web pide imágenes por nombre al endpoint de Scryfall y muestra el nombre si no cargan. |
| 2026-11-01 | El pago automático giraba Llanowar Elves antes que un Bosque para pagar {G}. Lo detectó su test. | Ordenar las fuentes (tierras primero) antes de cubrir los símbolos de color. |
| 2026-11-01 | Un commit de D1 se subió con 4 errores de lint porque el comando no se detenía ante el fallo de `pnpm check`. | Corregido en el commit siguiente; los commits se encadenan ahora solo tras `pnpm check` en verde. |
| 2026-11-01 | `structuredClone` no existe en la librería ES pura del motor. | Copia por JSON: el estado tiene que ser JSON igualmente (red y persistencia). |
| 2026-11-01 | TypeScript 7.0 (última versión) no está soportado por typescript-eslint 8.72, que exige TypeScript < 6.1. | Fijado TypeScript 6.0.3. Revisar cuando typescript-eslint soporte TS 7. |
