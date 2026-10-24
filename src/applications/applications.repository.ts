import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, Repository, SelectQueryBuilder, WhereExpressionBuilder } from 'typeorm';
import { AuthUser } from '../auth/auth-user';
import { UserRole } from '../common/common.enums';
import { ApplicationStatus, KybStatus } from './application.enums';
import {
  allowedStatuses,
  ApplicationOperation,
  fromStatuses,
  TransitionAction,
} from './application-state-machine';
import { UpdateApplicationDto } from './dto/update-application.dto';
import { MerchantApplication } from './merchant-application.entity';

/** Every column the service sets on create. The rest use their database defaults. */
export type NewApplication = Pick<
  MerchantApplication,
  | 'createdById'
  | 'salesOwnerId'
  | 'assignedReviewerId'
  | 'businessName'
  | 'legalBusinessName'
  | 'businessType'
  | 'registrationNumber'
  | 'taxId'
  | 'ownerFullName'
  | 'ownerEmail'
  | 'ownerPhone'
  | 'ownerNationalId'
  | 'merchantCategoryCode'
  | 'websiteUrl'
  | 'expectedMonthlyVolumeMinor'
  | 'averageTicketSizeMinor'
  | 'currency'
  | 'status'
  | 'kybStatus'
  | 'kybLevel'
  | 'kybScore'
>;

/** The fields PATCH may change (the keys of `UpdateApplicationDto`), each optional. */
export type ApplicationChanges = Partial<Pick<MerchantApplication, keyof UpdateApplicationDto>>;

export interface ApplicationPageFilter {
  status?: ApplicationStatus;
  page: number;
  limit: number;
}

export interface ApplicationPage {
  items: MerchantApplication[];
  total: number;
}

/**
 * The only way to read applications for a request (docs/adrs/auth.md §Authorization). Every read
 * is built on `scopedQuery(actor)`: SALES see rows they own, REVIEWER rows assigned to them, ADMIN
 * all rows, and any other role nothing. Out of scope and unknown ids both come back as `null`, so
 * the caller answers 404 for both. There is deliberately no unscoped find-by-id.
 *
 * There are two conditional updates: `updateIfEditable` (PATCH) and `submitIfAllowed` (SUBMIT).
 * Each must only be called with an id that `findAccessible` returned in the same transaction; its
 * `version` condition then guarantees the row is still the one that passed the scope check. Both
 * bump `version`, and as defence in depth both repeat the actor's scope, built by the same
 * `applyScope` as the reads, so the read and write rules cannot drift apart.
 *
 * Every write to an ownership or assignment column (`sales_owner_id`, `assigned_reviewer_id`)
 * must bump `version`, so a concurrent update's `version` condition sees the change.
 */
@Injectable()
export class ApplicationsRepository {
  constructor(
    @InjectRepository(MerchantApplication)
    private readonly repository: Repository<MerchantApplication>,
  ) {}

  /**
   * One application the actor may see, or `null` when it is out of scope or does not exist.
   * Returns `null` without querying when `id` is not a UUID (Postgres would otherwise reject the
   * query with an error), so a malformed id gets the same 404 as an unknown one.
   */
  findAccessible(
    id: string,
    actor: AuthUser,
    manager?: EntityManager,
  ): Promise<MerchantApplication | null> {
    if (!isUUID(id)) {
      return Promise.resolve(null);
    }
    return this.scopedQuery(actor, manager).andWhere('app.id = :id', { id }).getOne();
  }

  /** One page of the applications the actor may see, newest first, and the total in scope. */
  async findAccessiblePage(
    actor: AuthUser,
    filter: ApplicationPageFilter,
  ): Promise<ApplicationPage> {
    const query = this.scopedQuery(actor);
    if (filter.status !== undefined) {
      query.andWhere('app.status = :status', { status: filter.status });
    }
    // Property paths (not column names), so TypeORM can resolve them in its skip/take subquery.
    const [items, total] = await query
      .orderBy('app.createdAt', 'DESC')
      .addOrderBy('app.id', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();
    return { items, total };
  }

  /** Inserts a new application inside the caller's transaction and returns its id. */
  async insert(values: NewApplication, manager: EntityManager): Promise<string> {
    const result = await manager.insert(MerchantApplication, values);
    const id: unknown = result.identifiers[0]?.['id'];
    if (typeof id !== 'string') {
      throw new Error('Application insert did not return an id');
    }
    return id;
  }

  /**
   * Applies `changes` only if the row still has `expectedVersion` and an editable status, and
   * bumps `version`. Returns false when no row matched (changed concurrently). `version` and
   * `updatedAt` are set explicitly, so TypeORM does not add its own clauses for them.
   * Also repeats the actor's scope (defence in depth), so a row outside it never matches.
   * Only call it with an id `findAccessible` returned in the same transaction.
   */
  async updateIfEditable(
    id: string,
    expectedVersion: number,
    changes: ApplicationChanges,
    actor: AuthUser,
    manager: EntityManager,
  ): Promise<boolean> {
    const query = manager
      .createQueryBuilder()
      .update(MerchantApplication)
      .set({ ...changes, version: () => 'version + 1', updatedAt: () => 'now()' })
      .where('id = :id', { id })
      .andWhere('version = :expectedVersion', { expectedVersion })
      .andWhere('status IN (:...editableStatuses)', {
        editableStatuses: [...allowedStatuses(ApplicationOperation.UPDATE)],
      });
    // The UPDATE has no alias, so the scope uses bare column names.
    const result = await this.applyScope(query, actor, '').execute();
    return result.affected === 1;
  }

  /**
   * The single SUBMIT write (docs/adrs/kyb-check.md): moves the row to `to`, resets the KYB result
   * (`kyb_status = PENDING`, level/score/last attempt cleared, attempts 0), increments
   * `submission_count`, stamps `submitted_at` and bumps `version`. Applies only if the row still
   * has `expectedVersion` and a status SUBMIT may start from, and repeats the actor's scope.
   * Returns false when no row matched (changed concurrently). It never touches the ownership or
   * assignment columns. Only call it with an id `findAccessible` returned in the same transaction.
   */
  async submitIfAllowed(
    id: string,
    expectedVersion: number,
    to: ApplicationStatus,
    actor: AuthUser,
    manager: EntityManager,
  ): Promise<boolean> {
    const query = manager
      .createQueryBuilder()
      .update(MerchantApplication)
      .set({
        status: to,
        kybStatus: KybStatus.PENDING,
        kybLevel: null,
        kybScore: null,
        kybAttempts: 0,
        kybLastAttemptAt: null,
        submissionCount: () => 'submission_count + 1',
        submittedAt: () => 'now()',
        version: () => 'version + 1',
        updatedAt: () => 'now()',
      })
      .where('id = :id', { id })
      .andWhere('version = :expectedVersion', { expectedVersion })
      .andWhere('status IN (:...submittableStatuses)', {
        submittableStatuses: [...fromStatuses(TransitionAction.SUBMIT)],
      });
    // The UPDATE has no alias, so the scope uses bare column names.
    const result = await this.applyScope(query, actor, '').execute();
    return result.affected === 1;
  }

  /** The actor's scope as a query on alias `app`. Uses the transaction's manager when given. */
  private scopedQuery(
    actor: AuthUser,
    manager?: EntityManager,
  ): SelectQueryBuilder<MerchantApplication> {
    const repository =
      manager === undefined ? this.repository : manager.getRepository(MerchantApplication);
    return this.applyScope(repository.createQueryBuilder('app'), actor, 'app.');
  }

  /**
   * Adds the actor's scope to `query`: the single source of the scope rules for both the reads and
   * the updates. `columnPrefix` is `'app.'` for the aliased reads and `''` for the unaliased UPDATE.
   */
  private applyScope<Q extends WhereExpressionBuilder>(
    query: Q,
    actor: AuthUser,
    columnPrefix: string,
  ): Q {
    switch (actor.role) {
      case UserRole.SALES:
        return query.andWhere(`${columnPrefix}sales_owner_id = :actorId`, { actorId: actor.id });
      case UserRole.REVIEWER:
        return query.andWhere(`${columnPrefix}assigned_reviewer_id = :actorId`, {
          actorId: actor.id,
        });
      case UserRole.ADMIN:
        return query;
      default:
        // Fail closed: a role added later sees nothing until it is given a scope here.
        return query.andWhere('1 = 0');
    }
  }
}
