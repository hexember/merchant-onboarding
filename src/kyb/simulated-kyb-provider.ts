// The KybProvider the app runs with (docs/adrs/kyb-check.md, provider): a score from the MCC,
// volume and ticket size plus some randomness, with a configurable failure rate. It does no I/O
// and writes no logs. Tests use FakeKybProvider (src/kyb/testing/) instead.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppEnv } from '../config/env.validation';
import {
  KYB_RANDOM,
  KybProvider,
  KybProviderError,
  KybProviderInput,
  KybProviderResult,
  RandomSource,
} from './kyb-provider';

// All values below are made up for the simulation; they are not a real risk model.
// Merchant category codes the simulation treats as high risk (money transfer, direct marketing,
// collectibles, quasi-cash, gambling).
export const HIGH_RISK_MCCS: readonly string[] = ['4829', '5967', '5993', '6051', '7995'];
const BASE_SCORE = 10;
const HIGH_RISK_MCC_POINTS = 40;
// 10,000,000.00 a month in minor units.
const HIGH_VOLUME_MINOR = 10_000_000_00;
const HIGH_VOLUME_POINTS = 20;
// 50,000.00 per ticket in minor units.
const HIGH_TICKET_MINOR = 50_000_00;
const HIGH_TICKET_POINTS = 10;
// Random jitter of 0..20 points.
const MAX_JITTER_POINTS = 20;
const MIN_SCORE = 0;
const MAX_SCORE = 100;
const PROVIDER_VERSION = 'sim-1';

@Injectable()
export class SimulatedKybProvider implements KybProvider {
  private readonly failureRate: number;

  constructor(
    config: ConfigService<AppEnv, true>,
    @Inject(KYB_RANDOM) private readonly random: RandomSource,
  ) {
    this.failureRate = config.get('KYB_FAILURE_RATE', { infer: true });
  }

  check(input: KybProviderInput): Promise<KybProviderResult> {
    if (this.random() < this.failureRate) {
      return Promise.reject(new KybProviderError('Simulated provider unavailable'));
    }

    let score = BASE_SCORE;
    const reasons: string[] = [];
    if (HIGH_RISK_MCCS.includes(input.merchantCategoryCode)) {
      score += HIGH_RISK_MCC_POINTS;
      reasons.push('HIGH_RISK_MCC');
    }
    if (input.expectedMonthlyVolumeMinor > HIGH_VOLUME_MINOR) {
      score += HIGH_VOLUME_POINTS;
      reasons.push('HIGH_VOLUME');
    }
    if (input.averageTicketSizeMinor > HIGH_TICKET_MINOR) {
      score += HIGH_TICKET_POINTS;
      reasons.push('HIGH_TICKET_SIZE');
    }
    score += Math.floor(this.random() * (MAX_JITTER_POINTS + 1));
    score = Math.min(MAX_SCORE, Math.max(MIN_SCORE, score));

    return Promise.resolve({
      providerReference: `sim-${randomUUID()}`,
      score,
      reasons,
      providerVersion: PROVIDER_VERSION,
    });
  }
}
