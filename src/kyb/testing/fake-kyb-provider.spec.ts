import { BusinessType } from '../../applications/application.enums';
import { KybProviderError, KybProviderInput } from '../kyb-provider';
import { FakeKybProvider } from './fake-kyb-provider';

// Made-up identifiers and amounts; no real merchant.
const INPUT: KybProviderInput = {
  applicationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  merchantCategoryCode: '5411',
  businessType: BusinessType.SOLE_PROPRIETORSHIP,
  expectedMonthlyVolumeMinor: 100_000_00,
  averageTicketSizeMinor: 1_000_00,
};

describe('FakeKybProvider', () => {
  let fake: FakeKybProvider;

  beforeEach(() => {
    fake = new FakeKybProvider();
  });

  it('returns the default result', async () => {
    await expect(fake.check(INPUT)).resolves.toEqual({
      providerReference: 'fake-ref-1',
      score: 78,
      reasons: ['FAKE_REASON'],
      providerVersion: 'fake-1',
    });
    await expect(fake.check(INPUT)).resolves.toMatchObject({ providerReference: 'fake-ref-2' });
  });

  it('failNext(2) fails twice, then succeeds', async () => {
    fake.failNext(2);

    await expect(fake.check(INPUT)).rejects.toBeInstanceOf(KybProviderError);
    await expect(fake.check(INPUT)).rejects.toThrow('Fake provider failure');
    await expect(fake.check(INPUT)).resolves.toMatchObject({ score: 78 });
  });

  it('alwaysFail never succeeds', async () => {
    fake.alwaysFail();

    for (let i = 0; i < 6; i += 1) {
      await expect(fake.check(INPUT)).rejects.toBeInstanceOf(KybProviderError);
    }
  });

  it('succeedWith is sticky and merges over the default', async () => {
    fake.succeedWith({ score: 12, reasons: [] });

    await expect(fake.check(INPUT)).resolves.toMatchObject({ score: 12, reasons: [] });
    await expect(fake.check(INPUT)).resolves.toMatchObject({
      score: 12,
      providerVersion: 'fake-1',
    });
  });

  it('records every call input', async () => {
    fake.failNext(1);
    await fake.check(INPUT).catch(() => undefined);
    await fake.check({ ...INPUT, merchantCategoryCode: '7995' });

    expect(fake.calls).toEqual([INPUT, { ...INPUT, merchantCategoryCode: '7995' }]);
  });

  it('reset clears calls and every scripted outcome', async () => {
    fake.alwaysFail();
    fake.failNext(3);
    fake.succeedWith({ score: 5 });
    await fake.check(INPUT).catch(() => undefined);

    fake.reset();

    expect(fake.calls).toEqual([]);
    await expect(fake.check(INPUT)).resolves.toEqual({
      providerReference: 'fake-ref-1',
      score: 78,
      reasons: ['FAKE_REASON'],
      providerVersion: 'fake-1',
    });
  });
});
