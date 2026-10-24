// Application enums (docs/adrs/workflow.md §1.1, §1.3; docs/adrs/database.md §`merchant_applications`).
// Each is a Postgres enum created by the migration. The `*_ENUM` constants are the type names, so
// every entity that reuses a type (e.g. the later `kyb_checks.level`) names it the same way.

export const APPLICATION_STATUS_ENUM = 'application_status';
export const KYB_STATUS_ENUM = 'kyb_status';
export const KYB_LEVEL_ENUM = 'kyb_level';
export const BUSINESS_TYPE_ENUM = 'business_type';

// Where the application is in the review workflow (docs/adrs/workflow.md §1.1).
export enum ApplicationStatus {
  DRAFT = 'DRAFT',
  RISK_REVIEW = 'RISK_REVIEW',
  UNDER_REVIEW = 'UNDER_REVIEW',
  INFO_REQUESTED = 'INFO_REQUESTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

// How far the automated KYB/risk check has got (docs/adrs/workflow.md §1.3).
export enum KybStatus {
  NOT_STARTED = 'NOT_STARTED',
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// What the KYB/risk check concluded; `null` on the application until a check completes.
export enum KybLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

// Legal form of the merchant's business.
export enum BusinessType {
  SOLE_PROPRIETORSHIP = 'SOLE_PROPRIETORSHIP',
  PARTNERSHIP = 'PARTNERSHIP',
  PRIVATE_LIMITED = 'PRIVATE_LIMITED',
  PUBLIC_LIMITED = 'PUBLIC_LIMITED',
  NON_PROFIT = 'NON_PROFIT',
}
