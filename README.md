# multi-llm-proxy

OpenAI-compatible HTTP proxy unifying Claude (Anthropic OAuth Max) and OpenAI models through Codex (ChatGPT Plus OAuth) behind one endpoint.

Drop-in successor to `claude-app`. Same port (3456) and endpoint shape (`/v1/chat/completions`, `/v1/vision`, `/v1/models`, …) — adds:

- **Per-backend process pool** (warm CLI workers, no spawn-per-call)
- **Backpressure** — bounded queue per backend, returns `429 + Retry-After` when full
- **Detailed `/health`** — `pool_size`, `in_flight`, `queue_depth`, `p50_latency_ms`, `p95_latency_ms` per backend
- **Per-API-key rate limits** — `apiKeys[].rpm` overrides default
- **Client-cancel support** — closing the HTTP connection aborts the in-flight backend call
- **Idempotency-Key** — duplicate POSTs within 5 min return cached response
- **Prometheus `/metrics`**
- **Image content cache** (MD5-hash) for vision requests
- **Interactive Codex Agent API** — persistent threads, structured events, approvals, text/image/audio input, steer and interrupt

## Quick start

```bash
pnpm install            # or: npm install
cp .env.example .env
cp config.example.json config.json
# Edit config.json (apiKeys), .env (Telegram, optional)

# One-time backend logins
claude /login
codex login --device-auth

# Dev
pnpm dev                # tsx watch

# Prod
pnpm build && pnpm start:prod
# or with PM2
pm2 start ecosystem.config.cjs
```

Default port `3456`.

- Full API reference: `GET /guide` or `/guide?format=html`
- Vietnamese remote-use guide: `GET /huong-dan` or `/huong-dan?format=html`
- Source file: [`HUONG_DAN_SU_DUNG.md`](HUONG_DAN_SU_DUNG.md)

The normal OpenAI-compatible endpoints remain text completion APIs. For a Codex-like client that can inspect or update an allowed workspace, use the admin-only `/v1/agent/sessions/*` API documented in `/guide` and `/huong-dan`.

## Project layout

```
src/
├── main.ts              # entrypoint
├── server.ts            # Fastify factory
├── agent/               # Codex App Server transport + managed sessions
├── config/              # zod-validated config + runtime patches
├── backends/            # per-backend adapters + generic pool
│   ├── pool.ts          # BackendPool<Worker> with stats
│   ├── registry.ts      # model alias → backend routing
│   ├── claude/          # SDK + CLI + OAuth refresh
│   ├── codex/           # CLI + OAuth refresh
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
