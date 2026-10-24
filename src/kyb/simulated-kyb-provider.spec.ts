import { ConfigService } from '@nestjs/config';
import { BusinessType } from '../applications/application.enums';
import { AppEnv } from '../config/env.validation';
import { KybProviderError, KybProviderInput, RandomSource } from './kyb-provider';
import { SimulatedKybProvider } from './simulated-kyb-provider';

// Made-up identifiers and amounts; no real merchant.
const APP_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

function lowRiskInput(): KybProviderInput {
  return {
    applicationId: APP_ID,
    merchantCategoryCode: '5411',
    businessType: BusinessType.PRIVATE_LIMITED,
    expectedMonthlyVolumeMinor: 500_000_00,
    averageTicketSizeMinor: 2_000_00,
  };
}

function configWithRate(rate: number): ConfigService<AppEnv, true> {
  const values: Partial<AppEnv> = { KYB_FAILURE_RATE: rate };
  return {
    get: jest.fn((key: keyof AppEnv) => values[key]),
  } as unknown as ConfigService<AppEnv, true>;
}

// Returns the given values in order, then repeats the last one.
function scriptedRandom(...values: number[]): RandomSource {
  let index = 0;
  return (): number => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

describe('SimulatedKybProvider', () => {
  it('rejects with KybProviderError when random() is below the failure rate', async () => {
    const provider = new SimulatedKybProvider(configWithRate(0.2), scriptedRandom(0.1));

    await expect(provider.check(lowRiskInput())).rejects.toBeInstanceOf(KybProviderError);
  });

  it('never fails with rate 0', async () => {
    const provider = new SimulatedKybProvider(configWithRate(0), scriptedRandom(0));

    for (let i = 0; i < 5; i += 1) {
      await expect(provider.check(lowRiskInput())).resolves.toMatchObject({ score: 10 });
    }
  });

  it('scores a low-risk input at the base score with no reasons', async () => {
    const provider = new SimulatedKybProvider(configWithRate(0.2), scriptedRandom(0.5, 0));

    const result = await provider.check(lowRiskInput());

    expect(result.score).toBe(10);
    expect(result.reasons).toEqual([]);
  });

  it('adds every risk factor plus the maximum jitter and stays within 0..100', async () => {
    const provider = new SimulatedKybProvider(configWithRate(0.2), scriptedRandom(0.5, 0.999));

    const result = await provider.check({
      ...lowRiskInput(),
      merchantCategoryCode: '7995',
      expectedMonthlyVolumeMinor: 20_000_000_00,
      averageTicketSizeMinor: 100_000_00,
    });

    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBe(100);
    expect(result.reasons).toEqual(['HIGH_RISK_MCC', 'HIGH_VOLUME', 'HIGH_TICKET_SIZE']);
  });

  it('returns a sim- reference and provider version sim-1', async () => {
    const provider = new SimulatedKybProvider(configWithRate(0), scriptedRandom(0));

    const result = await provider.check(lowRiskInput());

    expect(result.providerReference).toMatch(/^sim-/);
    expect(result.providerVersion).toBe('sim-1');
  });
});
