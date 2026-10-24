// TEST ONLY. A deterministic KybProvider for unit and e2e tests (docs/adrs/testing.md,
// determinism). It is never registered in KybModule: tests swap it in with
// `overrideProvider(KYB_PROVIDER)`. tsconfig.build.json excludes src/**/testing/**, so it never
// ships in dist/. No randomness and no timers: every outcome is scripted.
import {
  KybProvider,
  KybProviderError,
  KybProviderInput,
  KybProviderResult,
} from '../kyb-provider';

const DEFAULT_SCORE = 78;
const DEFAULT_REASONS: readonly string[] = ['FAKE_REASON'];
const DEFAULT_PROVIDER_VERSION = 'fake-1';

export class FakeKybProvider implements KybProvider {
  /** Every input the provider was called with, in order. */
  readonly calls: KybProviderInput[] = [];

  private failuresLeft = 0;
  private failAlways = false;
  private override: Partial<KybProviderResult> = {};

  /** The next `times` calls fail; later calls succeed again. */
  failNext(times = 1): void {
    this.failuresLeft += times;
  }

  /** Every later call fails until `reset()`. */
  alwaysFail(): void {
    this.failAlways = true;
  }

  /** Sticky: every later successful call returns the default result merged with `result`. */
  succeedWith(result: Partial<KybProviderResult>): void {
    this.override = { ...result };
  }

  /** Clears the recorded calls and every scripted outcome. */
  reset(): void {
    this.calls.length = 0;
    this.failuresLeft = 0;
    this.failAlways = false;
    this.override = {};
  }

  check(input: KybProviderInput): Promise<KybProviderResult> {
    this.calls.push({ ...input });
    if (this.failAlways || this.failuresLeft > 0) {
      if (this.failuresLeft > 0) {
        this.failuresLeft -= 1;
      }
      return Promise.reject(new KybProviderError('Fake provider failure'));
    }
    return Promise.resolve({
      providerReference: `fake-ref-${this.calls.length}`,
      score: DEFAULT_SCORE,
      reasons: [...DEFAULT_REASONS],
      providerVersion: DEFAULT_PROVIDER_VERSION,
      ...this.override,
    });
  }
}
