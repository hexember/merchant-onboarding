import { KybLevel } from '../applications/application.enums';
import { scoreToLevel } from './kyb-level';

describe('scoreToLevel', () => {
  const defaults = { mediumMin: 40, highMin: 70 };

  it.each([
    [0, KybLevel.LOW],
    [39, KybLevel.LOW],
    [40, KybLevel.MEDIUM],
    [69, KybLevel.MEDIUM],
    [70, KybLevel.HIGH],
    [78, KybLevel.HIGH],
    [100, KybLevel.HIGH],
  ])('maps %p to %p with the 40/70 thresholds', (score, level) => {
    expect(scoreToLevel(score, defaults)).toBe(level);
  });

  it('respects custom thresholds', () => {
    const custom = { mediumMin: 20, highMin: 90 };

    expect(scoreToLevel(19, custom)).toBe(KybLevel.LOW);
    expect(scoreToLevel(20, custom)).toBe(KybLevel.MEDIUM);
    expect(scoreToLevel(78, custom)).toBe(KybLevel.MEDIUM);
    expect(scoreToLevel(90, custom)).toBe(KybLevel.HIGH);
  });
});
