import { isEditable } from './application-status';
import { ApplicationStatus } from './application.enums';

// Every status must be classified here, so a new enum value fails this test until it is.
const EXPECTED: Record<ApplicationStatus, boolean> = {
  [ApplicationStatus.DRAFT]: true,
  [ApplicationStatus.INFO_REQUESTED]: true,
  [ApplicationStatus.RISK_REVIEW]: false,
  [ApplicationStatus.UNDER_REVIEW]: false,
  [ApplicationStatus.APPROVED]: false,
  [ApplicationStatus.REJECTED]: false,
};

describe('isEditable', () => {
  it('classifies every status', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(Object.values(ApplicationStatus).sort());
  });

  it.each(Object.values(ApplicationStatus))('%s', (status) => {
    expect(isEditable(status)).toBe(EXPECTED[status]);
  });
});
