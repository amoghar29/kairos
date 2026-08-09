import { httpJson } from './api';
import type { Worker } from './types';

export function getWorkers(): Promise<Worker[]> {
  return httpJson<Worker[]>('/workers');
}
