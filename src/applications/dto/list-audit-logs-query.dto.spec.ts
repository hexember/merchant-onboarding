import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from './list-applications-query.dto';
import { ListAuditLogsQueryDto } from './list-audit-logs-query.dto';

function toDto(query: Record<string, unknown>): ListAuditLogsQueryDto {
  return plainToInstance(ListAuditLogsQueryDto, query);
}

function check(query: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(toDto(query), { whitelist: true, forbidNonWhitelisted: true });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('ListAuditLogsQueryDto', () => {
  it('defaults page to 1 and limit to 20', async () => {
    const dto = toDto({});

    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    await expect(check({})).resolves.toEqual([]);
  });

  it('converts query strings to numbers', async () => {
    const dto = toDto({ page: '2', limit: '50' });

    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(50);
    await expect(check({ page: '2', limit: '50' })).resolves.toEqual([]);
  });

  it('accepts limit 100', async () => {
    expect(MAX_PAGE_SIZE).toBe(100);
    await expect(check({ limit: '100' })).resolves.toEqual([]);
  });

  it('accepts page 10000', async () => {
    expect(MAX_PAGE).toBe(10000);
    await expect(check({ page: '10000' })).resolves.toEqual([]);
  });

  it.each([
    ['limit', '0'],
    ['limit', '101'],
    ['limit', '-1'],
    ['limit', 'abc'],
    ['limit', '1.5'],
    ['page', '0'],
    ['page', '10001'],
    ['page', 'x'],
  ])('denied: %s=%p', async (key, value) => {
    expect(failedProperties(await check({ [key]: value }))).toEqual([key]);
  });

  it('has only page and limit (no status or entityType)', () => {
    expect(Object.keys(new ListAuditLogsQueryDto()).sort()).toEqual(['limit', 'page']);
  });

  it.each([
    ['status', 'DRAFT'],
    ['entityType', 'user'],
  ])('denied: the filter %s is not whitelisted', async (key, value) => {
    expect(failedProperties(await check({ [key]: value }))).toEqual([key]);
  });
});
