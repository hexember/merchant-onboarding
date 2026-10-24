import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { DataSource, EntityManager } from 'typeorm';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditEntry, AuditLogService } from '../audit/audit-log.service';
import { AuthUser } from '../auth/auth-user';
import { UserRole } from '../common/common.enums';
import { KybCheckQueue } from '../kyb/kyb-check.queue';
import { UsersRepository } from '../users/users.repository';
import { ApplicationStatus, BusinessType, KybLevel, KybStatus } from './application.enums';
import { ApplicationsRepository, NewApplication } from './applications.repository';
import {
  APPLICATION_NOT_FOUND_MESSAGE,
  ApplicationsService,
  CONCURRENT_MODIFICATION_CODE,
  CONCURRENT_MODIFICATION_MESSAGE,
  INVALID_STATE_TRANSITION_CODE,
  KYB_NOT_COMPLETED_CODE,
  KYB_NOT_COMPLETED_MESSAGE,
  NO_FIELDS_TO_UPDATE_MESSAGE,
  NOT_ASSIGNABLE_MESSAGE,
  NOT_DECIDABLE_MESSAGE,
  NOT_SUBMITTABLE_MESSAGE,
  NOT_TRANSFERABLE_MESSAGE,
  NOTE_CONTAINS_RAW_ID_MESSAGE,
  REVIEWER_NOT_REVIEWER_MESSAGE,
  SALES_OWNER_NOT_SALES_MESSAGE,
  SALES_OWNER_REQUIRED_MESSAGE,
} from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { DecisionType, RecordDecisionDto } from './dto/record-decision.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { MerchantApplication } from './merchant-application.entity';

const APP_ID = '00000000-0000-4000-8000-0000000000a1';
const SALES_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_SALES_ID = '00000000-0000-4000-8000-0000000000b2';
const REVIEWER_ID = '00000000-0000-4000-8000-0000000000c1';
const OTHER_REVIEWER_ID = '00000000-0000-4000-8000-0000000000c2';
const ADMIN_ID = '00000000-0000-4000-8000-0000000000d1';

const SALES: AuthUser = { id: SALES_ID, role: UserRole.SALES };
const REVIEWER: AuthUser = { id: REVIEWER_ID, role: UserRole.REVIEWER };
const ADMIN: AuthUser = { id: ADMIN_ID, role: UserRole.ADMIN };

// Fake values only.
const RAW_TAX_ID = 'PAN-FAKE-00001234';
const RAW_NATIONAL_ID = 'NID-FAKE-5678';
const RAW_EMAIL = 'owner@example.com';
const RAW_PHONE = '+977-0000000123';

function createDto(overrides: Partial<CreateApplicationDto> = {}): CreateApplicationDto {
  return {
    businessName: 'Example Grocers',
    legalBusinessName: 'Example Grocers Pvt. Ltd.',
    businessType: BusinessType.PRIVATE_LIMITED,
    registrationNumber: 'REG-FAKE-0001',
    taxId: RAW_TAX_ID,
    ownerFullName: 'Jane Example',
    ownerEmail: RAW_EMAIL,
    ownerPhone: RAW_PHONE,
    ownerNationalId: RAW_NATIONAL_ID,
    merchantCategoryCode: '5411',
    expectedMonthlyVolumeMinor: 2500000,
    averageTicketSizeMinor: 150000,
    ...overrides,
  };
}

function fakeApplication(overrides: Partial<MerchantApplication> = {}): MerchantApplication {
  return Object.assign(new MerchantApplication(), {
    id: APP_ID,
    createdById: SALES_ID,
    salesOwnerId: SALES_ID,
    assignedReviewerId: null,
    businessName: 'Example Grocers',
    legalBusinessName: 'Example Grocers Pvt. Ltd.',
    businessType: BusinessType.PRIVATE_LIMITED,
    registrationNumber: 'REG-FAKE-0001',
    taxId: RAW_TAX_ID,
    ownerFullName: 'Jane Example',
    ownerEmail: RAW_EMAIL,
    ownerPhone: RAW_PHONE,
    ownerNationalId: RAW_NATIONAL_ID,
    merchantCategoryCode: '5411',
    websiteUrl: null,
    expectedMonthlyVolumeMinor: 2500000,
    averageTicketSizeMinor: 150000,
    currency: 'NPR',
    status: ApplicationStatus.DRAFT,
    kybStatus: KybStatus.NOT_STARTED,
    kybLevel: null,
    kybScore: null,
    kybAttempts: 0,
    kybLastAttemptAt: null,
    submissionCount: 0,
    version: 1,
    meta: {},
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });
}

interface Mocks {
  service: ApplicationsService;
  manager: EntityManager;
  transaction: jest.Mock;
  insert: jest.Mock;
  findAccessible: jest.Mock;
  findAccessiblePage: jest.Mock;
  updateIfEditable: jest.Mock;
  submitIfAllowed: jest.Mock;
  assignReviewerIfAllowed: jest.Mock;
  transferOwnerIfAllowed: jest.Mock;
  decideIfAllowed: jest.Mock;
  existsWithRole: jest.Mock;
  record: jest.Mock;
  enqueue: jest.Mock;
}

function setup(found: MerchantApplication | null = fakeApplication()): Mocks {
  const manager = { fake: 'transaction-manager' } as unknown as EntityManager;
  const transaction = jest.fn((run: (m: EntityManager) => Promise<unknown>) => run(manager));
  const insert = jest.fn().mockResolvedValue(APP_ID);
  const findAccessible = jest.fn().mockResolvedValue(found);
  const findAccessiblePage = jest.fn().mockResolvedValue({ items: [], total: 0 });
  const updateIfEditable = jest.fn().mockResolvedValue(true);
  const submitIfAllowed = jest.fn().mockResolvedValue(true);
  const assignReviewerIfAllowed = jest.fn().mockResolvedValue(true);
  const transferOwnerIfAllowed = jest.fn().mockResolvedValue(true);
  const decideIfAllowed = jest.fn().mockResolvedValue(true);
  const existsWithRole = jest.fn().mockResolvedValue(true);
  const record = jest.fn().mockResolvedValue(undefined);
  const enqueue = jest.fn().mockResolvedValue(true);
  const service = new ApplicationsService(
    { transaction } as unknown as DataSource,
    {
      insert,
      findAccessible,
      findAccessiblePage,
      updateIfEditable,
      submitIfAllowed,
      assignReviewerIfAllowed,
      transferOwnerIfAllowed,
      decideIfAllowed,
    } as unknown as ApplicationsRepository,
    { existsWithRole } as unknown as UsersRepository,
    { record } as unknown as AuditLogService,
    { enqueue } as unknown as KybCheckQueue,
  );
  return {
    service,
    manager,
    transaction,
    insert,
    findAccessible,
    findAccessiblePage,
    updateIfEditable,
    submitIfAllowed,
    assignReviewerIfAllowed,
    transferOwnerIfAllowed,
    decideIfAllowed,
    existsWithRole,
    record,
    enqueue,
  };
}

function onlyInsertedValues(insert: jest.Mock): NewApplication {
  expect(insert).toHaveBeenCalledTimes(1);
  const [values] = insert.mock.calls[0] as [NewApplication];
  return values;
}

function onlyAuditEntry(record: jest.Mock): AuditEntry {
  expect(record).toHaveBeenCalledTimes(1);
  const [entry] = record.mock.calls[0] as [AuditEntry];
  return entry;
}

// A fake reviewer note; checked to never reach the audit entry.
const NOTE_MARKER = 'fake-decision-note-marker-7f3a';

/** An UNDER_REVIEW application assigned to REVIEWER with a completed KYB check. */
function decidable(overrides: Partial<MerchantApplication> = {}): MerchantApplication {
  return fakeApplication({
    status: ApplicationStatus.UNDER_REVIEW,
    kybStatus: KybStatus.COMPLETED,
    assignedReviewerId: REVIEWER_ID,
    submissionCount: 1,
    decisionNote: null,
    decidedAt: null,
    ...overrides,
  });
}

function decisionDto(decision: DecisionType, note?: string): RecordDecisionDto {
  return note === undefined ? { decision } : { decision, note };
}

describe('ApplicationsService', () => {
  describe('create (denied)', () => {
    it.each([
      ['its own id', SALES_ID],
      ["another SALES user's id", OTHER_SALES_ID],
      ['null', null],
      ['a malformed id', 'not-a-uuid'],
      ['a number', 123],
    ])('SALES sending salesOwnerId as %s → 403 before any DB work', async (_label, value) => {
      const { service, transaction, existsWithRole, insert, record } = setup();

      await expect(
        service.create(createDto({ salesOwnerId: value }), SALES),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(transaction).not.toHaveBeenCalled();
      expect(existsWithRole).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it.each([
      ['missing', createDto()],
      ['null', createDto({ salesOwnerId: null })],
    ])('ADMIN with salesOwnerId %s → 400 "required"', async (_label, dto) => {
      const { service, transaction, existsWithRole } = setup();

      const error = await service.create(dto, ADMIN).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(SALES_OWNER_REQUIRED_MESSAGE);
      expect(existsWithRole).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('ADMIN with a non-string salesOwnerId → 400 without a user lookup', async () => {
      const { service, transaction, existsWithRole } = setup();

      const error = await service
        .create(createDto({ salesOwnerId: 123 }), ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(SALES_OWNER_NOT_SALES_MESSAGE);
      expect(existsWithRole).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it.each([
      ['a malformed id', 'not-a-uuid'],
      ['an unknown or non-SALES user', REVIEWER_ID],
    ])('ADMIN naming %s → 400 "must be a SALES user"', async (_label, value) => {
      const { service, transaction, existsWithRole } = setup();
      existsWithRole.mockResolvedValue(false);

      const error = await service
        .create(createDto({ salesOwnerId: value }), ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(SALES_OWNER_NOT_SALES_MESSAGE);
      expect(existsWithRole).toHaveBeenCalledWith(value, UserRole.SALES);
      expect(transaction).not.toHaveBeenCalled();
    });

    it('REVIEWER → 403 (defence in depth behind the role guard)', async () => {
      const { service, transaction } = setup();

      await expect(service.create(createDto(), REVIEWER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(transaction).not.toHaveBeenCalled();
    });
  });

  describe('create (allowed)', () => {
    it('SALES: createdById = salesOwnerId = actor, DRAFT, NOT_STARTED, defaults applied', async () => {
      const { service, insert, manager } = setup();

      await service.create(createDto(), SALES);

      const values = onlyInsertedValues(insert);
      expect(values).toMatchObject({
        createdById: SALES_ID,
        salesOwnerId: SALES_ID,
        assignedReviewerId: null,
        status: ApplicationStatus.DRAFT,
        kybStatus: KybStatus.NOT_STARTED,
        kybLevel: null,
        kybScore: null,
        currency: 'NPR',
        websiteUrl: null,
      });
      expect(values).not.toHaveProperty('meta');
      expect((insert.mock.calls[0] as unknown[])[1]).toBe(manager);
    });

    it('ADMIN: createdById = admin, salesOwnerId = the named SALES user', async () => {
      const { service, insert, existsWithRole } = setup();

      await service.create(createDto({ salesOwnerId: OTHER_SALES_ID }), ADMIN);

      expect(existsWithRole).toHaveBeenCalledWith(OTHER_SALES_ID, UserRole.SALES);
      expect(onlyInsertedValues(insert)).toMatchObject({
        createdById: ADMIN_ID,
        salesOwnerId: OTHER_SALES_ID,
      });
    });

    it('keeps a given currency and websiteUrl', async () => {
      const { service, insert } = setup();
      const dto = createDto({ currency: 'USD', websiteUrl: 'https://shop.example.com' });

      await service.create(dto, SALES);

      expect(onlyInsertedValues(insert)).toMatchObject({
        currency: 'USD',
        websiteUrl: 'https://shop.example.com',
      });
    });

    it('audits APPLICATION_CREATED with the transaction manager and no sensitive values', async () => {
      const { service, record, manager } = setup();

      await service.create(createDto(), SALES);

      const entry = onlyAuditEntry(record);
      expect(entry).toEqual({
        actorType: AuditActorType.USER,
        actorId: SALES_ID,
        actorRole: UserRole.SALES,
        action: AuditAction.APPLICATION_CREATED,
        entityType: 'merchant_application',
        entityId: APP_ID,
        meta: { status: ApplicationStatus.DRAFT, salesOwnerId: SALES_ID },
      });
      expect((record.mock.calls[0] as unknown[])[1]).toBe(manager);
      const json = JSON.stringify(entry);
      for (const raw of [RAW_TAX_ID, RAW_NATIONAL_ID, RAW_EMAIL, RAW_PHONE]) {
        expect(json).not.toContain(raw);
      }
    });

    it('re-reads through the scope in the same transaction and returns a masked response', async () => {
      const { service, findAccessible, manager } = setup();

      const response = await service.create(createDto(), SALES);

      expect(findAccessible).toHaveBeenCalledWith(APP_ID, SALES, manager);
      expect(response.taxId).toBe('••••••1234');
      expect(response.ownerEmail).toBe('o•••@example.com');
      expect(response).not.toHaveProperty('meta');
      expect(response).not.toHaveProperty('version');
    });

    it('rejects when the audit write fails', async () => {
      const { service, record } = setup();
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(service.create(createDto(), SALES)).rejects.toThrow('audit write failed');
    });

    it('throws inside the transaction when the re-read finds nothing', async () => {
      const { service } = setup(null);

      await expect(service.create(createDto(), SALES)).rejects.toThrow(
        'Application written in this transaction could not be re-read',
      );
    });
  });

  describe('list', () => {
    it('passes actor and filter to the scoped page query and maps masked items', async () => {
      const { service, findAccessiblePage } = setup();
      findAccessiblePage.mockResolvedValue({ items: [fakeApplication()], total: 3 });
      const query = Object.assign(new ListApplicationsQueryDto(), {
        status: ApplicationStatus.DRAFT,
        page: 2,
        limit: 1,
      });

      const response = await service.list(query, SALES);

      expect(findAccessiblePage).toHaveBeenCalledWith(SALES, {
        status: ApplicationStatus.DRAFT,
        page: 2,
        limit: 1,
      });
      expect(response.page).toBe(2);
      expect(response.limit).toBe(1);
      expect(response.total).toBe(3);
      expect(response.items).toHaveLength(1);
      expect(response.items[0]?.taxId).toBe('••••••1234');
    });
  });

  describe('get', () => {
    it('returns the masked application from the scoped lookup', async () => {
      const { service, findAccessible } = setup();

      const response = await service.get(APP_ID, SALES);

      expect(findAccessible).toHaveBeenCalledWith(APP_ID, SALES);
      expect(response.ownerNationalId).toBe('••••••5678');
    });

    it('returns the detail shape with the kybCheck block', async () => {
      const lastAttemptAt = new Date('2026-01-02T00:00:00Z');
      const { service } = setup(
        fakeApplication({
          status: ApplicationStatus.UNDER_REVIEW,
          kybStatus: KybStatus.COMPLETED,
          kybLevel: KybLevel.MEDIUM,
          kybScore: 55,
          kybAttempts: 1,
          kybLastAttemptAt: lastAttemptAt,
        }),
      );

      const response = await service.get(APP_ID, SALES);

      expect(response.kybCheck).toEqual({
        status: KybStatus.COMPLETED,
        level: KybLevel.MEDIUM,
        label: 'Fair deal',
        score: 55,
        attempts: 1,
        lastAttemptAt,
      });
      expect(response.taxId).toBe('••••••1234');
      expect(response).not.toHaveProperty('kybStatus');
      expect(response).not.toHaveProperty('meta');
    });

    it('out of scope or unknown → 404', async () => {
      const { service } = setup(null);

      const error = await service.get(APP_ID, SALES).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
    });
  });

  describe('update', () => {
    function updateDto(fields: Partial<UpdateApplicationDto>): UpdateApplicationDto {
      return Object.assign(new UpdateApplicationDto(), fields);
    }

    it('empty dto → 400 before any lookup', async () => {
      const { service, transaction, findAccessible } = setup();

      const error = await service.update(APP_ID, updateDto({}), SALES).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(NO_FIELDS_TO_UPDATE_MESSAGE);
      expect(transaction).not.toHaveBeenCalled();
      expect(findAccessible).not.toHaveBeenCalled();
    });

    it('out of scope or unknown → 404 with no write or audit', async () => {
      const { service, updateIfEditable, record } = setup(null);

      const error = await service
        .update(APP_ID, updateDto({ businessName: 'Example Bakery' }), SALES)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
      expect(updateIfEditable).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it.each([
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.APPROVED,
      ApplicationStatus.REJECTED,
    ])('%s → 409 INVALID_STATE_TRANSITION with no write or audit', async (status) => {
      const { service, updateIfEditable, record } = setup(fakeApplication({ status }));

      const error = await service
        .update(APP_ID, updateDto({ businessName: 'Example Bakery' }), SALES)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: INVALID_STATE_TRANSITION_CODE,
      });
      expect(updateIfEditable).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('lost race (updateIfEditable → false) → 409 CONCURRENT_MODIFICATION, no audit', async () => {
      const { service, updateIfEditable, record } = setup();
      updateIfEditable.mockResolvedValue(false);

      const error = await service
        .update(APP_ID, updateDto({ businessName: 'Example Bakery' }), SALES)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        code: CONCURRENT_MODIFICATION_CODE,
      });
      expect(record).not.toHaveBeenCalled();
    });

    it.each([ApplicationStatus.DRAFT, ApplicationStatus.INFO_REQUESTED])(
      '%s: writes only present fields with the read version, audits field names only',
      async (status) => {
        const { service, findAccessible, updateIfEditable, record, manager } = setup(
          fakeApplication({ status, version: 3 }),
        );
        const dto = updateDto({
          taxId: 'PAN-FAKE-00009999',
          businessName: 'Example Bakery',
          websiteUrl: null,
        });

        const response = await service.update(APP_ID, dto, SALES);

        expect(findAccessible).toHaveBeenNthCalledWith(1, APP_ID, SALES, manager);
        expect(updateIfEditable).toHaveBeenCalledWith(
          APP_ID,
          3,
          { taxId: 'PAN-FAKE-00009999', businessName: 'Example Bakery', websiteUrl: null },
          SALES,
          manager,
        );
        const entry = onlyAuditEntry(record);
        expect(entry).toEqual({
          actorType: AuditActorType.USER,
          actorId: SALES_ID,
          actorRole: UserRole.SALES,
          action: AuditAction.APPLICATION_UPDATED,
          entityType: 'merchant_application',
          entityId: APP_ID,
          meta: { changedFields: ['businessName', 'taxId', 'websiteUrl'], status },
        });
        expect((record.mock.calls[0] as unknown[])[1]).toBe(manager);
        expect(JSON.stringify(entry)).not.toContain('PAN-FAKE-00009999');
        expect(JSON.stringify(entry)).not.toContain('Example Bakery');
        // Re-read through the scope in the same transaction; masked.
        expect(findAccessible).toHaveBeenCalledTimes(2);
        expect(findAccessible).toHaveBeenNthCalledWith(2, APP_ID, SALES, manager);
        expect(response.taxId).toBe('••••••1234');
      },
    );

    it('rejects when the audit write fails', async () => {
      const { service, record } = setup();
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(
        service.update(APP_ID, updateDto({ businessName: 'Example Bakery' }), ADMIN),
      ).rejects.toThrow('audit write failed');
    });
  });

  describe('submit (denied)', () => {
    it('REVIEWER → 403 before any DB work', async () => {
      const { service, transaction, findAccessible, submitIfAllowed, record } = setup();

      await expect(service.submit(APP_ID, REVIEWER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(transaction).not.toHaveBeenCalled();
      expect(findAccessible).not.toHaveBeenCalled();
      expect(submitIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('out of scope or unknown → 404 with no write or audit', async () => {
      const { service, submitIfAllowed, record } = setup(null);

      const error = await service.submit(APP_ID, SALES).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
      expect(submitIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it.each([
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.APPROVED,
      ApplicationStatus.REJECTED,
    ])('%s → 409 INVALID_STATE_TRANSITION with no write or audit', async (status) => {
      const { service, submitIfAllowed, record } = setup(fakeApplication({ status }));

      const error = await service.submit(APP_ID, SALES).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: NOT_SUBMITTABLE_MESSAGE,
        code: 'INVALID_STATE_TRANSITION',
      });
      expect(submitIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('lost race (submitIfAllowed → false) → 409 CONCURRENT_MODIFICATION, no audit, no re-read', async () => {
      const { service, findAccessible, submitIfAllowed, record } = setup();
      submitIfAllowed.mockResolvedValue(false);

      const error = await service.submit(APP_ID, SALES).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: 'CONCURRENT_MODIFICATION',
      });
      expect(record).not.toHaveBeenCalled();
      expect(findAccessible).toHaveBeenCalledTimes(1);
    });
  });

  describe('submit (no enqueue when the transaction rejects)', () => {
    it('REVIEWER 403 → nothing enqueued', async () => {
      const { service, enqueue } = setup();

      await expect(service.submit(APP_ID, REVIEWER)).rejects.toBeInstanceOf(ForbiddenException);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('404 → nothing enqueued', async () => {
      const { service, enqueue } = setup(null);

      await expect(service.submit(APP_ID, SALES)).rejects.toBeInstanceOf(NotFoundException);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('409 INVALID_STATE_TRANSITION → nothing enqueued', async () => {
      const { service, enqueue } = setup(
        fakeApplication({ status: ApplicationStatus.RISK_REVIEW }),
      );

      await expect(service.submit(APP_ID, SALES)).rejects.toBeInstanceOf(ConflictException);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('409 CONCURRENT_MODIFICATION → nothing enqueued', async () => {
      const { service, submitIfAllowed, enqueue } = setup();
      submitIfAllowed.mockResolvedValue(false);

      await expect(service.submit(APP_ID, SALES)).rejects.toBeInstanceOf(ConflictException);
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('audit failure (rolled back) → nothing enqueued', async () => {
      const { service, record, enqueue } = setup();
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(service.submit(APP_ID, SALES)).rejects.toThrow('audit write failed');
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('submit (allowed)', () => {
    it.each([
      [ApplicationStatus.DRAFT, SALES],
      [ApplicationStatus.DRAFT, ADMIN],
      [ApplicationStatus.INFO_REQUESTED, SALES],
      [ApplicationStatus.INFO_REQUESTED, ADMIN],
    ])('%s by %o → RISK_REVIEW, audited with the read-back submissionNo', async (status, actor) => {
      const { service, findAccessible, submitIfAllowed, record, manager } = setup();
      findAccessible
        .mockResolvedValueOnce(fakeApplication({ status, version: 5, submissionCount: 2 }))
        .mockResolvedValueOnce(
          fakeApplication({
            status: ApplicationStatus.RISK_REVIEW,
            kybStatus: KybStatus.PENDING,
            version: 6,
            submissionCount: 3,
          }),
        );

      const response = await service.submit(APP_ID, actor);

      expect(findAccessible).toHaveBeenNthCalledWith(1, APP_ID, actor, manager);
      expect(submitIfAllowed).toHaveBeenCalledWith(
        APP_ID,
        5,
        ApplicationStatus.RISK_REVIEW,
        actor,
        manager,
      );
      expect(findAccessible).toHaveBeenCalledTimes(2);
      expect(findAccessible).toHaveBeenNthCalledWith(2, APP_ID, actor, manager);
      const entry = onlyAuditEntry(record);
      expect(entry).toEqual({
        actorType: AuditActorType.USER,
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.APPLICATION_SUBMITTED,
        entityType: 'merchant_application',
        entityId: APP_ID,
        meta: { from: status, to: ApplicationStatus.RISK_REVIEW, submissionNo: 3 },
      });
      expect(Object.keys(entry.meta ?? {}).sort()).toEqual(['from', 'submissionNo', 'to']);
      expect((record.mock.calls[0] as unknown[])[1]).toBe(manager);
      expect(response.status).toBe(ApplicationStatus.RISK_REVIEW);
      expect(response.taxId).toBe('••••••1234');
      expect(response).not.toHaveProperty('meta');
      expect(response).not.toHaveProperty('version');
      expect(response).not.toHaveProperty('submissionCount');
    });

    it('enqueues the KYB check once with the read-back submissionNo, after the commit', async () => {
      const { service, findAccessible, transaction, enqueue, manager } = setup();
      // Records when the transaction promise settled, so the enqueue can be ordered against it.
      const settled = jest.fn();
      transaction.mockImplementation(async (run: (m: EntityManager) => Promise<unknown>) => {
        const value = await run(manager);
        settled();
        return value;
      });
      findAccessible
        .mockResolvedValueOnce(fakeApplication({ version: 5, submissionCount: 2 }))
        .mockResolvedValueOnce(
          fakeApplication({
            status: ApplicationStatus.RISK_REVIEW,
            version: 6,
            submissionCount: 3,
          }),
        );

      await service.submit(APP_ID, SALES);

      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith(APP_ID, 3);
      const [settledOrder] = settled.mock.invocationCallOrder;
      const [enqueueOrder] = enqueue.mock.invocationCallOrder;
      expect(settledOrder).toBeDefined();
      expect(enqueueOrder).toBeGreaterThan(settledOrder ?? Number.POSITIVE_INFINITY);
    });

    it('still resolves with the response when the enqueue fails (resolves false)', async () => {
      const { service, findAccessible, enqueue } = setup();
      enqueue.mockResolvedValue(false);
      findAccessible
        .mockResolvedValueOnce(fakeApplication())
        .mockResolvedValueOnce(
          fakeApplication({ status: ApplicationStatus.RISK_REVIEW, submissionCount: 1 }),
        );

      const response = await service.submit(APP_ID, SALES);

      expect(enqueue).toHaveBeenCalledWith(APP_ID, 1);
      expect(response.status).toBe(ApplicationStatus.RISK_REVIEW);
      expect(response.taxId).toBe('••••••1234');
      expect(response).not.toHaveProperty('kybCheck');
    });

    it('rejects when the audit write fails', async () => {
      const { service, record } = setup();
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(service.submit(APP_ID, SALES)).rejects.toThrow('audit write failed');
    });

    it('throws inside the transaction when the re-read finds nothing', async () => {
      const { service, findAccessible, record } = setup();
      findAccessible.mockResolvedValueOnce(fakeApplication()).mockResolvedValueOnce(null);

      await expect(service.submit(APP_ID, SALES)).rejects.toThrow(
        'Application written in this transaction could not be re-read',
      );
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('assignReviewer (denied)', () => {
    it.each([
      ['SALES', SALES],
      ['REVIEWER', REVIEWER],
    ])('%s → 403 before any DB work', async (_label, actor) => {
      const {
        service,
        transaction,
        existsWithRole,
        findAccessible,
        assignReviewerIfAllowed,
        record,
      } = setup(fakeApplication({ status: ApplicationStatus.UNDER_REVIEW }));

      await expect(
        service.assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(existsWithRole).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(findAccessible).not.toHaveBeenCalled();
      expect(assignReviewerIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('target is not a REVIEWER → 400 with no transaction', async () => {
      const { service, transaction, existsWithRole, assignReviewerIfAllowed, record } = setup(
        fakeApplication({ status: ApplicationStatus.UNDER_REVIEW }),
      );
      existsWithRole.mockResolvedValue(false);

      const error = await service
        .assignReviewer(APP_ID, { reviewerId: SALES_ID }, ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(REVIEWER_NOT_REVIEWER_MESSAGE);
      expect(existsWithRole).toHaveBeenCalledWith(SALES_ID, UserRole.REVIEWER);
      expect(transaction).not.toHaveBeenCalled();
      expect(assignReviewerIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('unknown application → 404 with no write or audit', async () => {
      const { service, assignReviewerIfAllowed, record } = setup(null);

      const error = await service
        .assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
      expect(assignReviewerIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it.each([ApplicationStatus.DRAFT, ApplicationStatus.APPROVED, ApplicationStatus.REJECTED])(
      '%s → 409 INVALID_STATE_TRANSITION with no write or audit',
      async (status) => {
        const { service, assignReviewerIfAllowed, record } = setup(fakeApplication({ status }));

        const error = await service
          .assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, ADMIN)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          statusCode: 409,
          error: 'Conflict',
          message: NOT_ASSIGNABLE_MESSAGE,
          code: INVALID_STATE_TRANSITION_CODE,
        });
        expect(assignReviewerIfAllowed).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
      },
    );

    it('lost race (assignReviewerIfAllowed → false) → 409 CONCURRENT_MODIFICATION, no audit', async () => {
      const { service, findAccessible, assignReviewerIfAllowed, record } = setup(
        fakeApplication({ status: ApplicationStatus.UNDER_REVIEW }),
      );
      assignReviewerIfAllowed.mockResolvedValue(false);

      const error = await service
        .assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: CONCURRENT_MODIFICATION_CODE,
      });
      expect(record).not.toHaveBeenCalled();
      expect(findAccessible).toHaveBeenCalledTimes(1);
    });

    it('rejects when the audit write fails', async () => {
      const { service, record } = setup(
        fakeApplication({ status: ApplicationStatus.UNDER_REVIEW }),
      );
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(
        service.assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, ADMIN),
      ).rejects.toThrow('audit write failed');
    });
  });

  describe('assignReviewer (allowed)', () => {
    it.each([
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.INFO_REQUESTED,
    ])('ADMIN in %s → guarded write, REVIEWER_ASSIGNED audit, masked response', async (status) => {
      const { service, findAccessible, existsWithRole, assignReviewerIfAllowed, record, manager } =
        setup();
      findAccessible
        .mockResolvedValueOnce(fakeApplication({ status, version: 4 }))
        .mockResolvedValueOnce(
          fakeApplication({ status, version: 5, assignedReviewerId: REVIEWER_ID }),
        );

      const response = await service.assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, ADMIN);

      expect(existsWithRole).toHaveBeenCalledWith(REVIEWER_ID, UserRole.REVIEWER);
      expect(findAccessible).toHaveBeenNthCalledWith(1, APP_ID, ADMIN, manager);
      expect(assignReviewerIfAllowed).toHaveBeenCalledWith(APP_ID, 4, REVIEWER_ID, ADMIN, manager);
      const entry = onlyAuditEntry(record);
      expect(entry).toEqual({
        actorType: AuditActorType.USER,
        actorId: ADMIN_ID,
        actorRole: UserRole.ADMIN,
        action: AuditAction.REVIEWER_ASSIGNED,
        entityType: 'merchant_application',
        entityId: APP_ID,
        meta: { from: null, to: REVIEWER_ID },
      });
      expect((record.mock.calls[0] as unknown[])[1]).toBe(manager);
      expect(findAccessible).toHaveBeenCalledTimes(2);
      expect(findAccessible).toHaveBeenNthCalledWith(2, APP_ID, ADMIN, manager);
      expect(response.assignedReviewerId).toBe(REVIEWER_ID);
      expect(response.status).toBe(status);
      expect(response.taxId).toBe('••••••1234');
      expect(response).not.toHaveProperty('version');
      expect(response).not.toHaveProperty('meta');
      expect(response).not.toHaveProperty('kybCheck');
    });

    it('reassign → meta { from: previous reviewer, to: new reviewer }', async () => {
      const { service, assignReviewerIfAllowed, record, manager } = setup(
        fakeApplication({
          status: ApplicationStatus.UNDER_REVIEW,
          assignedReviewerId: REVIEWER_ID,
        }),
      );

      await service.assignReviewer(APP_ID, { reviewerId: OTHER_REVIEWER_ID }, ADMIN);

      expect(assignReviewerIfAllowed).toHaveBeenCalledWith(
        APP_ID,
        1,
        OTHER_REVIEWER_ID,
        ADMIN,
        manager,
      );
      expect(onlyAuditEntry(record).meta).toEqual({ from: REVIEWER_ID, to: OTHER_REVIEWER_ID });
    });

    it('the same reviewer again → normal write and an audit row with from === to', async () => {
      const { service, assignReviewerIfAllowed, record } = setup(
        fakeApplication({
          status: ApplicationStatus.UNDER_REVIEW,
          assignedReviewerId: REVIEWER_ID,
        }),
      );

      await service.assignReviewer(APP_ID, { reviewerId: REVIEWER_ID }, ADMIN);

      expect(assignReviewerIfAllowed).toHaveBeenCalledTimes(1);
      expect(onlyAuditEntry(record).meta).toEqual({ from: REVIEWER_ID, to: REVIEWER_ID });
    });
  });

  describe('transferOwner (denied)', () => {
    it.each([
      ['SALES', SALES],
      ['REVIEWER', REVIEWER],
    ])('%s → 403 before any DB work', async (_label, actor) => {
      const {
        service,
        transaction,
        existsWithRole,
        findAccessible,
        transferOwnerIfAllowed,
        record,
      } = setup();

      await expect(
        service.transferOwner(APP_ID, { salesOwnerId: OTHER_SALES_ID }, actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(existsWithRole).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(findAccessible).not.toHaveBeenCalled();
      expect(transferOwnerIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('target is not SALES → 400 with no transaction', async () => {
      const { service, transaction, existsWithRole, transferOwnerIfAllowed, record } = setup();
      existsWithRole.mockResolvedValue(false);

      const error = await service
        .transferOwner(APP_ID, { salesOwnerId: REVIEWER_ID }, ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(SALES_OWNER_NOT_SALES_MESSAGE);
      expect(existsWithRole).toHaveBeenCalledWith(REVIEWER_ID, UserRole.SALES);
      expect(transaction).not.toHaveBeenCalled();
      expect(transferOwnerIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('unknown application → 404 with no write or audit', async () => {
      const { service, transferOwnerIfAllowed, record } = setup(null);

      const error = await service
        .transferOwner(APP_ID, { salesOwnerId: OTHER_SALES_ID }, ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
      expect(transferOwnerIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it.each([ApplicationStatus.APPROVED, ApplicationStatus.REJECTED])(
      '%s → 409 INVALID_STATE_TRANSITION with no write or audit',
      async (status) => {
        const { service, transferOwnerIfAllowed, record } = setup(fakeApplication({ status }));

        const error = await service
          .transferOwner(APP_ID, { salesOwnerId: OTHER_SALES_ID }, ADMIN)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          statusCode: 409,
          error: 'Conflict',
          message: NOT_TRANSFERABLE_MESSAGE,
          code: INVALID_STATE_TRANSITION_CODE,
        });
        expect(transferOwnerIfAllowed).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
      },
    );

    it('lost race (transferOwnerIfAllowed → false) → 409 CONCURRENT_MODIFICATION, no audit', async () => {
      const { service, findAccessible, transferOwnerIfAllowed, record } = setup();
      transferOwnerIfAllowed.mockResolvedValue(false);

      const error = await service
        .transferOwner(APP_ID, { salesOwnerId: OTHER_SALES_ID }, ADMIN)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        statusCode: 409,
        error: 'Conflict',
        code: CONCURRENT_MODIFICATION_CODE,
      });
      expect(record).not.toHaveBeenCalled();
      expect(findAccessible).toHaveBeenCalledTimes(1);
    });

    it('rejects when the audit write fails', async () => {
      const { service, record } = setup();
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(
        service.transferOwner(APP_ID, { salesOwnerId: OTHER_SALES_ID }, ADMIN),
      ).rejects.toThrow('audit write failed');
    });
  });

  describe('transferOwner (allowed)', () => {
    it.each([
      ApplicationStatus.DRAFT,
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.INFO_REQUESTED,
    ])(
      'ADMIN in %s → guarded write, OWNERSHIP_TRANSFERRED audit, masked response',
      async (status) => {
        const { service, findAccessible, existsWithRole, transferOwnerIfAllowed, record, manager } =
          setup();
        findAccessible
          .mockResolvedValueOnce(fakeApplication({ status, version: 7 }))
          .mockResolvedValueOnce(
            fakeApplication({ status, version: 8, salesOwnerId: OTHER_SALES_ID }),
          );

        const response = await service.transferOwner(
          APP_ID,
          { salesOwnerId: OTHER_SALES_ID },
          ADMIN,
        );

        expect(existsWithRole).toHaveBeenCalledWith(OTHER_SALES_ID, UserRole.SALES);
        expect(findAccessible).toHaveBeenNthCalledWith(1, APP_ID, ADMIN, manager);
        expect(transferOwnerIfAllowed).toHaveBeenCalledWith(
          APP_ID,
          7,
          OTHER_SALES_ID,
          ADMIN,
          manager,
        );
        const entry = onlyAuditEntry(record);
        expect(entry).toEqual({
          actorType: AuditActorType.USER,
          actorId: ADMIN_ID,
          actorRole: UserRole.ADMIN,
          action: AuditAction.OWNERSHIP_TRANSFERRED,
          entityType: 'merchant_application',
          entityId: APP_ID,
          meta: { from: SALES_ID, to: OTHER_SALES_ID },
        });
        expect((record.mock.calls[0] as unknown[])[1]).toBe(manager);
        expect(findAccessible).toHaveBeenCalledTimes(2);
        expect(findAccessible).toHaveBeenNthCalledWith(2, APP_ID, ADMIN, manager);
        expect(response.salesOwnerId).toBe(OTHER_SALES_ID);
        expect(response.createdById).toBe(SALES_ID);
        expect(response.taxId).toBe('••••••1234');
        expect(response).not.toHaveProperty('version');
        expect(response).not.toHaveProperty('meta');
        expect(response).not.toHaveProperty('kybCheck');
      },
    );

    it('transfer to the current owner → normal write and an audit row with from === to', async () => {
      const { service, transferOwnerIfAllowed, record } = setup();

      await service.transferOwner(APP_ID, { salesOwnerId: SALES_ID }, ADMIN);

      expect(transferOwnerIfAllowed).toHaveBeenCalledTimes(1);
      expect(onlyAuditEntry(record).meta).toEqual({ from: SALES_ID, to: SALES_ID });
    });
  });

  describe('decide (denied)', () => {
    it.each([
      ['ADMIN', ADMIN],
      ['SALES', SALES],
    ])('%s → 403 before any DB work', async (_label, actor) => {
      const { service, transaction, findAccessible, decideIfAllowed, record } = setup(decidable());

      await expect(
        service.decide(APP_ID, decisionDto(DecisionType.APPROVE), actor),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(transaction).not.toHaveBeenCalled();
      expect(findAccessible).not.toHaveBeenCalled();
      expect(decideIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('not assigned to the caller or unknown (findAccessible → null) → 404, no write', async () => {
      const { service, decideIfAllowed, record } = setup(null);

      const error = await service
        .decide(APP_ID, decisionDto(DecisionType.REJECT), REVIEWER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(APPLICATION_NOT_FOUND_MESSAGE);
      expect(decideIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    const notDecidable = [
      ApplicationStatus.DRAFT,
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.INFO_REQUESTED,
      ApplicationStatus.APPROVED,
      ApplicationStatus.REJECTED,
    ];
    const decisions = [DecisionType.APPROVE, DecisionType.REJECT, DecisionType.REQUEST_INFO];
    it.each(notDecidable.flatMap((status) => decisions.map((d) => [status, d] as const)))(
      '%s + %s → 409 INVALID_STATE_TRANSITION with no write or audit',
      async (status, decision) => {
        const { service, decideIfAllowed, record } = setup(decidable({ status }));

        const error = await service
          .decide(APP_ID, decisionDto(decision), REVIEWER)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          statusCode: 409,
          error: 'Conflict',
          message: NOT_DECIDABLE_MESSAGE,
          code: INVALID_STATE_TRANSITION_CODE,
        });
        expect(decideIfAllowed).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
      },
    );

    it.each([KybStatus.PENDING, KybStatus.FAILED, KybStatus.NOT_STARTED])(
      'APPROVE with kybStatus %s → 409 KYB_NOT_COMPLETED with no write or audit',
      async (kybStatus) => {
        const { service, decideIfAllowed, record } = setup(decidable({ kybStatus }));

        const error = await service
          .decide(APP_ID, decisionDto(DecisionType.APPROVE), REVIEWER)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          statusCode: 409,
          error: 'Conflict',
          message: KYB_NOT_COMPLETED_MESSAGE,
          code: KYB_NOT_COMPLETED_CODE,
        });
        expect(decideIfAllowed).not.toHaveBeenCalled();
        expect(record).not.toHaveBeenCalled();
      },
    );

    it('APPROVE on a DRAFT with kybStatus NOT_STARTED → INVALID_STATE_TRANSITION, not KYB_NOT_COMPLETED', async () => {
      const { service, decideIfAllowed } = setup(
        decidable({ status: ApplicationStatus.DRAFT, kybStatus: KybStatus.NOT_STARTED }),
      );

      const error = await service
        .decide(APP_ID, decisionDto(DecisionType.APPROVE), REVIEWER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: INVALID_STATE_TRANSITION_CODE,
      });
      expect(decideIfAllowed).not.toHaveBeenCalled();
    });

    it.each([
      ['the raw taxId', `Checked ${RAW_TAX_ID} today`],
      ['the raw ownerNationalId', `Owner id ${RAW_NATIONAL_ID}`],
      ['the taxId in another case without dashes', 'see panfake00001234'],
      ['the ownerNationalId with spaces instead of dashes', 'nid fake 5678 confirmed'],
    ])('note containing %s → 400, no write or audit', async (_label, note) => {
      const { service, decideIfAllowed, record } = setup(decidable());

      const error = await service
        .decide(APP_ID, decisionDto(DecisionType.REQUEST_INFO, note), REVIEWER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toBe(NOTE_CONTAINS_RAW_ID_MESSAGE);
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain(note);
      expect(decideIfAllowed).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    });

    it('lost race (decideIfAllowed → false) → 409 CONCURRENT_MODIFICATION, no audit', async () => {
      const { service, findAccessible, decideIfAllowed, record } = setup(decidable());
      decideIfAllowed.mockResolvedValue(false);

      const error = await service
        .decide(APP_ID, decisionDto(DecisionType.APPROVE), REVIEWER)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message: CONCURRENT_MODIFICATION_MESSAGE,
        code: CONCURRENT_MODIFICATION_CODE,
      });
      expect(record).not.toHaveBeenCalled();
      expect(findAccessible).toHaveBeenCalledTimes(1);
    });

    it('rejects when the audit write fails', async () => {
      const { service, record } = setup(decidable());
      record.mockRejectedValue(new Error('audit write failed'));

      await expect(
        service.decide(APP_ID, decisionDto(DecisionType.REJECT), REVIEWER),
      ).rejects.toThrow('audit write failed');
    });
  });

  describe('decide (allowed)', () => {
    it.each([
      [DecisionType.APPROVE, ApplicationStatus.APPROVED],
      [DecisionType.REJECT, ApplicationStatus.REJECTED],
      [DecisionType.REQUEST_INFO, ApplicationStatus.INFO_REQUESTED],
    ])(
      '%s → guarded write, DECISION_RECORDED audit without the note, masked response',
      async (decision, to) => {
        const { service, findAccessible, decideIfAllowed, record, enqueue, manager } = setup();
        findAccessible.mockResolvedValueOnce(decidable({ version: 3 })).mockResolvedValueOnce(
          decidable({
            status: to,
            version: 4,
            decisionNote: NOTE_MARKER,
            decidedAt: new Date('2026-02-01T00:00:00Z'),
          }),
        );

        const response = await service.decide(APP_ID, decisionDto(decision, NOTE_MARKER), REVIEWER);

        expect(findAccessible).toHaveBeenNthCalledWith(1, APP_ID, REVIEWER, manager);
        expect(decideIfAllowed).toHaveBeenCalledWith(
          APP_ID,
          3,
          decision,
          to,
          NOTE_MARKER,
          REVIEWER,
          manager,
        );
        const entry = onlyAuditEntry(record);
        expect(entry).toEqual({
          actorType: AuditActorType.USER,
          actorId: REVIEWER_ID,
          actorRole: UserRole.REVIEWER,
          action: AuditAction.DECISION_RECORDED,
          entityType: 'merchant_application',
          entityId: APP_ID,
          meta: { decision, from: ApplicationStatus.UNDER_REVIEW, to },
        });
        expect(Object.keys(entry.meta ?? {}).sort()).toEqual(['decision', 'from', 'to']);
        expect(JSON.stringify(entry)).not.toContain(NOTE_MARKER);
        expect((record.mock.calls[0] as unknown[])[1]).toBe(manager);
        expect(findAccessible).toHaveBeenCalledTimes(2);
        expect(findAccessible).toHaveBeenNthCalledWith(2, APP_ID, REVIEWER, manager);
        expect(response.status).toBe(to);
        expect(response.decisionNote).toBe(NOTE_MARKER);
        expect(response.taxId).toBe('••••••1234');
        expect(JSON.stringify(response)).not.toContain(RAW_TAX_ID);
        expect(JSON.stringify(response)).not.toContain(RAW_NATIONAL_ID);
        expect(response).not.toHaveProperty('version');
        expect(response).not.toHaveProperty('meta');
        expect(response).not.toHaveProperty('kybCheck');
        expect(enqueue).not.toHaveBeenCalled();
      },
    );

    it('no note → decideIfAllowed receives null', async () => {
      const { service, decideIfAllowed, enqueue } = setup(decidable());

      await service.decide(APP_ID, decisionDto(DecisionType.APPROVE), REVIEWER);

      expect((decideIfAllowed.mock.calls[0] as unknown[])[4]).toBeNull();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('a note with only the last 4 of the IDs is allowed and stored', async () => {
      const { service, decideIfAllowed, record } = setup(decidable());
      const note = 'Tax ID ending 1234 and national ID ending 5678 verified';

      await service.decide(APP_ID, decisionDto(DecisionType.APPROVE, note), REVIEWER);

      expect((decideIfAllowed.mock.calls[0] as unknown[])[4]).toBe(note);
      expect(record).toHaveBeenCalledTimes(1);
    });

    it('decideIfAllowed receives the trimmed note from a transformed DTO', async () => {
      const { service, decideIfAllowed, record } = setup(decidable());
      const dto = plainToInstance(RecordDecisionDto, {
        decision: DecisionType.REQUEST_INFO,
        note: '  more docs  ',
      });

      await service.decide(APP_ID, dto, REVIEWER);

      expect((decideIfAllowed.mock.calls[0] as unknown[])[4]).toBe('more docs');
      expect(JSON.stringify(onlyAuditEntry(record))).not.toContain('more docs');
    });

    it('a whitespace-only note → decideIfAllowed receives null', async () => {
      const { service, decideIfAllowed } = setup(decidable());
      const dto = plainToInstance(RecordDecisionDto, {
        decision: DecisionType.REJECT,
        note: '   ',
      });

      await service.decide(APP_ID, dto, REVIEWER);

      expect((decideIfAllowed.mock.calls[0] as unknown[])[4]).toBeNull();
    });

    it.each([DecisionType.REJECT, DecisionType.REQUEST_INFO])(
      '%s with kybStatus FAILED → succeeds',
      async (decision) => {
        const { service, decideIfAllowed, record } = setup(
          decidable({ kybStatus: KybStatus.FAILED }),
        );

        await service.decide(APP_ID, decisionDto(decision), REVIEWER);

        expect(decideIfAllowed).toHaveBeenCalledTimes(1);
        expect(onlyAuditEntry(record).action).toBe(AuditAction.DECISION_RECORDED);
      },
    );
  });
});
