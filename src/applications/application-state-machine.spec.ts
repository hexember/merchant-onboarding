import { UserRole } from '../common/common.enums';
import { ApplicationStatus } from './application.enums';
import {
  ApplicationOperation,
  OPERATIONS,
  TERMINAL_STATUSES,
  TRANSITIONS,
  TransitionAction,
  TransitionActorType,
  USER_TRANSITION_ACTIONS,
  UserTransitionAction,
  allowedStatuses,
  canTransition,
  fromStatuses,
  isOperationAllowed,
  isRoleAllowed,
  nextStatus,
  nextSystemStatus,
} from './application-state-machine';

const S = ApplicationStatus;
const A = TransitionAction;
const ALL_STATUSES = Object.values(ApplicationStatus);

// Every status must be classified here, so a new enum value fails until it is.
// A missing action means "not allowed from this status".
const EXPECTED: Record<
  ApplicationStatus,
  Partial<Record<UserTransitionAction, ApplicationStatus>>
> = {
  [S.DRAFT]: { [A.SUBMIT]: S.RISK_REVIEW },
  [S.INFO_REQUESTED]: { [A.SUBMIT]: S.RISK_REVIEW },
  [S.RISK_REVIEW]: {},
  [S.UNDER_REVIEW]: {
    [A.APPROVE]: S.APPROVED,
    [A.REJECT]: S.REJECTED,
    [A.REQUEST_INFO]: S.INFO_REQUESTED,
  },
  [S.APPROVED]: {},
  [S.REJECTED]: {},
};

const STATUS_ACTION_PAIRS: [ApplicationStatus, UserTransitionAction][] = ALL_STATUSES.flatMap(
  (status) =>
    USER_TRANSITION_ACTIONS.map((action): [ApplicationStatus, UserTransitionAction] => [
      status,
      action,
    ]),
);

describe('application state machine', () => {
  describe('user transitions, every (status, action) pair', () => {
    it('classifies every status', () => {
      expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_STATUSES].sort());
    });

    it('covers 24 pairs', () => {
      expect(STATUS_ACTION_PAIRS).toHaveLength(24);
    });

    it.each(STATUS_ACTION_PAIRS)('%s --%s-->', (status, action) => {
      const expected = EXPECTED[status][action] ?? null;
      expect(nextStatus(status, action)).toBe(expected);
      expect(canTransition(status, action)).toBe(expected !== null);
    });

    it.each([
      [S.RISK_REVIEW, A.SUBMIT],
      [S.UNDER_REVIEW, A.SUBMIT],
      [S.APPROVED, A.SUBMIT],
      [S.REJECTED, A.SUBMIT],
      [S.DRAFT, A.APPROVE],
      [S.RISK_REVIEW, A.APPROVE],
      [S.RISK_REVIEW, A.REJECT],
      [S.RISK_REVIEW, A.REQUEST_INFO],
    ] as [ApplicationStatus, UserTransitionAction][])('rejects %s --%s-->', (status, action) => {
      expect(nextStatus(status, action)).toBeNull();
      expect(canTransition(status, action)).toBe(false);
    });

    it.each(TERMINAL_STATUSES)('allows nothing from terminal status %s', (status) => {
      for (const action of USER_TRANSITION_ACTIONS) {
        expect(nextStatus(status, action)).toBeNull();
      }
      expect(TRANSITIONS.filter((t) => t.from === status)).toEqual([]);
    });
  });

  describe('KYB_COMPLETE is unreachable from user actions', () => {
    it('is not a user action', () => {
      expect(USER_TRANSITION_ACTIONS).not.toContain(A.KYB_COMPLETE);
    });

    it('user actions plus KYB_COMPLETE classify every action', () => {
      expect([...USER_TRANSITION_ACTIONS, A.KYB_COMPLETE].sort()).toEqual(
        Object.values(TransitionAction).sort(),
      );
    });

    it.each(ALL_STATUSES)('nextStatus(%s, KYB_COMPLETE cast) is null', (status) => {
      expect(nextStatus(status, A.KYB_COMPLETE as unknown as UserTransitionAction)).toBeNull();
      expect(canTransition(status, A.KYB_COMPLETE as unknown as UserTransitionAction)).toBe(false);
    });

    it('no user action from any status yields UNDER_REVIEW', () => {
      for (const [status, action] of STATUS_ACTION_PAIRS) {
        expect(nextStatus(status, action)).not.toBe(S.UNDER_REVIEW);
      }
    });

    it('every KYB_COMPLETE row is SYSTEM with no roles', () => {
      const rows = TRANSITIONS.filter((t) => t.action === A.KYB_COMPLETE);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.actorType).toBe(TransitionActorType.SYSTEM);
        expect(row.roles).toEqual([]);
      }
    });

    it('no SYSTEM row uses a user action', () => {
      const systemRows = TRANSITIONS.filter((t) => t.actorType === TransitionActorType.SYSTEM);
      for (const row of systemRows) {
        expect(USER_TRANSITION_ACTIONS as readonly TransitionAction[]).not.toContain(row.action);
      }
    });

    it.each(ALL_STATUSES)('nextSystemStatus(%s, KYB_COMPLETE)', (status) => {
      const expected = status === S.RISK_REVIEW ? S.UNDER_REVIEW : null;
      expect(nextSystemStatus(status, A.KYB_COMPLETE)).toBe(expected);
    });
  });

  describe('table integrity', () => {
    it('has no duplicate (from, action) row', () => {
      const keys = TRANSITIONS.map((t) => `${t.from}:${t.action}`);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it('has no row starting in a terminal status', () => {
      for (const row of TRANSITIONS) {
        expect(TERMINAL_STATUSES).not.toContain(row.from);
      }
    });

    it('terminal statuses are APPROVED and REJECTED', () => {
      expect(TERMINAL_STATUSES).toEqual([S.APPROVED, S.REJECTED]);
    });

    it('matches the ADR table exactly', () => {
      const USER = TransitionActorType.USER;
      const SYSTEM = TransitionActorType.SYSTEM;
      expect(TRANSITIONS).toEqual([
        {
          from: S.DRAFT,
          action: A.SUBMIT,
          to: S.RISK_REVIEW,
          actorType: USER,
          roles: [UserRole.ADMIN, UserRole.SALES],
          who: 'owner SALES, ADMIN',
          guard: null,
        },
        {
          from: S.INFO_REQUESTED,
          action: A.SUBMIT,
          to: S.RISK_REVIEW,
          actorType: USER,
          roles: [UserRole.ADMIN, UserRole.SALES],
          who: 'owner SALES, ADMIN',
          guard: null,
        },
        {
          from: S.RISK_REVIEW,
          action: A.KYB_COMPLETE,
          to: S.UNDER_REVIEW,
          actorType: SYSTEM,
          roles: [],
          who: 'system (worker) only',
          guard: "job's submission_no = current submission_count",
        },
        {
          from: S.UNDER_REVIEW,
          action: A.APPROVE,
          to: S.APPROVED,
          actorType: USER,
          roles: [UserRole.REVIEWER],
          who: 'assigned REVIEWER',
          guard: 'kybStatus = COMPLETED',
        },
        {
          from: S.UNDER_REVIEW,
          action: A.REJECT,
          to: S.REJECTED,
          actorType: USER,
          roles: [UserRole.REVIEWER],
          who: 'assigned REVIEWER',
          guard: null,
        },
        {
          from: S.UNDER_REVIEW,
          action: A.REQUEST_INFO,
          to: S.INFO_REQUESTED,
          actorType: USER,
          roles: [UserRole.REVIEWER],
          who: 'assigned REVIEWER',
          guard: null,
        },
      ]);
    });
  });

  describe('fromStatuses', () => {
    it('SUBMIT starts in DRAFT and INFO_REQUESTED, in table order', () => {
      expect(fromStatuses(A.SUBMIT)).toEqual([S.DRAFT, S.INFO_REQUESTED]);
    });

    it('APPROVE starts in UNDER_REVIEW', () => {
      expect(fromStatuses(A.APPROVE)).toEqual([S.UNDER_REVIEW]);
    });

    it('ignores a cast KYB_COMPLETE', () => {
      expect(fromStatuses(A.KYB_COMPLETE as unknown as UserTransitionAction)).toEqual([]);
    });
  });

  describe('isRoleAllowed', () => {
    it.each([
      [A.SUBMIT, UserRole.ADMIN, true],
      [A.SUBMIT, UserRole.SALES, true],
      [A.SUBMIT, UserRole.REVIEWER, false],
      [A.APPROVE, UserRole.REVIEWER, true],
      [A.APPROVE, UserRole.ADMIN, false],
      [A.APPROVE, UserRole.SALES, false],
      [A.REJECT, UserRole.REVIEWER, true],
      [A.REJECT, UserRole.ADMIN, false],
      [A.REJECT, UserRole.SALES, false],
      [A.REQUEST_INFO, UserRole.REVIEWER, true],
      [A.REQUEST_INFO, UserRole.ADMIN, false],
      [A.REQUEST_INFO, UserRole.SALES, false],
    ] as [UserTransitionAction, UserRole, boolean][])('%s by %s → %s', (action, role, expected) => {
      expect(isRoleAllowed(action, role)).toBe(expected);
    });

    it.each(Object.values(UserRole))('a cast KYB_COMPLETE is never allowed for %s', (role) => {
      expect(isRoleAllowed(A.KYB_COMPLETE as unknown as UserTransitionAction, role)).toBe(false);
    });
  });

  describe('operations, every (status, operation) pair', () => {
    const O = ApplicationOperation;
    // Every operation must be classified here, so a new enum value fails until it is.
    const EXPECTED_OPS: Record<ApplicationOperation, readonly ApplicationStatus[]> = {
      [O.UPDATE]: [S.DRAFT, S.INFO_REQUESTED],
      [O.ASSIGN]: [S.RISK_REVIEW, S.UNDER_REVIEW, S.INFO_REQUESTED],
      [O.TRANSFER_OWNER]: [S.DRAFT, S.RISK_REVIEW, S.UNDER_REVIEW, S.INFO_REQUESTED],
    };

    const PAIRS: [ApplicationStatus, ApplicationOperation][] = ALL_STATUSES.flatMap((status) =>
      Object.values(ApplicationOperation).map(
        (operation): [ApplicationStatus, ApplicationOperation] => [status, operation],
      ),
    );

    it('classifies every operation', () => {
      expect(Object.keys(EXPECTED_OPS).sort()).toEqual(Object.values(ApplicationOperation).sort());
    });

    it('covers 18 pairs', () => {
      expect(PAIRS).toHaveLength(18);
    });

    it.each(PAIRS)('%s / %s', (status, operation) => {
      expect(isOperationAllowed(operation, status)).toBe(EXPECTED_OPS[operation].includes(status));
    });

    it.each(TERMINAL_STATUSES)('TRANSFER_OWNER is not allowed in terminal %s', (status) => {
      expect(isOperationAllowed(O.TRANSFER_OWNER, status)).toBe(false);
    });

    it('TRANSFER_OWNER is allowed in every non-terminal status', () => {
      const nonTerminal = ALL_STATUSES.filter((s) => !TERMINAL_STATUSES.includes(s));
      expect([...allowedStatuses(O.TRANSFER_OWNER)].sort()).toEqual(nonTerminal.sort());
    });

    it('allowedStatuses(UPDATE) is DRAFT and INFO_REQUESTED', () => {
      expect(allowedStatuses(O.UPDATE)).toEqual([S.DRAFT, S.INFO_REQUESTED]);
    });

    it('roles and who text match the ADR', () => {
      expect(OPERATIONS[O.UPDATE].roles).toEqual([UserRole.ADMIN, UserRole.SALES]);
      expect(OPERATIONS[O.UPDATE].who).toBe('owner SALES, ADMIN');
      expect(OPERATIONS[O.ASSIGN].roles).toEqual([UserRole.ADMIN]);
      expect(OPERATIONS[O.ASSIGN].who).toBe('ADMIN (target must have role REVIEWER)');
      expect(OPERATIONS[O.TRANSFER_OWNER].roles).toEqual([UserRole.ADMIN]);
      expect(OPERATIONS[O.TRANSFER_OWNER].who).toBe('ADMIN (target must have role SALES)');
    });
  });
});
