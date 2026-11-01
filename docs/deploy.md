# Despliegue

El servidor sirve la web y el juego por un solo puerto (3001). PostgreSQL es opcional: sin él las partidas viven en memoria y se pierden al reiniciar.

La elección de alojamiento sigue abierta (decisión D6). Estas son las tres formas que funcionan hoy.

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
