import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { DEFAULT_PAGE_SIZE, MAX_PAGE, MAX_PAGE_SIZE } from './list-applications-query.dto';

/**
 * `GET /applications/:id/audit-logs` query: paging only, with the same defaults and caps as
 * `GET /applications`. There is no filter (no `status`, no `entityType`); unknown keys are
 * rejected by the global ValidationPipe (`forbidNonWhitelisted`).
 */
export class ListAuditLogsQueryDto {
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
