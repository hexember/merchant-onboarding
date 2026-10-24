import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';

describe('AuthController', () => {
  it('delegates to AuthService.login with the DTO fields and returns its result', async () => {
    const result: LoginResponseDto = { accessToken: 'fixture-token', expiresIn: 3600 };
    const login = jest.fn().mockResolvedValue(result);
    const controller = new AuthController({ login } as unknown as AuthService);
    const dto = Object.assign(new LoginDto(), {
      email: 'sales@example.com',
      password: 'fixture-password',
    });

    await expect(controller.login(dto)).resolves.toBe(result);
    expect(login).toHaveBeenCalledWith('sales@example.com', 'fixture-password');
  });
});
