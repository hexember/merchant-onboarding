import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { BusinessType } from '../application.enums';

// Validation formats shared by the create and update DTOs; lengths match the columns in
// docs/adrs/database.md.
// Exactly 4 digits: a merchant category code, e.g. 5411.
export const MCC_PATTERN = /^\d{4}$/;
// Exactly 3 uppercase letters: an ISO 4217 currency code, e.g. NPR.
export const CURRENCY_PATTERN = /^[A-Z]{3}$/;
// Optional leading +, a digit, then 5–28 digits/spaces/()/-: 6–29 chars, or 7–30 with the +
// (fits maxLength 30), e.g. +977-0000000123.
export const PHONE_PATTERN = /^\+?[0-9][0-9 ()-]{5,28}$/;
export const WEBSITE_URL_OPTIONS = { protocols: ['http', 'https'], require_protocol: true };
// Responses show the last 4 characters of `taxId` / `ownerNationalId`, so a short id would be
// mostly revealed. At 8 characters at least half of it stays masked.
export const MIN_ID_LENGTH = 8;

/**
 * `POST /applications` body. Server-managed fields (`createdById`, `status`, `kybStatus`,
 * `kybLevel`, `kybScore`, `version`, `meta`, ...) are not declared, so the global ValidationPipe
 * (`forbidNonWhitelisted`) rejects them with 400. Example values are fake.
 */
export class CreateApplicationDto {
  @ApiProperty({ example: 'Example Grocers', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  businessName!: string;

  @ApiProperty({ example: 'Example Grocers Pvt. Ltd.', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalBusinessName!: string;

  @ApiProperty({ enum: BusinessType, example: BusinessType.PRIVATE_LIMITED })
  @IsEnum(BusinessType)
  businessType!: BusinessType;

  @ApiProperty({ example: 'REG-FAKE-0001', maxLength: 50 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  registrationNumber!: string;

  @ApiProperty({
    example: 'PAN-FAKE-00001234',
    minLength: MIN_ID_LENGTH,
    maxLength: 50,
    description: 'Masked in responses',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_ID_LENGTH)
  @MaxLength(50)
  taxId!: string;

  @ApiProperty({ example: 'Jane Example', maxLength: 200 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  ownerFullName!: string;

  @ApiProperty({ example: 'owner@example.com', maxLength: 254, description: 'Masked in responses' })
  @IsEmail()
  @MaxLength(254)
  ownerEmail!: string;

  @ApiProperty({ example: '+977-0000000123', maxLength: 30, description: 'Masked in responses' })
  @IsString()
  @Matches(PHONE_PATTERN)
  @MaxLength(30)
  ownerPhone!: string;

  @ApiProperty({
    example: 'NID-FAKE-5678',
    minLength: MIN_ID_LENGTH,
    maxLength: 50,
    description: 'Masked in responses',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_ID_LENGTH)
  @MaxLength(50)
  ownerNationalId!: string;

  @ApiProperty({ example: '5411', pattern: MCC_PATTERN.source })
  @IsString()
  @Matches(MCC_PATTERN)
  merchantCategoryCode!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://shop.example.com',
    maxLength: 500,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsUrl(WEBSITE_URL_OPTIONS)
  @MaxLength(500)
  websiteUrl?: string | null;

  @ApiProperty({ example: 2500000, minimum: 0, description: 'Minor units (paisa)' })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedMonthlyVolumeMinor!: number;

  @ApiProperty({ example: 150000, minimum: 0, description: 'Minor units (paisa)' })
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  averageTicketSizeMinor!: number;

  // `null` is checked (and rejected) rather than skipped, so it never reaches the NOT NULL column.
  @ApiPropertyOptional({ example: 'NPR', default: 'NPR', pattern: CURRENCY_PATTERN.source })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsString()
  @Matches(CURRENCY_PATTERN)
  currency?: string;

  // `@Allow()` only whitelists the key: there is deliberately no format check here, so every value
  // from SALES reaches the service and gets 403, and the service validates it for ADMIN (400).
  // Hence the `unknown` type: nothing has checked its shape before the service narrows it.
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'ADMIN only; required for ADMIN, rejected (403) for SALES',
  })
  @Allow()
  salesOwnerId?: unknown;
}
