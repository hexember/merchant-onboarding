import { UserRole } from '../common/common.enums';
import { ApplicationStatus } from './application.enums';

// The application state machine: docs/adrs/workflow.md §1.2, encoded as data.
// This module is the single source of truth for which status changes and which status-preserving
// operations are allowed. It is pure (no Nest, no TypeORM, no I/O).
//
// The `guard` text and the "owner" / "assigned" part of `who` are descriptive only. The actor
// scope comes from `ApplicationsRepository`, and each guard is enforced by the item that
// implements the action. The APPROVE guard (`kybStatus = COMPLETED`, see `requiresCompletedKyb`)
// is enforced by `ApplicationsService.decide` and again in the WHERE of
// `ApplicationsRepository.decideIfAllowed`. Anything not in `TRANSITIONS` is an invalid
// transition (409 `INVALID_STATE_TRANSITION`).

/** Every action that changes `status`. */
export enum TransitionAction {
  SUBMIT = 'SUBMIT',
  KYB_COMPLETE = 'KYB_COMPLETE',
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  REQUEST_INFO = 'REQUEST_INFO',
}

/** Who triggers a transition: a user through the API, or the system (the KYB worker). */
export enum TransitionActorType {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

/** The only system action. It has no HTTP endpoint (docs/adrs/workflow.md §1.2). */
export type SystemTransitionAction = TransitionAction.KYB_COMPLETE;

/** Actions a user may trigger. `KYB_COMPLETE` is excluded at compile time. */
export type UserTransitionAction = Exclude<TransitionAction, SystemTransitionAction>;

/** The reviewer decisions (`POST /applications/:id/decision`). No SUBMIT, no KYB_COMPLETE. */
export type DecisionAction =
  TransitionAction.APPROVE | TransitionAction.REJECT | TransitionAction.REQUEST_INFO;

export const DECISION_ACTIONS: readonly DecisionAction[] = [
  TransitionAction.APPROVE,
  TransitionAction.REJECT,
  TransitionAction.REQUEST_INFO,
];

/** True when the decision needs `kybStatus = COMPLETED` first (APPROVE only). */
export function requiresCompletedKyb(action: DecisionAction): boolean {
  return action === TransitionAction.APPROVE;
}

/** One row of the transition table. */
export interface Transition {
  readonly from: ApplicationStatus;
  readonly action: TransitionAction;
  readonly to: ApplicationStatus;
  readonly actorType: TransitionActorType;
  readonly roles: readonly UserRole[];
  readonly who: string;
  readonly guard: string | null;
}

/** docs/adrs/workflow.md §1.2 transition table, row for row. */
export const TRANSITIONS: readonly Transition[] = [
  {
    from: ApplicationStatus.DRAFT,
    action: TransitionAction.SUBMIT,
    to: ApplicationStatus.RISK_REVIEW,
    actorType: TransitionActorType.USER,
    roles: [UserRole.ADMIN, UserRole.SALES],
    who: 'owner SALES, ADMIN',
    guard: null,
  },
  {
    from: ApplicationStatus.INFO_REQUESTED,
    action: TransitionAction.SUBMIT,
    to: ApplicationStatus.RISK_REVIEW,
    actorType: TransitionActorType.USER,
    roles: [UserRole.ADMIN, UserRole.SALES],
    who: 'owner SALES, ADMIN',
    guard: null,
  },
  {
    from: ApplicationStatus.RISK_REVIEW,
    action: TransitionAction.KYB_COMPLETE,
    to: ApplicationStatus.UNDER_REVIEW,
    actorType: TransitionActorType.SYSTEM,
    roles: [],
    who: 'system (worker) only',
    guard: "job's submission_no = current submission_count",
  },
  {
    from: ApplicationStatus.UNDER_REVIEW,
    action: TransitionAction.APPROVE,
    to: ApplicationStatus.APPROVED,
    actorType: TransitionActorType.USER,
    roles: [UserRole.REVIEWER],
    who: 'assigned REVIEWER',
    guard: 'kybStatus = COMPLETED',
  },
  {
    from: ApplicationStatus.UNDER_REVIEW,
    action: TransitionAction.REJECT,
    to: ApplicationStatus.REJECTED,
    actorType: TransitionActorType.USER,
    roles: [UserRole.REVIEWER],
    who: 'assigned REVIEWER',
    guard: null,
  },
  {
    from: ApplicationStatus.UNDER_REVIEW,
    action: TransitionAction.REQUEST_INFO,
    to: ApplicationStatus.INFO_REQUESTED,
    actorType: TransitionActorType.USER,
    roles: [UserRole.REVIEWER],
    who: 'assigned REVIEWER',
    guard: null,
  },
];

/** The row matching all three, or `null`. */
function findTransition(
  from: ApplicationStatus,
  action: TransitionAction,
  actorType: TransitionActorType,
): Transition | null {
  const row = TRANSITIONS.find(
    (t) => t.from === from && t.action === action && t.actorType === actorType,
  );
  return row ?? null;
}

/**
 * The status a user action leads to from `from`, or `null` when the table has no such row.
 * Only USER rows are searched, so even a cast `KYB_COMPLETE` returns `null` at runtime.
 */
export function nextStatus(
  from: ApplicationStatus,
  action: UserTransitionAction,
): ApplicationStatus | null {
  const row = findTransition(from, action, TransitionActorType.USER);
  return row === null ? null : row.to;
}

/**
 * The status a system action leads to from `from`, or `null`. For the KYB worker only:
 * never call this from a request path.
 */
export function nextSystemStatus(
  from: ApplicationStatus,
  action: SystemTransitionAction,
): ApplicationStatus | null {
  const row = findTransition(from, action, TransitionActorType.SYSTEM);
  return row === null ? null : row.to;
}

/** The `from` status of every USER row for `action`, in table order. */
export function fromStatuses(action: UserTransitionAction): readonly ApplicationStatus[] {
  return TRANSITIONS.filter(
    (t) => t.action === action && t.actorType === TransitionActorType.USER,
  ).map((t) => t.from);
}

/** True when some USER row for `action` lists `role`. */
export function isRoleAllowed(action: UserTransitionAction, role: UserRole): boolean {
  return TRANSITIONS.some(
    (t) =>
      t.action === action && t.actorType === TransitionActorType.USER && t.roles.includes(role),
  );
}

/** Operations that do not change `status` (docs/adrs/workflow.md §1.2). */
export enum ApplicationOperation {
  UPDATE = 'UPDATE',
  ASSIGN = 'ASSIGN',
  TRANSFER_OWNER = 'TRANSFER_OWNER',
}

/** Where an operation is allowed and who may perform it. */
export interface OperationRule {
  readonly allowedIn: readonly ApplicationStatus[];
  readonly roles: readonly UserRole[];
  readonly who: string;
}

/** docs/adrs/workflow.md §1.2 "Operations that do not change status", row for row. */
export const OPERATIONS: Readonly<Record<ApplicationOperation, OperationRule>> = {
  [ApplicationOperation.UPDATE]: {
    allowedIn: [ApplicationStatus.DRAFT, ApplicationStatus.INFO_REQUESTED],
    roles: [UserRole.ADMIN, UserRole.SALES],
    who: 'owner SALES, ADMIN',
  },
  [ApplicationOperation.ASSIGN]: {
    allowedIn: [
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.INFO_REQUESTED,
    ],
    roles: [UserRole.ADMIN],
    who: 'ADMIN (target must have role REVIEWER)',
  },
  [ApplicationOperation.TRANSFER_OWNER]: {
    // Every non-terminal status.
    allowedIn: [
      ApplicationStatus.DRAFT,
      ApplicationStatus.RISK_REVIEW,
      ApplicationStatus.UNDER_REVIEW,
      ApplicationStatus.INFO_REQUESTED,
    ],
    roles: [UserRole.ADMIN],
    who: 'ADMIN (target must have role SALES)',
  },
};

/** True when `operation` is allowed while the application is in `status`. */
export function isOperationAllowed(
  operation: ApplicationOperation,
  status: ApplicationStatus,
): boolean {
  return OPERATIONS[operation].allowedIn.includes(status);
}

/** The statuses in which `operation` is allowed. Spread (`[...x]`) before passing to TypeORM. */
export function allowedStatuses(operation: ApplicationOperation): readonly ApplicationStatus[] {
  return OPERATIONS[operation].allowedIn;
}
