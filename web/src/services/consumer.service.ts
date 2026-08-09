import { httpJson } from './api';
import type { ConsumerStatus } from './types';

export function getConsumer(): Promise<ConsumerStatus> {
  return httpJson<ConsumerStatus>('/consumer');
}
