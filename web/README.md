# Kairos operator dashboard

React + Vite + Tailwind implementation of the Kairos design mockup. Standalone app — nothing in
the Go build references it yet.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /v1 to localhost:8080
npm run build      # -> dist/
npm run typecheck
```

## Data sources

Every page calls the real API in [`src/api/live.ts`](src/api/live.ts) — there is no mock or
fixture layer. The backend serves only part of what the design needs
([`../changes_req.md`](../changes_req.md) lists the gap), so Overview, Workers, and Consumer
currently render an `ErrorPanel` until `GET /v1/queues`, `GET /v1/workers`, and consumer
visibility land on the Go side.

| Page | Source today |
| --- | --- |
| Jobs, job detail, Submit | live `/v1/jobs…` |
| Overview, Workers, Consumer | live, but the endpoint doesn't exist yet — renders as an error |

## Notes

- **Hash routing** (`#/jobs/<id>`) — the server only ever serves `/`, so embedding this in the
  API later needs no history-API fallback.
- **One shared 3s poll**, paused while the tab is hidden. A failed refresh keeps the last good
  rows and raises the "connection lost" banner rather than blanking the page.
- **Queue names live in [`src/config.ts`](src/config.ts)** and must track `consumer.yaml` until
  `GET /v1/queues` exists.
- Design tokens stay in [`src/styles/industry.css`](src/styles/industry.css); `src/styles/app.css`
  maps them into Tailwind's theme under separate names, since Tailwind's `@theme` and the design
  system both write to `:root`.
