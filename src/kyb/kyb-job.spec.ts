import {
  KYB_CHECK_JOB_NAME,
  KYB_CHECK_QUEUE,
  KYB_JOB_ATTEMPTS,
  KYB_JOB_BACKOFF,
  KYB_JOB_REMOVE_ON_COMPLETE,
  KYB_JOB_REMOVE_ON_FAIL,
  KYB_WORKER_LABEL,
  kybCheckJobId,
  parseKybCheckJobData,
} from './kyb-job';

// Made-up UUID; not a real record.
const APP_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

describe('kyb job contract', () => {
  it('pins the queue, job name, retry options and worker label', () => {
    expect(KYB_CHECK_QUEUE).toBe('kyb-check');
    expect(KYB_CHECK_JOB_NAME).toBe('kyb-check');
    expect(KYB_JOB_ATTEMPTS).toBe(5);
    expect(KYB_JOB_BACKOFF).toEqual({ type: 'exponential', delay: 2000 });
    expect(KYB_JOB_REMOVE_ON_COMPLETE).toEqual({ age: 7 * 24 * 3600 });
    expect(KYB_JOB_REMOVE_ON_FAIL).toEqual({ age: 30 * 24 * 3600 });
    expect(KYB_WORKER_LABEL).toBe('kyb-worker');
  });

  it('builds the job ID as kyb-check:{applicationId}:{submissionNo}', () => {
    expect(kybCheckJobId(APP_ID, 3)).toBe(`kyb-check:${APP_ID}:3`);
  });

  it('builds a job ID with exactly three ":"-separated parts (the form BullMQ accepts)', () => {
    expect(kybCheckJobId(APP_ID, 1).split(':')).toHaveLength(3);
  });

  describe('parseKybCheckJobData', () => {
    it('accepts a valid object', () => {
      expect(parseKybCheckJobData({ applicationId: APP_ID, submissionNo: 2 })).toEqual({
        applicationId: APP_ID,
        submissionNo: 2,
      });
    });

    it('returns only the two known keys', () => {
      expect(parseKybCheckJobData({ applicationId: APP_ID, submissionNo: 1, extra: 'x' })).toEqual({
        applicationId: APP_ID,
        submissionNo: 1,
      });
    });

    it.each([
      ['null', null],
      ['a string', 'kyb-check'],
      ['an array', [APP_ID, 1]],
      ['a non-UUID id', { applicationId: 'x', submissionNo: 1 }],
      ['submissionNo 0', { applicationId: APP_ID, submissionNo: 0 }],
      ['submissionNo -1', { applicationId: APP_ID, submissionNo: -1 }],
      ['submissionNo 1.5', { applicationId: APP_ID, submissionNo: 1.5 }],
      ["submissionNo '1'", { applicationId: APP_ID, submissionNo: '1' }],
      ['a missing applicationId', { submissionNo: 1 }],
      ['a missing submissionNo', { applicationId: APP_ID }],
    ])('rejects %s', (_label, data) => {
      expect(parseKybCheckJobData(data)).toBeNull();
    });
  });
});
