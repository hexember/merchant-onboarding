import { MASK, maskEmail, maskLast4, maskPhone, maskSensitiveFields } from './mask';

describe('maskLast4', () => {
  it('keeps only the last 4 characters', () => {
    expect(maskLast4('PAN123456789')).toBe('••••••6789');
  });

  it.each(['1234', ''])('never reveals a short value %p in full', (value) => {
    expect(maskLast4(value)).toBe('••••••');
  });
});

describe('maskEmail', () => {
  it('keeps the first character and the domain', () => {
    expect(maskEmail('jane@example.com')).toBe('j•••@example.com');
  });

  it.each(['not-an-email', '@example.com'])('returns ••• for malformed %p', (value) => {
    expect(maskEmail(value)).toBe('•••');
  });
});

describe('maskPhone', () => {
  it('keeps the last 3 digits and ignores non-digits', () => {
    expect(maskPhone('+977-9800000123')).toBe('••••••123');
  });

  it('returns MASK when there are fewer than 3 digits', () => {
    expect(maskPhone('12')).toBe('••••••');
  });
});

describe('maskSensitiveFields', () => {
  it('masks sensitive keys at any depth', () => {
    const input = {
      taxId: 'PAN123456789',
      owner: {
        ownerNationalId: 'NID000011112222',
        ownerEmail: 'jane@example.com',
        ownerPhone: '+977-9800000123',
      },
      contacts: [{ email: 'sam@example.com' }, { tax_id: 'TAX987654321' }],
    };

    expect(maskSensitiveFields(input)).toEqual({
      taxId: '••••••6789',
      owner: {
        ownerNationalId: '••••••2222',
        ownerEmail: 'j•••@example.com',
        ownerPhone: '••••••123',
      },
      contacts: [{ email: 's•••@example.com' }, { tax_id: '••••••4321' }],
    });
  });

  it('masks a non-string value under a sensitive key as MASK', () => {
    expect(maskSensitiveFields({ taxId: 123456789, ownerPhone: null, email: { a: 1 } })).toEqual({
      taxId: MASK,
      ownerPhone: MASK,
      email: MASK,
    });
  });

  it.each([
    ['oldTaxId', 'TAX111122223333', '••••••3333'],
    ['previousTaxId', 'TAX111122224444', '••••••4444'],
    ['new_tax_id', 'TAX111122225555', '••••••5555'],
    ['nationalId', 'NID000011116666', '••••••6666'],
    ['national_id', 'NID000011117777', '••••••7777'],
    ['ownerEmailAddress', 'jane@example.com', 'j•••@example.com'],
    ['contactEmail', 'sam@example.com', 's•••@example.com'],
    ['phone', '+977-9800000321', '••••••321'],
    ['ownerPhoneNumber', '+977-9800000654', '••••••654'],
  ])('masks %p because its name contains a sensitive part', (key, raw, masked) => {
    expect(maskSensitiveFields({ [key]: raw, keep: 'ok' })).toEqual({ [key]: masked, keep: 'ok' });
  });

  it('masks a non-string value under a substring-matched key as MASK', () => {
    expect(maskSensitiveFields({ emailVerified: true, previousTaxId: 42 })).toEqual({
      emailVerified: MASK,
      previousTaxId: MASK,
    });
  });

  it('leaves other keys unchanged', () => {
    const input = { name: 'Riley Reviewer', count: 2, tags: ['a', 'b'] };

    expect(maskSensitiveFields(input)).toEqual(input);
  });

  it('does not mutate the input', () => {
    const input = { taxId: 'PAN123456789', nested: { email: 'jane@example.com' } };

    maskSensitiveFields(input);

    expect(input).toEqual({ taxId: 'PAN123456789', nested: { email: 'jane@example.com' } });
  });

  it('masks inside class instances instead of passing them through', () => {
    class Owner {
      constructor(
        public readonly email: string,
        public readonly taxId: string,
      ) {}
    }

    expect(maskSensitiveFields({ owner: new Owner('jane@example.com', 'PAN123456789') })).toEqual({
      owner: { email: 'j•••@example.com', taxId: '••••••6789' },
    });
  });

  it('passes primitives through', () => {
    expect(maskSensitiveFields('text')).toBe('text');
    expect(maskSensitiveFields(null)).toBeNull();
  });
});
