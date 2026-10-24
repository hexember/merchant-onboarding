import { EntityManager, Repository } from 'typeorm';
import { ApplicationStatus, KybLevel, KybStatus } from '../applications/application.enums';
import { MerchantApplication } from '../applications/merchant-application.entity';
import { KybCheck } from './kyb-check.entity';
import { KybWorkerApplicationsRepository, NewKybCheck } from './kyb-worker-applications.repository';

const APP_ID = '00000000-0000-4000-8000-0000000000a1';

type UpdateQbMock = Record<'update' | 'set' | 'where' | 'andWhere' | 'execute', jest.Mock>;

function createUpdateQbMock(affected: number | undefined): UpdateQbMock {
  const qb: UpdateQbMock = {
    update: jest.fn(),
    set: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    execute: jest.fn().mockResolvedValue({ affected, raw: [], generatedMaps: [] }),
  };
  qb.update.mockReturnValue(qb);
  qb.set.mockReturnValue(qb);
  qb.where.mockReturnValue(qb);
  qb.andWhere.mockReturnValue(qb);
  return qb;
}

interface SelectQbMock {
  select: jest.Mock;
  where: jest.Mock;
  getOne: jest.Mock;
}

interface Setup {
  repository: KybWorkerApplicationsRepository;
  createQueryBuilder: jest.Mock;
  selectQb: SelectQbMock;
  repoManagerQb: UpdateQbMock;
  exists: jest.Mock;
}

function setup(
  options: { found?: Partial<MerchantApplication> | null; affected?: number } = {},
): Setup {
  const selectQb: SelectQbMock = {
    select: jest.fn(),
    where: jest.fn(),
    getOne: jest.fn().mockResolvedValue(options.found ?? null),
  };
  selectQb.select.mockReturnValue(selectQb);
  selectQb.where.mockReturnValue(selectQb);
  const createQueryBuilder = jest.fn().mockReturnValue(selectQb);
  const repoManagerQb = createUpdateQbMock(options.affected ?? 1);
  const applications = {
    createQueryBuilder,
    manager: { createQueryBuilder: jest.fn().mockReturnValue(repoManagerQb) },
  } as unknown as Repository<MerchantApplication>;
  const exists = jest.fn().mockResolvedValue(false);
  const kybChecks = { exists } as unknown as Repository<KybCheck>;
  return {
    repository: new KybWorkerApplicationsRepository(applications, kybChecks),
    createQueryBuilder,
    selectQb,
    repoManagerQb,
    exists,
  };
}

function managerWith(qb: UpdateQbMock): EntityManager {
  return { createQueryBuilder: jest.fn().mockReturnValue(qb) } as unknown as EntityManager;
}

const GUARD = [
  ['submission_count = :submissionNo', { submissionNo: 2 }],
  ['status = :riskReview', { riskReview: ApplicationStatus.RISK_REVIEW }],
];

function setArg(qb: UpdateQbMock): Record<string, unknown> {
  expect(qb.set).toHaveBeenCalledTimes(1);
  const [arg] = qb.set.mock.calls[0] as [Record<string, unknown>];
  return arg;
}

function expression(value: unknown): string {
  expect(typeof value).toBe('function');
  return (value as () => string)();
}

function expectGuard(qb: UpdateQbMock): void {
  expect(qb.update).toHaveBeenCalledWith(MerchantApplication);
  expect(qb.where.mock.calls).toEqual([['id = :id', { id: APP_ID }]]);
  expect(qb.andWhere.mock.calls).toEqual(GUARD);
  // The id comes first, then the submission and status guards.
  const whereOrder = qb.where.mock.invocationCallOrder[0] ?? Infinity;
  const firstAndWhere = qb.andWhere.mock.invocationCallOrder[0] ?? -Infinity;
  expect(whereOrder).toBeLessThan(firstAndWhere);
}

describe('KybWorkerApplicationsRepository', () => {
  describe('findForWorker', () => {
    it('returns null for a non-UUID id without building a query', async () => {
      const { repository, createQueryBuilder } = setup();

      await expect(repository.findForWorker('not-a-uuid')).resolves.toBeNull();
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    it('selects only the non-PII worker columns, by id, with no scope', async () => {
      const found = { id: APP_ID, status: ApplicationStatus.RISK_REVIEW, submissionCount: 1 };
      const { repository, createQueryBuilder, selectQb } = setup({ found });

      await expect(repository.findForWorker(APP_ID)).resolves.toBe(found);

      expect(createQueryBuilder).toHaveBeenCalledWith('app');
      const [selected] = selectQb.select.mock.calls[0] as [string[]];
      expect(selected).toEqual([
        'app.id',
        'app.status',
        'app.submissionCount',
        'app.merchantCategoryCode',
        'app.businessType',
        'app.expectedMonthlyVolumeMinor',
        'app.averageTicketSizeMinor',
      ]);
      const joined = selected.join(' ').toLowerCase();
      expect(joined).not.toMatch(/tax|owner|national|email|phone/);
      expect(selectQb.where.mock.calls).toEqual([['app.id = :id', { id: APP_ID }]]);
    });

    it('returns null when no row exists', async () => {
      const { repository } = setup({ found: null });

      await expect(repository.findForWorker(APP_ID)).resolves.toBeNull();
    });
  });

  describe('kybCheckExists', () => {
    it('looks up the (application_id, submission_no) pair', async () => {
      const { repository, exists } = setup();
      exists.mockResolvedValue(true);

      await expect(repository.kybCheckExists(APP_ID, 2)).resolves.toBe(true);
      expect(exists).toHaveBeenCalledWith({ where: { applicationId: APP_ID, submissionNo: 2 } });
    });
  });

  describe('recordAttemptIfCurrent', () => {
    it('increments the attempts, stamps the attempt time, bumps version, with the guard', async () => {
      const { repository, repoManagerQb } = setup({ affected: 1 });

      await expect(repository.recordAttemptIfCurrent(APP_ID, 2)).resolves.toBe(true);

      const set = setArg(repoManagerQb);
      expect(Object.keys(set).sort()).toEqual([
        'kybAttempts',
        'kybLastAttemptAt',
        'updatedAt',
        'version',
      ]);
      expect(expression(set['kybAttempts'])).toBe('kyb_attempts + 1');
      expect(expression(set['kybLastAttemptAt'])).toBe('now()');
      expect(expression(set['version'])).toBe('version + 1');
      expect(expression(set['updatedAt'])).toBe('now()');
      expectGuard(repoManagerQb);
    });

    it.each([0, undefined])('returns false when affected is %p', async (affected) => {
      const { repository, repoManagerQb } = setup();
      repoManagerQb.execute.mockResolvedValue({ affected, raw: [], generatedMaps: [] });

      await expect(repository.recordAttemptIfCurrent(APP_ID, 2)).resolves.toBe(false);
    });
  });

  describe('insertKybCheckIfAbsent', () => {
    const values: NewKybCheck = {
      applicationId: APP_ID,
      submissionNo: 2,
      providerReference: 'fake-ref-1',
      score: 78,
      level: KybLevel.HIGH,
      reasons: ['FAKE_REASON'],
      meta: { providerVersion: 'fake-1', latencyMs: 3, attempt: 1 },
    };

    it('runs the parameterised ON CONFLICT DO NOTHING insert and returns true for a row', async () => {
      const query = jest.fn().mockResolvedValue([{ id: 'row-id' }]);
      const manager = { query } as unknown as EntityManager;
      const { repository } = setup();

      await expect(repository.insertKybCheckIfAbsent(values, manager)).resolves.toBe(true);

      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(
        'INSERT INTO "kyb_checks" ("application_id","submission_no","provider_reference","score","level","reasons","meta")',
      );
      expect(sql).toContain('VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)');
      expect(sql).toContain('ON CONFLICT ("application_id","submission_no") DO NOTHING');
      expect(sql).toContain('RETURNING "id"');
      expect(params).toEqual([
        APP_ID,
        2,
        'fake-ref-1',
        78,
        KybLevel.HIGH,
        JSON.stringify(['FAKE_REASON']),
        JSON.stringify({ providerVersion: 'fake-1', latencyMs: 3, attempt: 1 }),
      ]);
    });

    it('returns false when RETURNING is empty (conflict)', async () => {
      const manager = { query: jest.fn().mockResolvedValue([]) } as unknown as EntityManager;
      const { repository } = setup();

      await expect(repository.insertKybCheckIfAbsent(values, manager)).resolves.toBe(false);
    });
  });

  describe('completeIfCurrent', () => {
    it('moves to UNDER_REVIEW / COMPLETED with level and score, with the guard', async () => {
      const qb = createUpdateQbMock(1);
      const { repository } = setup();

      await expect(
        repository.completeIfCurrent(
          APP_ID,
          2,
          { level: KybLevel.HIGH, score: 78 },
          managerWith(qb),
        ),
      ).resolves.toBe(true);

      const set = setArg(qb);
      expect(Object.keys(set).sort()).toEqual([
        'kybLevel',
        'kybScore',
        'kybStatus',
        'status',
        'updatedAt',
        'version',
      ]);
      expect(set['status']).toBe(ApplicationStatus.UNDER_REVIEW);
      expect(set['kybStatus']).toBe(KybStatus.COMPLETED);
      expect(set['kybLevel']).toBe(KybLevel.HIGH);
      expect(set['kybScore']).toBe(78);
      expect(expression(set['version'])).toBe('version + 1');
      expect(expression(set['updatedAt'])).toBe('now()');
      expectGuard(qb);
    });

    it.each([0, undefined])('returns false when affected is %p', async (affected) => {
      const { repository } = setup();

      await expect(
        repository.completeIfCurrent(
          APP_ID,
          2,
          { level: KybLevel.LOW, score: 10 },
          managerWith(createUpdateQbMock(affected)),
        ),
      ).resolves.toBe(false);
    });
  });

  describe('failIfCurrent', () => {
    it('moves to UNDER_REVIEW / FAILED with level and score cleared, with the guard', async () => {
      const qb = createUpdateQbMock(1);
      const { repository } = setup();

      await expect(repository.failIfCurrent(APP_ID, 2, managerWith(qb))).resolves.toBe(true);

      const set = setArg(qb);
      expect(Object.keys(set).sort()).toEqual([
        'kybLevel',
        'kybScore',
        'kybStatus',
        'status',
        'updatedAt',
        'version',
      ]);
      expect(set['status']).toBe(ApplicationStatus.UNDER_REVIEW);
      expect(set['kybStatus']).toBe(KybStatus.FAILED);
      expect(set['kybLevel']).toBeNull();
      expect(set['kybScore']).toBeNull();
      expect(expression(set['version'])).toBe('version + 1');
      expect(expression(set['updatedAt'])).toBe('now()');
      expectGuard(qb);
    });

    it.each([0, undefined])('returns false when affected is %p', async (affected) => {
      const { repository } = setup();

      await expect(
        repository.failIfCurrent(APP_ID, 2, managerWith(createUpdateQbMock(affected))),
      ).resolves.toBe(false);
    });
  });
});
