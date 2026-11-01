# Despliegue

El servidor sirve la web y el juego por un solo puerto (3001). PostgreSQL es opcional: sin él las partidas viven en memoria y se pierden al reiniciar.

La elección de alojamiento sigue abierta (decisión D6). Estas son las formas que funcionan hoy.

## 0. GitHub Pages, sin servidor

Cada vez que se sube algo a `main`, el flujo `.github/workflows/pages.yml` publica la web en `https://<usuario>.github.io/<repositorio>/`. Hay que activarlo una vez: en el repositorio, **Settings → Pages → Build and deployment → Source: GitHub Actions**.

En esta versión no hay servidor de juego: quien crea la sala ejecuta la partida en su propio navegador (el mismo código del servidor) y su amigo se conecta directamente a él por WebRTC. El servidor público de PeerJS solo presenta a los dos navegadores.

Limitaciones:
- El anfitrión debe dejar la pestaña abierta. Si recarga la página, la partida se recupera desde su navegador y su amigo se reconecta solo.
- El navegador del anfitrión tiene el estado completo de la partida (también la mano del rival). La interfaz no lo enseña, pero alguien que abra las herramientas de desarrollo podría verlo: es para jugar entre amigos que confían el uno en el otro. Para partidas a prueba de trampas, usa el servidor (opciones 2 y 3).
- Sin catálogo completo de Scryfall: el constructor de mazos busca entre las cartas implementadas.
- Algunas redes muy restrictivas (NAT simétrica, redes corporativas) no permiten la conexión directa entre navegadores.

## 1. En tu ordenador, para jugar con un amigo

```bash
pnpm install && pnpm build && pnpm start      # http://localhost:3001
```

Tu amigo necesita llegar a tu puerto 3001: en la misma red, con tu IP local (`http://192.168.x.x:3001`); por internet, con un túnel como `cloudflared tunnel --url http://localhost:3001`, que da una dirección HTTPS temporal sin abrir puertos en el router.

## 2. Un servidor propio (VPS) con Docker

```bash
cp .env.example .env              # cambia POSTGRES_PASSWORD
docker compose -f infra/docker-compose.yml --env-file .env --profile app up -d --build
```

Arranca PostgreSQL y la aplicación (`infra/Dockerfile`); las partidas sobreviven a reinicios. Para HTTPS, pon delante un proxy inverso; con Caddy basta un `Caddyfile` así (Caddy pide el certificado solo):

```
tu-dominio.com {
  reverse_proxy localhost:3001
}
```

Catálogo completo de Scryfall (una vez y cuando quieras actualizarlo; se guarda en `data/`):

```bash
docker compose -f infra/docker-compose.yml --env-file .env --profile app run --rm app node_modules/.bin/tsx src/sync-cards.ts
```

## 3. Una plataforma que construya la imagen (Railway, Render, Fly.io…)

- Imagen: `infra/Dockerfile`, con el contexto en la raíz del repositorio.
- Variables: `DATABASE_URL` (la de su PostgreSQL gestionado), `PORT` si la plataforma lo impone.
- Comprobación de salud: `GET /api/status`.
- El catálogo de Scryfall necesita un volumen persistente montado en `/app/data`.
- Una sola instancia: las salas viven en la memoria del proceso (ADR 0001, sin Redis en v1).

## Qué comprueba la integración continua

El trabajo `docker` de `.github/workflows/ci.yml` construye la imagen, la arranca con PostgreSQL, y comprueba `/api/status`, que se sirve la web y que la base de datos conecta.
