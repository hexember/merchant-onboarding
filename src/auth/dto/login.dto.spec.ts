import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { LoginDto } from './login.dto';

// Obviously fake value: only its shape matters to the validator.
const FAKE_PASSWORD = 'fixture-password';

function check(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(plainToInstance(LoginDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('LoginDto', () => {
  it('accepts a valid email and password', async () => {
    await expect(check({ email: 'sales@example.com', password: FAKE_PASSWORD })).resolves.toEqual(
      [],
    );
  });

  it('denied: an invalid email', async () => {
    const errors = await check({ email: 'not-an-email', password: FAKE_PASSWORD });

    expect(failedProperties(errors)).toEqual(['email']);
  });

  it('denied: a 255-character email', async () => {
    const domain = '@example.com';
    const email = 'a'.repeat(255 - domain.length) + domain;
    expect(email).toHaveLength(255);

    const errors = await check({ email, password: FAKE_PASSWORD });

    expect(failedProperties(errors)).toEqual(['email']);
  });

  it('denied: a missing password', async () => {
    const errors = await check({ email: 'sales@example.com' });

    expect(failedProperties(errors)).toEqual(['password']);
  });

  it('denied: an empty password', async () => {
    const errors = await check({ email: 'sales@example.com', password: '' });

    expect(failedProperties(errors)).toEqual(['password']);
  });

  it('denied: a 129-character password', async () => {
    const errors = await check({ email: 'sales@example.com', password: 'x'.repeat(129) });

    expect(failedProperties(errors)).toEqual(['password']);
  });

  it('denied: an extra property, and the error names it', async () => {
    const errors = await check({
      email: 'sales@example.com',
      password: FAKE_PASSWORD,
      role: 'ADMIN',
    });

    expect(failedProperties(errors)).toEqual(['role']);
  });
});
