import { Queue } from 'bullmq';
import * as logger from '../logging/logger';
import {
  KYB_ENQUEUE_FAILED_MESSAGE,
  KYB_ENQUEUE_TIMED_OUT_MESSAGE,
  KYB_ENQUEUE_TIMEOUT_MS,
  KybCheckQueue,
  kybQueueConnection,
} from './kyb-check.queue';
import { KybCheckJobData } from './kyb-job';

// Made-up UUID; not a real record.
const APP_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

type AddFn = Queue<KybCheckJobData>['add'];

function queueWith(add: jest.MockedFunction<AddFn>): Queue<KybCheckJobData> {
  // Only `add` is used by KybCheckQueue; the rest of the Queue surface is not needed.
  return { add } as unknown as Queue<KybCheckJobData>;
}

describe('KybCheckQueue', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(logger, 'logError').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('adds the job with the fixed ID, attempts, backoff and retention and resolves true', async () => {
    const add: jest.MockedFunction<AddFn> = jest.fn();
    add.mockResolvedValue({} as Awaited<ReturnType<AddFn>>);

    await expect(new KybCheckQueue(queueWith(add)).enqueue(APP_ID, 2)).resolves.toBe(true);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      'kyb-check',
      { applicationId: APP_ID, submissionNo: 2 },
      {
        jobId: `kyb-check:${APP_ID}:2`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 604800 },
        removeOnFail: { age: 2592000 },
      },
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('resolves false and logs ids only when add rejects', async () => {
    const add: jest.MockedFunction<AddFn> = jest.fn();
    add.mockRejectedValue(new Error('Connection is closed.'));

    await expect(new KybCheckQueue(queueWith(add)).enqueue(APP_ID, 1)).resolves.toBe(false);

    expect(logError).toHaveBeenCalledTimes(1);
    const [context, message, meta] = logError.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(context).toBe('kyb-queue');
    expect(message).toBe('KYB check could not be enqueued; application stays in RISK_REVIEW');
    expect(message).toBe(KYB_ENQUEUE_FAILED_MESSAGE);
    expect(Object.keys(meta).sort()).toEqual(['applicationId', 'error', 'submissionNo']);
    expect(meta.applicationId).toBe(APP_ID);
    expect(meta.submissionNo).toBe(1);
  });

  it('resolves false after the timeout when add never settles', async () => {
    jest.useFakeTimers();
    const add: jest.MockedFunction<AddFn> = jest.fn();
    add.mockReturnValue(new Promise<never>(() => undefined));

    const result = new KybCheckQueue(queueWith(add)).enqueue(APP_ID, 1);
    await jest.advanceTimersByTimeAsync(KYB_ENQUEUE_TIMEOUT_MS);

    await expect(result).resolves.toBe(false);
    expect(logError).toHaveBeenCalledTimes(1);
    const [context, message, meta] = logError.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(context).toBe('kyb-queue');
    // The add is not cancelled, so the message must not claim the job will never exist.
    expect(message).toBe(
      'KYB check enqueue timed out; the job may still be added when Redis reconnects',
    );
    expect(message).toBe(KYB_ENQUEUE_TIMED_OUT_MESSAGE);
    expect(Object.keys(meta).sort()).toEqual(['applicationId', 'error', 'submissionNo']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the timeout timer after a successful add', async () => {
    jest.useFakeTimers();
    const add: jest.MockedFunction<AddFn> = jest.fn();
    add.mockResolvedValue({} as Awaited<ReturnType<AddFn>>);

    await expect(new KybCheckQueue(queueWith(add)).enqueue(APP_ID, 1)).resolves.toBe(true);

    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('kybQueueConnection', () => {
  it('returns exactly host, port and maxRetriesPerRequest null (offline queue left on)', () => {
    const connection = kybQueueConnection({ REDIS_HOST: 'redis.example.com', REDIS_PORT: 6380 });

    expect(connection).toEqual({
      host: 'redis.example.com',
      port: 6380,
      maxRetriesPerRequest: null,
    });
    expect(connection).not.toHaveProperty('enableOfflineQueue');
  });
});
