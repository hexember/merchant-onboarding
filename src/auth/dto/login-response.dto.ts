import { ApiProperty } from '@nestjs/swagger';

/** `POST /auth/login` response. */
export class LoginResponseDto {
  @ApiProperty({ description: 'HS256 JWT; send as Authorization: Bearer <token>' })
  accessToken!: string;

  @ApiProperty({ example: 3600, description: 'Lifetime in seconds' })
  expiresIn!: number;
}
