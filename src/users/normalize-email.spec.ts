import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail(' Admin@Example.COM ')).toBe('admin@example.com');
  });
});
