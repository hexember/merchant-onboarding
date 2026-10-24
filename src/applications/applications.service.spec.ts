import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditEntry, AuditLogService } from '../audit/audit-log.service';
import { AuthUser } from '../auth/auth-user';
import { UserRole } from '../common/common.enums';
import { UsersRepository } from '../users/users.repository';
import { ApplicationStatus, BusinessType, KybStatus } from './application.enums';
import { ApplicationsRepository, NewApplication } from './applications.repository';
import {
  APPLICATION_NOT_FOUND_MESSAGE,
  ApplicationsService,
  CONCURRENT_MODIFICATION_CODE,
  INVALID_STATE_TRANSITION_CODE,
  NO_FIELDS_TO_UPDATE_MESSAGE,
  SALES_OWNER_NOT_SALES_MESSAGE,
  SALES_OWNER_REQUIRED_MESSAGE,
} from './applications.service';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { MerchantApplication } from './merchant-application.entity';

const APP_ID = '00000000-0000-4000-8000-0000000000a1';
const SALES_ID = '00000000-0000-4000-8000-0000000000b1';
const OTHER_SALES_ID = '00000000-0000-4000-8000-0000000000b2';
const REVIEWER_ID = '00000000-0000-4000-8000-0000000000c1';
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
  existsWithRole: jest.Mock;
  record: jest.Mock;
}

function setup(found: MerchantApplication | null = fakeApplication()): Mocks {
  const manager = { fake: 'transaction-manager' } as unknown as EntityManager;
  const transaction = jest.fn((run: (m: EntityManager) => Promise<unknown>) => run(manager));
  const insert = jest.fn().mockResolvedValue(APP_ID);
  const findAccessible = jest.fn().mockResolvedValue(found);
  const findAccessiblePage = jest.fn().mockResolvedValue({ items: [], total: 0 });
  const updateIfEditable = jest.fn().mockResolvedValue(true);
  const existsWithRole = jest.fn().mockResolvedValue(true);
  const record = jest.fn().mockResolvedValue(undefined);
  const service = new ApplicationsService(
    { transaction } as unknown as DataSource,
    {
      insert,
      findAccessible,
      findAccessiblePage,
      updateIfEditable,
    } as unknown as ApplicationsRepository,
    { existsWithRole } as unknown as UsersRepository,
    { record } as unknown as AuditLogService,
  );
  return {
    service,
    manager,
    transaction,
    insert,
    findAccessible,
    findAccessiblePage,
    updateIfEditable,
    existsWithRole,
    record,
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
});
