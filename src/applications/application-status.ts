import { ApplicationStatus } from './application.enums';

// Statuses in which the application's fields may be edited (docs/adrs/workflow.md §1.2,
// "Operations that do not change status": UPDATE only in DRAFT and INFO_REQUESTED).
// This is a small stand-in: the full transition table arrives with the submit-lifecycle item,
// and that table must absorb this check rather than keep a second source of truth.
export const EDITABLE_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.DRAFT,
  ApplicationStatus.INFO_REQUESTED,
];

/** True when an application in `status` may be edited (PATCH). */
export function isEditable(status: ApplicationStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}
