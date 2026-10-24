import { ApiProperty } from '@nestjs/swagger';
import { maskEmail, maskLast4, maskPhone } from '../../common/mask';
import { ApplicationStatus, BusinessType, KybLevel, KybStatus } from '../application.enums';
import { MerchantApplication } from '../merchant-application.entity';

/**
 * An application as returned by the API. Sensitive fields are masked
 * (docs/adrs/sensitive-data.md); `meta`, `version` and `submissionCount` are never returned. The
 * KYB fields appear only through `kybCheck` on the detail response (`ApplicationDetailResponseDto`).
 */
export class ApplicationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty({ format: 'uuid' })
  salesOwnerId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assignedReviewerId!: string | null;

  @ApiProperty({ example: 'Example Grocers' })
  businessName!: string;

  @ApiProperty({ example: 'Example Grocers Pvt. Ltd.' })
  legalBusinessName!: string;

  @ApiProperty({ enum: BusinessType })
  businessType!: BusinessType;

  @ApiProperty({ example: 'REG-FAKE-0001' })
  registrationNumber!: string;

  @ApiProperty({ example: '••••••1234', description: 'Masked: last 4 characters only' })
  taxId!: string;

  @ApiProperty({ example: 'Jane Example' })
  ownerFullName!: string;

  @ApiProperty({ example: 'o•••@example.com', description: 'Masked' })
  ownerEmail!: string;

  @ApiProperty({ example: '••••••123', description: 'Masked: last 3 digits only' })
  ownerPhone!: string;

  @ApiProperty({ example: '••••••5678', description: 'Masked: last 4 characters only' })
  ownerNationalId!: string;

  @ApiProperty({ example: '5411' })
  merchantCategoryCode!: string;

  @ApiProperty({ type: String, nullable: true, example: 'https://shop.example.com' })
  websiteUrl!: string | null;

  @ApiProperty({ example: 2500000, description: 'Minor units (paisa)' })
  expectedMonthlyVolumeMinor!: number;

  @ApiProperty({ example: 150000, description: 'Minor units (paisa)' })
  averageTicketSizeMinor!: number;

  @ApiProperty({ example: 'NPR' })
  currency!: string;

  @ApiProperty({ enum: ApplicationStatus })
  status!: ApplicationStatus;

  @ApiProperty({ type: String, nullable: true })
  decisionNote!: string | null;

  @ApiProperty({ type: Date, nullable: true })
  submittedAt!: Date | null;

  @ApiProperty({ type: Date, nullable: true })
  decidedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/**
 * Human-readable label for each KYB level (docs/adrs/workflow.md §1.4). Derived in the response,
 * never stored.
 */
export const KYB_LEVEL_LABELS: Readonly<Record<KybLevel, string>> = {
  [KybLevel.LOW]: 'Good to go',
  [KybLevel.MEDIUM]: 'Fair deal',
  [KybLevel.HIGH]: 'Needs double check',
};

/** The label for a KYB level; `null` (no completed check) has no label. */
export function kybLevelLabel(level: KybLevel | null): string | null {
  return level === null ? null : KYB_LEVEL_LABELS[level];
}

/** The `kybCheck` block of `GET /applications/:id` (docs/adrs/workflow.md §1.4). Output only. */
export class KybCheckResponseDto {
  @ApiProperty({ enum: KybStatus, example: KybStatus.COMPLETED })
  status!: KybStatus;

  @ApiProperty({ enum: KybLevel, nullable: true, example: KybLevel.HIGH })
  level!: KybLevel | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Needs double check',
    description: 'Derived from level; null when there is no level',
  })
  label!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 78, description: '0-100' })
  score!: number | null;

  @ApiProperty({ example: 1 })
  attempts!: number;

  @ApiProperty({ type: Date, nullable: true })
  lastAttemptAt!: Date | null;
}

/** `GET /applications/:id` response: the masked application plus its `kybCheck` block. */
export class ApplicationDetailResponseDto extends ApplicationResponseDto {
  @ApiProperty({ type: KybCheckResponseDto })
  kybCheck!: KybCheckResponseDto;
}

/** `GET /applications` response: one page, newest first. */
export class ApplicationListResponseDto {
  @ApiProperty({ type: [ApplicationResponseDto] })
  items!: ApplicationResponseDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;

  @ApiProperty({ example: 1, description: 'Rows visible to the caller across all pages' })
  total!: number;
}

/**
 * Builds the response field by field (an explicit allow-list, never a spread of the entity), so
 * a new entity column is never returned by accident, and masks the sensitive fields.
 */
export function toApplicationResponse(app: MerchantApplication): ApplicationResponseDto {
  return {
    id: app.id,
    createdById: app.createdById,
    salesOwnerId: app.salesOwnerId,
    assignedReviewerId: app.assignedReviewerId,
    businessName: app.businessName,
    legalBusinessName: app.legalBusinessName,
    businessType: app.businessType,
    registrationNumber: app.registrationNumber,
    taxId: maskLast4(app.taxId),
    ownerFullName: app.ownerFullName,
    ownerEmail: maskEmail(app.ownerEmail),
    ownerPhone: maskPhone(app.ownerPhone),
    ownerNationalId: maskLast4(app.ownerNationalId),
    merchantCategoryCode: app.merchantCategoryCode,
    websiteUrl: app.websiteUrl,
    expectedMonthlyVolumeMinor: app.expectedMonthlyVolumeMinor,
    averageTicketSizeMinor: app.averageTicketSizeMinor,
    currency: app.currency,
    status: app.status,
    decisionNote: app.decisionNote,
    submittedAt: app.submittedAt,
    decidedAt: app.decidedAt,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
  };
}

/**
 * The detail response: the allow-listed, masked `toApplicationResponse` output (never a spread of
 * the entity) plus the `kybCheck` block, whose `label` is derived here.
 */
export function toApplicationDetailResponse(
  app: MerchantApplication,
): ApplicationDetailResponseDto {
  return {
    ...toApplicationResponse(app),
    kybCheck: {
      status: app.kybStatus,
      level: app.kybLevel,
      label: kybLevelLabel(app.kybLevel),
      score: app.kybScore,
      attempts: app.kybAttempts,
      lastAttemptAt: app.kybLastAttemptAt,
    },
  };
}
