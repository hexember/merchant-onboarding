import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { ApplicationStatus } from '../application.enums';
import {
  DEFAULT_PAGE_SIZE,
  ListApplicationsQueryDto,
  MAX_PAGE,
  MAX_PAGE_SIZE,
} from './list-applications-query.dto';

function toDto(query: Record<string, unknown>): ListApplicationsQueryDto {
  return plainToInstance(ListApplicationsQueryDto, query);
}

function check(query: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(toDto(query), { whitelist: true, forbidNonWhitelisted: true });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('ListApplicationsQueryDto', () => {
  it('defaults page to 1 and limit to 20', async () => {
    const dto = toDto({});

    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(20);
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('converts query strings to numbers', async () => {
    const dto = toDto({ page: '2', limit: '5' });

    expect(dto.page).toBe(2);
    expect(dto.limit).toBe(5);
    await expect(validate(dto)).resolves.toEqual([]);
  });

  it('accepts a status filter', async () => {
    await expect(check({ status: ApplicationStatus.INFO_REQUESTED })).resolves.toEqual([]);
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
    ['status', 'BOGUS'],
    ['page', '0'],
    ['page', '10001'],
    ['page', '1e20'],
    ['page', 'abc'],
    ['limit', '0'],
    ['limit', '101'],
    ['limit', '1.5'],
  ])('denied: %s=%p', async (key, value) => {
    expect(failedProperties(await check({ [key]: value }))).toEqual([key]);
  });

  it('denied: an unknown query key', async () => {
    expect(failedProperties(await check({ foo: '1' }))).toEqual(['foo']);
  });
});
