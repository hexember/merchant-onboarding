import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { DecisionAction, TransitionAction } from '../application-state-machine';

/** The decisions a reviewer may send. String values equal the action names. */
export enum DecisionType {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
  REQUEST_INFO = 'REQUEST_INFO',
}

/** Explicit map to the state-machine action. Typed so it cannot hold SUBMIT or KYB_COMPLETE. */
export const DECISION_TO_ACTION: Readonly<Record<DecisionType, DecisionAction>> = {
  [DecisionType.APPROVE]: TransitionAction.APPROVE,
  [DecisionType.REJECT]: TransitionAction.REJECT,
  [DecisionType.REQUEST_INFO]: TransitionAction.REQUEST_INFO,
};

export const DECISION_NOTE_MAX_LENGTH = 2000;
export const NOTE_NUL_MESSAGE = 'note must not contain NUL characters';

// Postgres text cannot store U+0000; without this check such a note would fail at the DB (500).
// Matching the NUL control character is the point of this regex.
// eslint-disable-next-line no-control-regex
const NO_NUL = /^[^\u0000]*$/;

// Trims a string note and turns an empty-after-trim note into `undefined` ("no note").
// Any other value (null, a number, ...) is left as is so the validators reject it.
const trimNote = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

// Skips validation only when the key is absent. Unlike `@IsOptional()`, `null` is still validated
// (and rejected by `@IsString`).
const whenPresent = (_object: unknown, value: unknown): boolean => value !== undefined;

/**
 * `POST /applications/:id/decision` body (assigned REVIEWER only). The global ValidationPipe
 * (`forbidNonWhitelisted`) rejects any other key. The note is free text: it is stored and
 * returned, but never written to audit meta or logs.
 */
export class RecordDecisionDto {
  @ApiProperty({ enum: DecisionType, example: DecisionType.APPROVE })
  @IsEnum(DecisionType)
  decision!: DecisionType;

  @ApiPropertyOptional({ maxLength: DECISION_NOTE_MAX_LENGTH, example: 'Fake note for testing' })
  @Transform(trimNote)
  @ValidateIf(whenPresent)
  @IsString()
  @MaxLength(DECISION_NOTE_MAX_LENGTH)
  @Matches(NO_NUL, { message: NOTE_NUL_MESSAGE })
  note?: string;
}
