# multi-llm-proxy

OpenAI-compatible HTTP proxy unifying Claude (Anthropic OAuth Max), Codex (ChatGPT Plus OAuth), and Gemini (Google OAuth GCA) behind one endpoint.

Drop-in successor to `claude-app`. Same port (3456) and endpoint shape (`/v1/chat/completions`, `/v1/vision`, `/v1/models`, …) — adds:

- **Per-backend process pool** (warm CLI workers, no spawn-per-call)
- **Backpressure** — bounded queue per backend, returns `429 + Retry-After` when full
- **Detailed `/health`** — `pool_size`, `in_flight`, `queue_depth`, `p50_latency_ms`, `p95_latency_ms` per backend
- **Per-API-key rate limits** — `apiKeys[].rpm` overrides default
- **Client-cancel support** — closing the HTTP connection aborts the in-flight backend call
- **Idempotency-Key** — duplicate POSTs within 5 min return cached response
- **Prometheus `/metrics`**
- **Image content cache** (MD5-hash) for vision requests

## Quick start

```bash
pnpm install            # or: npm install
cp .env.example .env
cp config.example.json config.json
# Edit config.json (apiKeys), .env (Telegram, optional)

# One-time backend logins
claude /login
codex login --device-auth
gemini                  # then Google OAuth

# Dev
pnpm dev                # tsx watch

# Prod
pnpm build && pnpm start:prod
# or with PM2
pm2 start ecosystem.config.cjs
```

Default port `3456`. Live API guide at `GET /guide`.

## Project layout

```
src/
├── main.ts              # entrypoint
├── server.ts            # Fastify factory
├── config/              # zod-validated config + runtime patches
├── backends/            # per-backend adapters + generic pool
│   ├── pool.ts          # BackendPool<Worker> with stats
│   ├── registry.ts      # model alias → backend routing
│   ├── claude/          # SDK + CLI + OAuth refresh
│   ├── codex/           # CLI + OAuth refresh
│   └── gemini/          # CLI + OAuth refresh
├── routes/              # HTTP endpoints (one file per route)
├── middleware/          # auth, rate-limit, idempotency, cancel
├── adapters/            # OpenAI ↔ internal message format
└── lib/                 # primitives: logger, lru, ring-buffer, image-store, …
```

To add a new backend: create `src/backends/<name>/`, implement `BackendAdapter`, register in `backends/registry.ts`.

## Scripts

- `pnpm dev` — watch mode (tsx)
- `pnpm typecheck` — strict TS check
- `pnpm test` — Vitest
- `pnpm bench` — reproduce concurrency benchmark
- `pnpm migrate` — copy `config.json` + `data/` from `../claude-app`

## License

Private use only.
