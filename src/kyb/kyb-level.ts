// Maps a KYB score to a level (docs/adrs/workflow.md §1.3). A higher score means a higher risk:
// the ADR example 78 is HIGH with the default thresholds 40 / 70.
import { KybLevel } from '../applications/application.enums';

export interface KybScoreThresholds {
  // Lowest score that is MEDIUM.
  mediumMin: number;
  // Lowest score that is HIGH.
  highMin: number;
}

export function scoreToLevel(score: number, thresholds: KybScoreThresholds): KybLevel {
  if (score >= thresholds.highMin) {
    return KybLevel.HIGH;
  }
  if (score >= thresholds.mediumMin) {
    return KybLevel.MEDIUM;
  }
  return KybLevel.LOW;
}
