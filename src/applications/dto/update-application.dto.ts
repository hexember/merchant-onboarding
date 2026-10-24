import { ApiPropertyOptional } from '@nestjs/swagger';
import {
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
import {
  CURRENCY_PATTERN,
  MCC_PATTERN,
  MIN_ID_LENGTH,
  PHONE_PATTERN,
  WEBSITE_URL_OPTIONS,
} from './create-application.dto';

// Skips validation only when the key is absent. Unlike `@IsOptional()`, `null` is still validated
// (and rejected), so it never reaches a NOT NULL column.
const whenPresent = (_object: unknown, value: unknown): boolean => value !== undefined;

/**
 * `PATCH /applications/:id` body: the create fields, every one optional, minus `salesOwnerId`
 * (ownership changes only through the ADMIN transfer endpoint, so it is rejected with 400 here).
 * Only `websiteUrl` accepts `null`, which clears it. Example values are fake.
 */
export class UpdateApplicationDto {
  @ApiPropertyOptional({ example: 'Example Grocers', maxLength: 200 })
  @ValidateIf(whenPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  businessName?: string;

  @ApiPropertyOptional({ example: 'Example Grocers Pvt. Ltd.', maxLength: 200 })
  @ValidateIf(whenPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalBusinessName?: string;

  @ApiPropertyOptional({ enum: BusinessType, example: BusinessType.PRIVATE_LIMITED })
  @ValidateIf(whenPresent)
  @IsEnum(BusinessType)
  businessType?: BusinessType;

  @ApiPropertyOptional({ example: 'REG-FAKE-0001', maxLength: 50 })
  @ValidateIf(whenPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  registrationNumber?: string;

  @ApiPropertyOptional({
    example: 'PAN-FAKE-00001234',
    minLength: MIN_ID_LENGTH,
    maxLength: 50,
    description: 'Masked in responses',
  })
  @ValidateIf(whenPresent)
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_ID_LENGTH)
  @MaxLength(50)
  taxId?: string;

  @ApiPropertyOptional({ example: 'Jane Example', maxLength: 200 })
  @ValidateIf(whenPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  ownerFullName?: string;

  @ApiPropertyOptional({
    example: 'owner@example.com',
    maxLength: 254,
    description: 'Masked in responses',
  })
  @ValidateIf(whenPresent)
  @IsEmail()
  @MaxLength(254)
  ownerEmail?: string;

  @ApiPropertyOptional({
    example: '+977-0000000123',
    maxLength: 30,
    description: 'Masked in responses',
  })
  @ValidateIf(whenPresent)
  @IsString()
  @Matches(PHONE_PATTERN)
  @MaxLength(30)
  ownerPhone?: string;

  @ApiPropertyOptional({
    example: 'NID-FAKE-5678',
    minLength: MIN_ID_LENGTH,
    maxLength: 50,
    description: 'Masked in responses',
  })
  @ValidateIf(whenPresent)
  @IsString()
  @IsNotEmpty()
  @MinLength(MIN_ID_LENGTH)
  @MaxLength(50)
  ownerNationalId?: string;

  @ApiPropertyOptional({ example: '5411', pattern: MCC_PATTERN.source })
  @ValidateIf(whenPresent)
  @IsString()
  @Matches(MCC_PATTERN)
  merchantCategoryCode?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'https://shop.example.com',
    maxLength: 500,
    description: 'Send null to clear it',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsUrl(WEBSITE_URL_OPTIONS)
  @MaxLength(500)
  websiteUrl?: string | null;

  @ApiPropertyOptional({ example: 2500000, minimum: 0, description: 'Minor units (paisa)' })
  @ValidateIf(whenPresent)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  expectedMonthlyVolumeMinor?: number;

  @ApiPropertyOptional({ example: 150000, minimum: 0, description: 'Minor units (paisa)' })
  @ValidateIf(whenPresent)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  averageTicketSizeMinor?: number;

  @ApiPropertyOptional({ example: 'NPR', pattern: CURRENCY_PATTERN.source })
  @ValidateIf(whenPresent)
  @IsString()
  @Matches(CURRENCY_PATTERN)
  currency?: string;
}

/** Every field PATCH may change. The service builds the change set from the keys present. */
export const UPDATABLE_FIELDS: readonly (keyof UpdateApplicationDto)[] = [
  'businessName',
  'legalBusinessName',
  'businessType',
  'registrationNumber',
  'taxId',
  'ownerFullName',
  'ownerEmail',
  'ownerPhone',
  'ownerNationalId',
  'merchantCategoryCode',
  'websiteUrl',
  'expectedMonthlyVolumeMinor',
  'averageTicketSizeMinor',
  'currency',
];
