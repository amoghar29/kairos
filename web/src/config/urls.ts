// Empty default → relative URLs → calls hit the same origin the SPA was served from, which is
// what happens once the Go binary serves the bundle itself. For `npm run dev` the API lives on
// :8000 with CORS enabled, so web/.env sets VITE_API_BASE_URL=http://localhost:8000.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';
export const API_URL = `${API_BASE_URL}/v1`;
