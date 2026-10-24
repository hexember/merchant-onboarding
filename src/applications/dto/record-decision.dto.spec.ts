import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { TransitionAction } from '../application-state-machine';
import {
  DECISION_NOTE_MAX_LENGTH,
  DECISION_TO_ACTION,
  DecisionType,
  NOTE_NUL_MESSAGE,
  RecordDecisionDto,
} from './record-decision.dto';

// Obviously fake value; only its shape matters to the validator.
const FAKE_UUID = '00000000-0000-4000-8000-000000000001';

function toDto(body: Record<string, unknown>): RecordDecisionDto {
  return plainToInstance(RecordDecisionDto, body);
}

function check(body: Record<string, unknown>): Promise<ValidationError[]> {
  return validate(toDto(body), { whitelist: true, forbidNonWhitelisted: true });
}

function failedProperties(errors: ValidationError[]): string[] {
  return errors.map((error) => error.property);
}

describe('RecordDecisionDto', () => {
  it.each(Object.values(DecisionType))('accepts %s without a note', async (decision) => {
    await expect(check({ decision })).resolves.toEqual([]);
  });

  it.each(Object.values(DecisionType))('accepts %s with a note', async (decision) => {
    await expect(check({ decision, note: 'Fake reviewer note' })).resolves.toEqual([]);
  });

  it('trims the note', () => {
    expect(toDto({ decision: DecisionType.REQUEST_INFO, note: '  more docs  ' }).note).toBe(
      'more docs',
    );
  });

  it('turns a whitespace-only note into undefined (valid)', async () => {
    const body = { decision: DecisionType.REJECT, note: '   \n\t ' };

    expect(toDto(body).note).toBeUndefined();
    await expect(check(body)).resolves.toEqual([]);
  });

  it('accepts a note of exactly the max length', async () => {
    const note = 'x'.repeat(DECISION_NOTE_MAX_LENGTH);

    await expect(check({ decision: DecisionType.APPROVE, note })).resolves.toEqual([]);
  });

  it('checks the max length after the trim', async () => {
    const note = `  ${'x'.repeat(DECISION_NOTE_MAX_LENGTH)}  `;

    await expect(check({ decision: DecisionType.APPROVE, note })).resolves.toEqual([]);
  });

  it('denied: decision missing', async () => {
    expect(failedProperties(await check({}))).toEqual(['decision']);
  });

  it.each([
    ['KYB_COMPLETE', 'KYB_COMPLETE'],
    ['SUBMIT', 'SUBMIT'],
    ['lowercase approve', 'approve'],
    ['a number', 1],
    ['null', null],
  ])('denied: decision is %s', async (_label, value) => {
    expect(failedProperties(await check({ decision: value }))).toEqual(['decision']);
  });

  it('denied: a note longer than the max length after the trim', async () => {
    const note = ` ${'x'.repeat(DECISION_NOTE_MAX_LENGTH + 1)} `;
    const errors = await check({ decision: DecisionType.REJECT, note });

    expect(failedProperties(errors)).toEqual(['note']);
    expect(errors[0]?.constraints).toHaveProperty('maxLength');
  });

  it.each([
    ['a number', 42],
    ['an object', { text: 'fake' }],
    ['an array', ['fake']],
    ['null', null],
  ])('denied: note is %s', async (_label, value) => {
    const errors = await check({ decision: DecisionType.REQUEST_INFO, note: value });

    expect(failedProperties(errors)).toEqual(['note']);
    expect(errors[0]?.constraints).toHaveProperty('isString');
  });

  it('denied: a note containing a NUL character', async () => {
    const errors = await check({ decision: DecisionType.REJECT, note: 'fake\u0000note' });

    expect(failedProperties(errors)).toEqual(['note']);
    expect(errors[0]?.constraints).toEqual({ matches: NOTE_NUL_MESSAGE });
  });

  it.each([
    ['status', 'APPROVED'],
    ['kybStatus', 'COMPLETED'],
    ['assignedReviewerId', FAKE_UUID],
    ['decidedAt', '2026-01-01T00:00:00.000Z'],
  ])('denied: extra field %s', async (field, value) => {
    const errors = await check({ decision: DecisionType.APPROVE, [field]: value });

    expect(failedProperties(errors)).toEqual([field]);
    expect(errors[0]?.constraints).toHaveProperty('whitelistValidation');
  });

  it('DECISION_TO_ACTION maps each decision to the same-named action', () => {
    expect(DECISION_TO_ACTION).toEqual({
      [DecisionType.APPROVE]: TransitionAction.APPROVE,
      [DecisionType.REJECT]: TransitionAction.REJECT,
      [DecisionType.REQUEST_INFO]: TransitionAction.REQUEST_INFO,
    });
    for (const decision of Object.values(DecisionType)) {
      expect(DECISION_TO_ACTION[decision]).toBe(decision);
    }
  });
});
