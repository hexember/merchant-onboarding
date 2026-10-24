import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * `POST /applications/:id/assign` body (ADMIN only). There is deliberately no `@IsUUID()`: the
 * service checks the id with `existsWithRole`, so a malformed, unknown or non-REVIEWER id all get
 * the same 400 message. The global ValidationPipe (`forbidNonWhitelisted`) rejects any other key.
 */
export class AssignReviewerDto {
  @ApiProperty({ format: 'uuid', description: 'A user with role REVIEWER' })
  @IsString()
  @IsNotEmpty()
  reviewerId!: string;
}
