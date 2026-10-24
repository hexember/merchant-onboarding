import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { ApplicationStatus } from '../application.enums';

/** Number of items returned when the client sends no `limit` (20). */
export const DEFAULT_PAGE_SIZE = 20;
/** Largest `limit` a client may ask for; a bigger value gets a 400. */
export const MAX_PAGE_SIZE = 100;
/** Caps the OFFSET scan and keeps `(page - 1) * limit` a plain integer Postgres accepts. */
export const MAX_PAGE = 10000;

/**
 * `GET /applications` query. Query values arrive as strings, so `page` and `limit` are converted
 * with `@Type(() => Number)` before validation. Unknown keys are rejected by the global
 * ValidationPipe (`forbidNonWhitelisted`).
 */
export class ListApplicationsQueryDto {
  @ApiPropertyOptional({ enum: ApplicationStatus })
  @IsOptional()
  @IsEnum(ApplicationStatus)
  status?: ApplicationStatus;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: MAX_PAGE, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page: number = 1;

  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;
}
