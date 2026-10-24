import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** `POST /auth/login` body. Unknown fields are rejected by the global ValidationPipe. */
export class LoginDto {
  @ApiProperty({ example: 'sales@example.com', maxLength: 254 })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // No example value: the docs never show a password.
  @ApiProperty({ format: 'password', maxLength: 128 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
