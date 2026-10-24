import { randomBytes } from 'node:crypto';
import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditLogService } from '../audit/audit-log.service';
import { maskEmail } from '../common/mask';
import { BCRYPT_COST } from '../common/password';
import { normalizeEmail } from '../users/normalize-email';
import { UsersRepository } from '../users/users.repository';
import { INVALID_CREDENTIALS_MESSAGE, JWT_EXPIRES_IN_SECONDS } from './auth.constants';
import { JwtClaims } from './auth-user';
import { LoginResponseDto } from './dto/login-response.dto';

/**
 * Checks credentials and issues access tokens (docs/adrs/auth.md §Auth details). An unknown email
 * and a wrong password give the same 401, and bcrypt `compare` runs once in both cases. Every
 * attempt writes one audit row with the email masked. Nothing here is logged.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  // bcrypt hash of random bytes, compared against when the email matches no user, so that path
  // costs about the same time as a real check. Made once per process, never stored or logged.
  private dummyHash = '';

  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly auditLogService: AuditLogService,
    private readonly jwtService: JwtService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyHash = await bcrypt.hash(randomBytes(32).toString('hex'), BCRYPT_COST);
  }

  async login(email: string, password: string): Promise<LoginResponseDto> {
    const user = await this.usersRepository.findByEmailWithPasswordHash(email);
    const matches = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash);
    const meta = { email: maskEmail(normalizeEmail(email)) };

    if (user === null || !matches) {
      // The caller is not authenticated, so there is no actor; entityId names the targeted user
      // when the email matched one.
      await this.auditLogService.record({
        actorType: AuditActorType.USER,
        actorId: null,
        actorRole: null,
        action: AuditAction.LOGIN_FAILED,
        entityType: 'user',
        entityId: user?.id ?? null,
        meta,
      });
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    await this.auditLogService.record({
      actorType: AuditActorType.USER,
      actorId: user.id,
      actorRole: user.role,
      action: AuditAction.LOGIN_SUCCEEDED,
      entityType: 'user',
      entityId: user.id,
      meta,
    });
    const claims: JwtClaims = { sub: user.id, role: user.role };
    const accessToken = await this.jwtService.signAsync(claims);
    return { accessToken, expiresIn: JWT_EXPIRES_IN_SECONDS };
  }
}
