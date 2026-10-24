// Who performed an audited action: a logged-in user or a system component.
export enum AuditActorType {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

// Every action that writes an audit row (docs/adrs/database.md §`audit_logs`).
export enum AuditAction {
  APPLICATION_CREATED = 'APPLICATION_CREATED',
  APPLICATION_UPDATED = 'APPLICATION_UPDATED',
  APPLICATION_SUBMITTED = 'APPLICATION_SUBMITTED',
  REVIEWER_ASSIGNED = 'REVIEWER_ASSIGNED',
  OWNERSHIP_TRANSFERRED = 'OWNERSHIP_TRANSFERRED',
  KYB_CHECK_ATTEMPT_FAILED = 'KYB_CHECK_ATTEMPT_FAILED',
  KYB_CHECK_COMPLETED = 'KYB_CHECK_COMPLETED',
  KYB_CHECK_FAILED = 'KYB_CHECK_FAILED',
  DECISION_RECORDED = 'DECISION_RECORDED',
  LOGIN_SUCCEEDED = 'LOGIN_SUCCEEDED',
  LOGIN_FAILED = 'LOGIN_FAILED',
}

// The `entity_type` of every audit row about a merchant application. The single source for the
// writers (applications service, KYB worker) and the reader (AuditLogQueryService), so they cannot
// drift apart. It lives in src/audit so the audit module never imports from applications.
export const MERCHANT_APPLICATION_ENTITY_TYPE = 'merchant_application' as const;
