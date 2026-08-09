import { httpJson } from './api';
import type { QueueStats } from './types';

// Not yet served by internal/api/routes.go — see changes_req.md. The call fails with a 404
// ApiError until the backend grows the endpoint; the screens already render that via ErrorPanel.
export function getQueues(): Promise<QueueStats[]> {
  return httpJson<QueueStats[]>('/queues');
}
