# Registro de incidencias

Problemas encontrados y su solución, más recientes primero.

| Fecha | Problema | Solución |
| --- | --- | --- |
| 2026-11-01 | El entorno de desarrollo en la nube no tiene salida a Scryfall (el proxy bloquea api.scryfall.com y cards.scryfall.io). | La importación masiva a PostgreSQL (B2) se ejecutará en una máquina con internet. Mientras, la web pide imágenes por nombre al endpoint de Scryfall y muestra el nombre si no cargan. |
| 2026-11-01 | El pago automático giraba Llanowar Elves antes que un Bosque para pagar {G}. Lo detectó su test. | Ordenar las fuentes (tierras primero) antes de cubrir los símbolos de color. |
| 2026-11-01 | Un commit de D1 se subió con 4 errores de lint porque el comando no se detenía ante el fallo de `pnpm check`. | Corregido en el commit siguiente; los commits se encadenan ahora solo tras `pnpm check` en verde. |
| 2026-11-01 | `structuredClone` no existe en la librería ES pura del motor. | Copia por JSON: el estado tiene que ser JSON igualmente (red y persistencia). |
| 2026-11-01 | TypeScript 7.0 (última versión) no está soportado por typescript-eslint 8.72, que exige TypeScript < 6.1. | Fijado TypeScript 6.0.3. Revisar cuando typescript-eslint soporte TS 7. |
