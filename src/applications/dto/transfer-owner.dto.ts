import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * `POST /applications/:id/transfer-owner` body (ADMIN only). There is deliberately no
 * `@IsUUID()`: the service checks the id with `existsWithRole`, so a malformed, unknown or
 * non-SALES id all get the same 400 message. Unlike `CreateApplicationDto` this uses
 * `@IsString()` rather than `@Allow()`: the route is ADMIN only and guards run before pipes, so
 * SALES gets 403 before the body is validated. The global ValidationPipe
 * (`forbidNonWhitelisted`) rejects any other key.
 */
export class TransferOwnerDto {
  @ApiProperty({ format: 'uuid', description: 'A user with role SALES' })
  @IsString()
  @IsNotEmpty()
  salesOwnerId!: string;
}
