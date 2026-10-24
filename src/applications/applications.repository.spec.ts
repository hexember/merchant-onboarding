import { EntityManager, Repository } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { UserRole } from '../common/common.enums';
import { ApplicationStatus, BusinessType, KybStatus } from './application.enums';
import { ApplicationsRepository, NewApplication } from './applications.repository';
import { MerchantApplication } from './merchant-application.entity';

const APP_ID = '00000000-0000-4000-8000-0000000000a1';
const SALES_ID = '00000000-0000-4000-8000-0000000000b1';
const REVIEWER_ID = '00000000-0000-4000-8000-0000000000c1';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000d1';

const SALES: AuthUser = { id: SALES_ID, role: UserRole.SALES };
const REVIEWER: AuthUser = { id: REVIEWER_ID, role: UserRole.REVIEWER };
const ADMIN: AuthUser = { id: ADMIN_ID, role: UserRole.ADMIN };
// A role the scope does not know (e.g. one added later) must see nothing.
const UNKNOWN_ROLE = { id: ADMIN_ID, role: 'AUDITOR' } as unknown as AuthUser;

interface SelectQbMock {
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getOne: jest.Mock;
  getManyAndCount: jest.Mock;
}

function createSelectQbMock(found: MerchantApplication | null = null): SelectQbMock {
  const qb: SelectQbMock = {
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getOne: jest.fn().mockResolvedValue(found),
    getManyAndCount: jest.fn().mockResolvedValue([found === null ? [] : [found], 7]),
  };
  qb.andWhere.mockReturnValue(qb);
  qb.orderBy.mockReturnValue(qb);
  qb.addOrderBy.mockReturnValue(qb);
  qb.skip.mockReturnValue(qb);
  qb.take.mockReturnValue(qb);
  return qb;
}

function setup(found: MerchantApplication | null = null): {
  repository: ApplicationsRepository;
  createQueryBuilder: jest.Mock;
  qb: SelectQbMock;
} {
  const qb = createSelectQbMock(found);
  const createQueryBuilder = jest.fn().mockReturnValue(qb);
  const typeormRepository = { createQueryBuilder } as unknown as Repository<MerchantApplication>;
  return { repository: new ApplicationsRepository(typeormRepository), createQueryBuilder, qb };
}

function fakeApplication(): MerchantApplication {
  return Object.assign(new MerchantApplication(), {
    id: APP_ID,
    salesOwnerId: SALES_ID,
    status: ApplicationStatus.DRAFT,
  });
}

describe('ApplicationsRepository', () => {
  describe('findAccessible', () => {
    it('returns null for a non-UUID id without building a query', async () => {
      const { repository, createQueryBuilder } = setup();

      await expect(repository.findAccessible('not-a-uuid', SALES)).resolves.toBeNull();
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    it('SALES: scopes to sales_owner_id = actor id, then the id', async () => {
      const found = fakeApplication();
      const { repository, createQueryBuilder, qb } = setup(found);

      await expect(repository.findAccessible(APP_ID, SALES)).resolves.toBe(found);

      expect(createQueryBuilder).toHaveBeenCalledWith('app');
      expect(qb.andWhere.mock.calls).toEqual([
        ['app.sales_owner_id = :actorId', { actorId: SALES_ID }],
        ['app.id = :id', { id: APP_ID }],
      ]);
    });

    it('REVIEWER: scopes to assigned_reviewer_id = actor id', async () => {
      const { repository, qb } = setup();

      await expect(repository.findAccessible(APP_ID, REVIEWER)).resolves.toBeNull();

      expect(qb.andWhere.mock.calls).toEqual([
        ['app.assigned_reviewer_id = :actorId', { actorId: REVIEWER_ID }],
        ['app.id = :id', { id: APP_ID }],
      ]);
    });

    it('ADMIN: adds no scope clause, only the id', async () => {
      const { repository, qb } = setup();

      await repository.findAccessible(APP_ID, ADMIN);

      expect(qb.andWhere.mock.calls).toEqual([['app.id = :id', { id: APP_ID }]]);
    });

    it('an unknown role fails closed with 1 = 0', async () => {
      const { repository, qb } = setup();

      await repository.findAccessible(APP_ID, UNKNOWN_ROLE);

      expect(qb.andWhere.mock.calls).toEqual([['1 = 0'], ['app.id = :id', { id: APP_ID }]]);
    });

    it("uses the transaction manager's repository when a manager is passed", async () => {
      const { repository, createQueryBuilder } = setup();
      const managerQb = createSelectQbMock();
      const managerCreateQb = jest.fn().mockReturnValue(managerQb);
      const getRepository = jest.fn().mockReturnValue({ createQueryBuilder: managerCreateQb });
      const manager = { getRepository } as unknown as EntityManager;

      await repository.findAccessible(APP_ID, SALES, manager);

      expect(getRepository).toHaveBeenCalledWith(MerchantApplication);
      expect(managerCreateQb).toHaveBeenCalledWith('app');
      expect(createQueryBuilder).not.toHaveBeenCalled();
      expect(managerQb.andWhere).toHaveBeenCalledWith('app.sales_owner_id = :actorId', {
        actorId: SALES_ID,
      });
    });
  });

  describe('findAccessiblePage', () => {
    it('applies the SALES scope, orders newest first by property paths, and pages', async () => {
      const found = fakeApplication();
      const { repository, qb } = setup(found);

      await expect(repository.findAccessiblePage(SALES, { page: 3, limit: 10 })).resolves.toEqual({
        items: [found],
        total: 7,
      });

      expect(qb.andWhere.mock.calls).toEqual([
        ['app.sales_owner_id = :actorId', { actorId: SALES_ID }],
      ]);
      expect(qb.orderBy).toHaveBeenCalledWith('app.createdAt', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('app.id', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(20);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(qb.getManyAndCount).toHaveBeenCalledTimes(1);
    });

    it('adds the status filter only when given', async () => {
      const { repository, qb } = setup();

      await repository.findAccessiblePage(REVIEWER, {
        status: ApplicationStatus.INFO_REQUESTED,
        page: 1,
        limit: 20,
      });

      expect(qb.andWhere.mock.calls).toEqual([
        ['app.assigned_reviewer_id = :actorId', { actorId: REVIEWER_ID }],
        ['app.status = :status', { status: ApplicationStatus.INFO_REQUESTED }],
      ]);
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
    });

    it('ADMIN: no scope clause and no status clause without a filter', async () => {
      const { repository, qb } = setup();

      await repository.findAccessiblePage(ADMIN, { page: 1, limit: 5 });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('an unknown role fails closed with 1 = 0', async () => {
      const { repository, qb } = setup();

      await repository.findAccessiblePage(UNKNOWN_ROLE, { page: 1, limit: 5 });

      expect(qb.andWhere.mock.calls).toEqual([['1 = 0']]);
    });
  });

  describe('insert', () => {
    const values: NewApplication = {
      createdById: SALES_ID,
      salesOwnerId: SALES_ID,
      assignedReviewerId: null,
      businessName: 'Example Grocers',
      legalBusinessName: 'Example Grocers Pvt. Ltd.',
      businessType: BusinessType.PRIVATE_LIMITED,
      registrationNumber: 'REG-FAKE-0001',
      taxId: 'PAN-FAKE-00001234',
      ownerFullName: 'Jane Example',
      ownerEmail: 'owner@example.com',
      ownerPhone: '+977-0000000123',
      ownerNationalId: 'NID-FAKE-5678',
      merchantCategoryCode: '5411',
      websiteUrl: null,
      expectedMonthlyVolumeMinor: 2500000,
      averageTicketSizeMinor: 150000,
      currency: 'NPR',
      status: ApplicationStatus.DRAFT,
      kybStatus: KybStatus.NOT_STARTED,
      kybLevel: null,
      kybScore: null,
    };

    it('inserts through the given manager and returns the new id', async () => {
      const { repository } = setup();
      const insert = jest.fn().mockResolvedValue({ identifiers: [{ id: APP_ID }] });
      const manager = { insert } as unknown as EntityManager;

      await expect(repository.insert(values, manager)).resolves.toBe(APP_ID);
      expect(insert).toHaveBeenCalledWith(MerchantApplication, values);
    });

    it('throws when no id comes back', async () => {
      const { repository } = setup();
      const insert = jest.fn().mockResolvedValue({ identifiers: [] });
      const manager = { insert } as unknown as EntityManager;

      await expect(repository.insert(values, manager)).rejects.toThrow(
        'Application insert did not return an id',
      );
    });
  });

  describe('updateIfEditable', () => {
    function setupUpdate(affected: number | undefined): {
      manager: EntityManager;
      updateQb: Record<'update' | 'set' | 'where' | 'andWhere' | 'execute', jest.Mock>;
    } {
      const updateQb = {
        update: jest.fn(),
        set: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        execute: jest.fn().mockResolvedValue({ affected, raw: [], generatedMaps: [] }),
      };
      updateQb.update.mockReturnValue(updateQb);
      updateQb.set.mockReturnValue(updateQb);
      updateQb.where.mockReturnValue(updateQb);
      updateQb.andWhere.mockReturnValue(updateQb);
      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(updateQb),
      } as unknown as EntityManager;
      return { manager, updateQb };
    }

    const VERSION_AND_STATUS = [
      ['version = :expectedVersion', { expectedVersion: 4 }],
      [
        'status IN (:...editableStatuses)',
        { editableStatuses: [ApplicationStatus.DRAFT, ApplicationStatus.INFO_REQUESTED] },
      ],
    ];

    it('sets the changes, bumps version and updated_at, and checks version, status and scope', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupUpdate(1);

      await expect(
        repository.updateIfEditable(APP_ID, 4, { businessName: 'Example Bakery' }, SALES, manager),
      ).resolves.toBe(true);

      expect(updateQb.update).toHaveBeenCalledWith(MerchantApplication);
      expect(updateQb.set).toHaveBeenCalledTimes(1);
      const [setArg] = updateQb.set.mock.calls[0] as [Record<string, unknown>];
      // Exactly the changes plus the explicit version / updatedAt expressions, nothing else.
      expect(Object.keys(setArg).sort()).toEqual(['businessName', 'updatedAt', 'version']);
      expect(setArg['businessName']).toBe('Example Bakery');
      expect(typeof setArg['version']).toBe('function');
      expect((setArg['version'] as () => string)()).toBe('version + 1');
      expect((setArg['updatedAt'] as () => string)()).toBe('now()');
      expect(updateQb.where).toHaveBeenCalledWith('id = :id', { id: APP_ID });
      expect(updateQb.andWhere.mock.calls).toEqual([
        ...VERSION_AND_STATUS,
        ['sales_owner_id = :actorId', { actorId: SALES_ID }],
      ]);
    });

    it('REVIEWER: repeats the scope as assigned_reviewer_id = actor id', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupUpdate(1);

      await repository.updateIfEditable(APP_ID, 4, { currency: 'USD' }, REVIEWER, manager);

      expect(updateQb.andWhere.mock.calls).toEqual([
        ...VERSION_AND_STATUS,
        ['assigned_reviewer_id = :actorId', { actorId: REVIEWER_ID }],
      ]);
    });

    it('ADMIN: adds no scope condition', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupUpdate(1);

      await repository.updateIfEditable(APP_ID, 4, { currency: 'USD' }, ADMIN, manager);

      expect(updateQb.andWhere.mock.calls).toEqual(VERSION_AND_STATUS);
    });

    it('unknown role: fails closed with 1 = 0', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupUpdate(0);

      await expect(
        repository.updateIfEditable(APP_ID, 4, { currency: 'USD' }, UNKNOWN_ROLE, manager),
      ).resolves.toBe(false);

      expect(updateQb.andWhere.mock.calls).toEqual([...VERSION_AND_STATUS, ['1 = 0']]);
    });

    it.each([0, undefined])('returns false when affected is %s', async (affected) => {
      const { repository } = setup();
      const { manager } = setupUpdate(affected);

      await expect(
        repository.updateIfEditable(APP_ID, 4, { currency: 'USD' }, SALES, manager),
      ).resolves.toBe(false);
    });
  });

  describe('submitIfAllowed', () => {
    function setupSubmit(affected: number | undefined): {
      manager: EntityManager;
      updateQb: Record<'update' | 'set' | 'where' | 'andWhere' | 'execute', jest.Mock>;
    } {
      const updateQb = {
        update: jest.fn(),
        set: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        execute: jest.fn().mockResolvedValue({ affected, raw: [], generatedMaps: [] }),
      };
      updateQb.update.mockReturnValue(updateQb);
      updateQb.set.mockReturnValue(updateQb);
      updateQb.where.mockReturnValue(updateQb);
      updateQb.andWhere.mockReturnValue(updateQb);
      const manager = {
        createQueryBuilder: jest.fn().mockReturnValue(updateQb),
      } as unknown as EntityManager;
      return { manager, updateQb };
    }

    const VERSION_AND_SUBMITTABLE = [
      ['version = :expectedVersion', { expectedVersion: 4 }],
      [
        'status IN (:...submittableStatuses)',
        { submittableStatuses: [ApplicationStatus.DRAFT, ApplicationStatus.INFO_REQUESTED] },
      ],
    ];

    function onlySetArg(updateQb: { set: jest.Mock }): Record<string, unknown> {
      expect(updateQb.set).toHaveBeenCalledTimes(1);
      const [setArg] = updateQb.set.mock.calls[0] as [Record<string, unknown>];
      return setArg;
    }

    function raw(value: unknown): string {
      expect(typeof value).toBe('function');
      return (value as () => string)();
    }

    it('sets the status, resets KYB, bumps counters, and checks version, status and scope', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupSubmit(1);

      await expect(
        repository.submitIfAllowed(APP_ID, 4, ApplicationStatus.RISK_REVIEW, SALES, manager),
      ).resolves.toBe(true);

      expect(updateQb.update).toHaveBeenCalledWith(MerchantApplication);
      const setArg = onlySetArg(updateQb);
      expect(Object.keys(setArg).sort()).toEqual(
        [
          'status',
          'kybStatus',
          'kybLevel',
          'kybScore',
          'kybAttempts',
          'kybLastAttemptAt',
          'submissionCount',
          'submittedAt',
          'version',
          'updatedAt',
        ].sort(),
      );
      expect(setArg['status']).toBe(ApplicationStatus.RISK_REVIEW);
      expect(setArg['kybStatus']).toBe(KybStatus.PENDING);
      expect(setArg['kybLevel']).toBeNull();
      expect(setArg['kybScore']).toBeNull();
      expect(setArg['kybLastAttemptAt']).toBeNull();
      expect(setArg['kybAttempts']).toBe(0);
      expect(raw(setArg['submissionCount'])).toBe('submission_count + 1');
      expect(raw(setArg['submittedAt'])).toBe('now()');
      expect(raw(setArg['version'])).toBe('version + 1');
      expect(raw(setArg['updatedAt'])).toBe('now()');
      expect(updateQb.where).toHaveBeenCalledWith('id = :id', { id: APP_ID });
      expect(updateQb.andWhere.mock.calls).toEqual([
        ...VERSION_AND_SUBMITTABLE,
        ['sales_owner_id = :actorId', { actorId: SALES_ID }],
      ]);
    });

    it('never touches ownership, assignment or decision columns', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupSubmit(1);

      await repository.submitIfAllowed(APP_ID, 4, ApplicationStatus.RISK_REVIEW, ADMIN, manager);

      const keys = Object.keys(onlySetArg(updateQb));
      for (const forbidden of ['salesOwnerId', 'assignedReviewerId', 'decisionNote', 'decidedAt']) {
        expect(keys).not.toContain(forbidden);
      }
    });

    it('REVIEWER: repeats the scope as assigned_reviewer_id = actor id', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupSubmit(1);

      await repository.submitIfAllowed(APP_ID, 4, ApplicationStatus.RISK_REVIEW, REVIEWER, manager);

      expect(updateQb.andWhere.mock.calls).toEqual([
        ...VERSION_AND_SUBMITTABLE,
        ['assigned_reviewer_id = :actorId', { actorId: REVIEWER_ID }],
      ]);
    });

    it('ADMIN: adds no scope condition', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupSubmit(1);

      await repository.submitIfAllowed(APP_ID, 4, ApplicationStatus.RISK_REVIEW, ADMIN, manager);

      expect(updateQb.andWhere.mock.calls).toEqual(VERSION_AND_SUBMITTABLE);
    });

    it('unknown role: fails closed with 1 = 0 and returns false', async () => {
      const { repository } = setup();
      const { manager, updateQb } = setupSubmit(0);

      await expect(
        repository.submitIfAllowed(APP_ID, 4, ApplicationStatus.RISK_REVIEW, UNKNOWN_ROLE, manager),
      ).resolves.toBe(false);

      expect(updateQb.andWhere.mock.calls).toEqual([...VERSION_AND_SUBMITTABLE, ['1 = 0']]);
    });

    it.each([0, undefined])('returns false when affected is %s', async (affected) => {
      const { repository } = setup();
      const { manager } = setupSubmit(affected);

      await expect(
        repository.submitIfAllowed(APP_ID, 4, ApplicationStatus.RISK_REVIEW, SALES, manager),
      ).resolves.toBe(false);
    });
  });
});
