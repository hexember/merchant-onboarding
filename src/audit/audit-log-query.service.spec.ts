import { Repository } from 'typeorm';
import { UserRole } from '../common/common.enums';
import { AuditAction, AuditActorType } from './audit.enums';
import { AuditLog } from './audit-log.entity';
import { AuditLogQueryService } from './audit-log-query.service';

const APP_ID = '00000000-0000-4000-8000-0000000000a1';
const SALES_ID = '00000000-0000-4000-8000-0000000000b1';

const WRITE_METHODS = ['insert', 'save', 'update', 'delete', 'remove', 'query'] as const;

function fakeRow(): AuditLog {
  return Object.assign(new AuditLog(), {
    id: '00000000-0000-4000-8000-0000000000e1',
    actorType: AuditActorType.USER,
    actorId: SALES_ID,
    actorRole: UserRole.SALES,
    actorLabel: null,
    action: AuditAction.APPLICATION_CREATED,
    entityType: 'merchant_application',
    entityId: APP_ID,
    meta: {},
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  });
}

// The mock repository exposes only `findAndCount`, so any other call would throw.
function setup(
  rows: AuditLog[] = [],
  total = 0,
): {
  service: AuditLogQueryService;
  repositoryMock: Record<string, unknown>;
  findAndCount: jest.Mock;
} {
  const findAndCount = jest.fn().mockResolvedValue([rows, total]);
  const repositoryMock: Record<string, unknown> = { findAndCount };
  const service = new AuditLogQueryService(repositoryMock as unknown as Repository<AuditLog>);
  return { service, repositoryMock, findAndCount };
}

describe('AuditLogQueryService.findApplicationHistoryPage', () => {
  it.each([
    [1, 20, 0, 20],
    [3, 10, 20, 10],
    [10000, 100, 999900, 100],
  ])(
    'page %i, limit %i → skip %i, take %i, filtered by merchant_application and the id, oldest first',
    async (page, limit, skip, take) => {
      const { service, findAndCount } = setup();

      await service.findApplicationHistoryPage(APP_ID, page, limit);

      expect(findAndCount).toHaveBeenCalledTimes(1);
      expect(findAndCount).toHaveBeenCalledWith({
        where: { entityType: 'merchant_application', entityId: APP_ID },
        order: { createdAt: 'ASC', id: 'ASC' },
        skip,
        take,
      });
    },
  );

  it('returns items and total from the findAndCount tuple', async () => {
    const rows = [fakeRow()];
    const { service } = setup(rows, 25);

    await expect(service.findApplicationHistoryPage(APP_ID, 1, 20)).resolves.toEqual({
      items: rows,
      total: 25,
    });
  });

  it('is read-only: only findAndCount is used, and no write method exists on the mock', async () => {
    const { service, repositoryMock, findAndCount } = setup();

    await service.findApplicationHistoryPage(APP_ID, 1, 20);

    expect(Object.keys(repositoryMock)).toEqual(['findAndCount']);
    for (const method of WRITE_METHODS) {
      expect(repositoryMock[method]).toBeUndefined();
    }
    expect(findAndCount).toHaveBeenCalledTimes(1);
  });
});
