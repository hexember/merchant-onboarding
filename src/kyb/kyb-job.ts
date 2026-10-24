// The KYB check job contract shared by the producer (KybCheckQueue) and the worker
// (KybCheckProcessor). docs/adrs/kyb-check.md fixes the job ID format and the retry options, so
// they are constants here, not env settings.
import { isUUID } from 'class-validator';

export const KYB_CHECK_QUEUE = 'kyb-check';
export const KYB_CHECK_JOB_NAME = 'kyb-check';

// Retry policy from docs/adrs/kyb-check.md: 5 attempts with exponential backoff from 2 s.
export const KYB_JOB_ATTEMPTS = 5;
export const KYB_JOB_BACKOFF = { type: 'exponential', delay: 2000 } as const;

// Retention, so finished jobs do not pile up in Redis. Completed jobs are kept 7 days and failed
// jobs 30 days (for debugging). The job-ID dedupe only holds while the job is kept; a later add with
// the same ID is still harmless because the worker's stale check and the unique constraint skip it.
export const KYB_JOB_REMOVE_ON_COMPLETE = { age: 7 * 24 * 3600 } as const;
export const KYB_JOB_REMOVE_ON_FAIL = { age: 30 * 24 * 3600 } as const;

// `actor_label` of every audit row the worker writes (actor_type SYSTEM).
export const KYB_WORKER_LABEL = 'kyb-worker';

export interface KybCheckJobData {
  applicationId: string;
  submissionNo: number;
}

/**
 * `kyb-check:{applicationId}:{submissionNo}`. BullMQ dedupes on the job ID, so a second enqueue
 * for the same submission is a no-op (the first of the three idempotency layers).
 */
export function kybCheckJobId(applicationId: string, submissionNo: number): string {
  return `kyb-check:${applicationId}:${submissionNo}`;
}

/**
 * Narrows raw job data: a plain object with a UUID `applicationId` and an integer
 * `submissionNo >= 1`. Anything else returns `null` (a retry could never fix it).
 */
export function parseKybCheckJobData(data: unknown): KybCheckJobData | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const { applicationId, submissionNo } = data as Record<string, unknown>;
  if (typeof applicationId !== 'string' || !isUUID(applicationId)) {
    return null;
  }
  if (typeof submissionNo !== 'number' || !Number.isInteger(submissionNo) || submissionNo < 1) {
    return null;
  }
  return { applicationId, submissionNo };
}
