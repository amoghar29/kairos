# Kairos operator dashboard

React + Vite + Tailwind implementation of the Kairos design mockup. Standalone app — nothing in
the Go build references it yet.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /v1 to localhost:8080
npm run build      # -> dist/
npm run typecheck
```

## Layout

Mirrors the LeastAction frontend conventions, minus the parts this app is too small to need.
`@/` aliases `src/`.

| Directory        | Holds                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `src/services`   | `api.ts` transport + one `*.service.ts` per resource, `types.ts`, barrel |
| `src/config`     | environment-derived values (`urls.ts`)                                   |
| `src/constants`  | tuning knobs, queue registry, job-state lists, colour tokens             |
| `src/contexts`   | providers (`StatusContext` — shared poll clock and connection health)    |
| `src/hooks`      | one hook per file                                                        |
| `src/utils`      | pure helpers (formatting, badge styles, href builders)                   |
| `src/screens`    | one screen per route                                                     |
| `src/components` | shared presentational pieces                                             |

## Data sources

Every screen calls the real API through [`src/services`](src/services) — there is no mock or
fixture layer. The backend serves only part of what the design needs
([`../changes_req.md`](../changes_req.md) lists the gap), so Overview, Workers, and Consumer
currently render an `ErrorPanel` until `GET /v1/queues`, `GET /v1/workers`, and consumer
visibility land on the Go side.

| Page                        | Source today                                                   |
| --------------------------- | -------------------------------------------------------------- |
| Jobs, job detail, Submit    | live `/v1/jobs…`                                               |
| Overview, Workers, Consumer | live, but the endpoint doesn't exist yet — renders as an error |

## Notes

- **One shared 3s poll**, paused while the tab is hidden. A failed refresh keeps the last good
  rows and raises the "connection lost" banner rather than blanking the page.
- **Queue names live in [`src/constants/index.ts`](src/constants/index.ts)** and must track
  `consumer.yaml` until `GET /v1/queues` exists.
- The API base URL comes from `VITE_API_BASE_URL` ([`src/config/urls.ts`](src/config/urls.ts)),
  defaulting to `http://localhost:8000`. Set it empty to go same-origin once Go serves the bundle.
- Design tokens stay in [`src/styles/industry.css`](src/styles/industry.css); `src/styles/app.css`
  maps them into Tailwind's theme under separate names, since Tailwind's `@theme` and the design
  system both write to `:root`.
