import { useSearchParams } from 'react-router-dom';

import type { JobState } from '@/services/types';
import type { JobsFilter } from '@/utils/route';

// /jobs' own filter state, read out of the URL's query string so filters are shareable/back-
// button-able. Path params (job/worker id) come from react-router's useParams instead.
export function useJobsFilter(): JobsFilter {
  const [searchParams] = useSearchParams();
  return {
    states: searchParams.getAll('state') as JobState[],
    queue: searchParams.get('queue') ?? '',
    offset: Number.parseInt(searchParams.get('offset') ?? '0', 10) || 0,
  };
}
