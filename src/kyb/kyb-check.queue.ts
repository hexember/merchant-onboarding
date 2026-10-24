import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConnectionOptions, Queue } from 'bullmq';
import { AppEnv } from '../config/env.validation';
import { logError } from '../logging/logger';
import {
  KYB_CHECK_JOB_NAME,
  KYB_CHECK_QUEUE,
  KYB_JOB_ATTEMPTS,
  KYB_JOB_BACKOFF,
  KYB_JOB_REMOVE_ON_COMPLETE,
  KYB_JOB_REMOVE_ON_FAIL,
  KybCheckJobData,
  kybCheckJobId,
} from './kyb-job';

// Upper bound on one enqueue, so a submit request never hangs while Redis is down. Not
// configurable: it only bounds the request, it does not change job behaviour.
export const KYB_ENQUEUE_TIMEOUT_MS = 2000;

// Log messages for a failed enqueue (ids only). Exported so tests assert the exact text.
export const KYB_ENQUEUE_FAILED_MESSAGE =
  'KYB check could not be enqueued; application stays in RISK_REVIEW';
export const KYB_ENQUEUE_TIMED_OUT_MESSAGE =
  'KYB check enqueue timed out; the job may still be added when Redis reconnects';

/**
 * The one Redis connection policy for the KYB queue and its worker (used by
 * `BullModule.forRootAsync`). `maxRetriesPerRequest: null` is required by BullMQ workers.
 * There is deliberately no `enableOfflineQueue: false`: the worker inherits these options and must
 * keep queueing commands through a Redis reconnect, or it would stall jobs. The enqueue timeout
 * above is what bounds a request while Redis is down.
 */
export function kybQueueConnection(
  env: Pick<AppEnv, 'REDIS_HOST' | 'REDIS_PORT'>,
): ConnectionOptions {
  return { host: env.REDIS_HOST, port: env.REDIS_PORT, maxRetriesPerRequest: null };
}

class EnqueueTimeoutError extends Error {
  constructor() {
    super(`Enqueue did not finish within ${KYB_ENQUEUE_TIMEOUT_MS} ms`);
    this.name = 'EnqueueTimeoutError';
  }
}

/** Producer for KYB check jobs (docs/adrs/kyb-check.md). */
@Injectable()
export class KybCheckQueue {
  constructor(@InjectQueue(KYB_CHECK_QUEUE) private readonly queue: Queue<KybCheckJobData>) {}

  /**
   * Enqueues the KYB check for one submission. Call it only after the submit transaction has
   * committed, never inside it. It never rejects: on an error or timeout it logs ids only and
   * returns `false`. That is the documented kyb-check.md trade-off (no outbox): if Redis is down,
   * the request still succeeds. After a rejection the application stays in RISK_REVIEW; after a
   * timeout the pending add may still land when Redis reconnects. A repeated or late call for the
   * same submission is harmless: BullMQ dedupes on the job ID, and the worker skips stale jobs.
   */
  async enqueue(applicationId: string, submissionNo: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new EnqueueTimeoutError()), KYB_ENQUEUE_TIMEOUT_MS);
    });
    try {
      await Promise.race([
        this.queue.add(
          KYB_CHECK_JOB_NAME,
          { applicationId, submissionNo },
          {
            jobId: kybCheckJobId(applicationId, submissionNo),
            attempts: KYB_JOB_ATTEMPTS,
            backoff: KYB_JOB_BACKOFF,
            removeOnComplete: KYB_JOB_REMOVE_ON_COMPLETE,
            removeOnFail: KYB_JOB_REMOVE_ON_FAIL,
          },
        ),
        timeout,
      ]);
      return true;
    } catch (error) {
      // The timeout does not cancel `queue.add`: with the offline queue on, the command stays
      // queued in ioredis and may still add the job once Redis reconnects (harmless, see above).
      const message =
        error instanceof EnqueueTimeoutError
          ? KYB_ENQUEUE_TIMED_OUT_MESSAGE
          : KYB_ENQUEUE_FAILED_MESSAGE;
      logError('kyb-queue', message, { applicationId, submissionNo, error });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
