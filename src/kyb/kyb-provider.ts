// The KYB provider contract (docs/adrs/kyb-check.md, provider). Types and injection tokens only.
// Only KybCheckProcessor calls a provider (.claude/rules/queue.md).
import { BusinessType } from '../applications/application.enums';

/**
 * What the provider sees. There is deliberately no owner, tax or contact field: the check needs
 * no PII (docs/adrs/sensitive-data.md).
 */
export interface KybProviderInput {
  applicationId: string;
  merchantCategoryCode: string;
  businessType: BusinessType;
  expectedMonthlyVolumeMinor: number;
  averageTicketSizeMinor: number;
}

export interface KybProviderResult {
  providerReference: string;
  // 0..100; a higher score means a higher risk.
  score: number;
  // Reason codes such as 'HIGH_RISK_MCC'; never PII.
  reasons: string[];
  providerVersion: string;
}

export interface KybProvider {
  check(input: KybProviderInput): Promise<KybProviderResult>;
}

export const KYB_PROVIDER = Symbol('KYB_PROVIDER');

// Returns a number in [0, 1), like Math.random. Injected so the simulated provider is testable.
export type RandomSource = () => number;
export const KYB_RANDOM = Symbol('KYB_RANDOM');

/** A provider call that failed; the worker lets BullMQ retry it. */
export class KybProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KybProviderError';
  }
}
