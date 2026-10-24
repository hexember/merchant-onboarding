import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditAction, AuditActorType } from '../audit/audit.enums';
import { AuditLogService } from '../audit/audit-log.service';
import { AuthUser } from '../auth/auth-user';
import { UserRole } from '../common/common.enums';
import { KybCheckQueue } from '../kyb/kyb-check.queue';
import { UsersRepository } from '../users/users.repository';
import { ApplicationStatus, KybStatus } from './application.enums';
import {
  ApplicationOperation,
  isOperationAllowed,
  isRoleAllowed,
  nextStatus,
  OPERATIONS,
  TransitionAction,
} from './application-state-machine';
import {
  ApplicationChanges,
  ApplicationsRepository,
  NewApplication,
} from './applications.repository';
import {
  ApplicationDetailResponseDto,
  ApplicationListResponseDto,
  ApplicationResponseDto,
  toApplicationDetailResponse,
  toApplicationResponse,
} from './dto/application-response.dto';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { TransferOwnerDto } from './dto/transfer-owner.dto';
import { UPDATABLE_FIELDS, UpdateApplicationDto } from './dto/update-application.dto';
import { MerchantApplication } from './merchant-application.entity';

export const AUDIT_ENTITY_TYPE = 'merchant_application';
export const DEFAULT_CURRENCY = 'NPR';

export const APPLICATION_NOT_FOUND_MESSAGE = 'Application not found';
export const SALES_OWNER_REQUIRED_MESSAGE = 'salesOwnerId is required';
export const SALES_OWNER_NOT_SALES_MESSAGE = 'salesOwnerId must be a SALES user';
export const NO_FIELDS_TO_UPDATE_MESSAGE = 'No fields to update';
export const NOT_EDITABLE_MESSAGE = 'Application can only be edited in DRAFT or INFO_REQUESTED';
export const CONCURRENT_MODIFICATION_MESSAGE = 'Application was changed by another request';
export const NOT_SUBMITTABLE_MESSAGE =
  'Application can only be submitted from DRAFT or INFO_REQUESTED';
export const REVIEWER_NOT_REVIEWER_MESSAGE = 'reviewerId must be a REVIEWER user';
export const NOT_ASSIGNABLE_MESSAGE =
  'A reviewer can only be assigned in RISK_REVIEW, UNDER_REVIEW or INFO_REQUESTED';
export const NOT_TRANSFERABLE_MESSAGE =
  'Ownership can only be transferred while the application is not APPROVED or REJECTED';

export const INVALID_STATE_TRANSITION_CODE = 'INVALID_STATE_TRANSITION';
export const CONCURRENT_MODIFICATION_CODE = 'CONCURRENT_MODIFICATION';

// Copies one present field. Generic over the key, so the value keeps that field's type.
function copyField<K extends keyof UpdateApplicationDto>(
  target: Partial<UpdateApplicationDto>,
  source: UpdateApplicationDto,
  key: K,
): void {
  target[key] = source[key];
}

/** What the submit transaction hands back: the response, plus the inputs of the KYB enqueue. */
interface SubmitResult {
  response: ApplicationResponseDto;
  applicationId: string;
  submissionNo: number;
}

/**
 * Create, list, read, edit and submit applications, plus the ADMIN-only `assignReviewer` and
 * `transferOwner` (docs/adrs/auth.md matrix, docs/adrs/workflow.md §1.2). Which statuses allow an
 * edit, an assign or a transfer, and which transitions exist, come from the state machine module
 * (`application-state-machine.ts`). Every read goes through the scoped
 * `ApplicationsRepository`; each write and its audit row share one transaction. Responses are
 * masked by `toApplicationResponse` (`toApplicationDetailResponse` for `get`). After a submit
 * commits, the KYB check job is enqueued through `KybCheckQueue` (docs/adrs/kyb-check.md).
 * Nothing here logs the payload.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly auditLogService: AuditLogService,
    private readonly kybCheckQueue: KybCheckQueue,
  ) {}

  async create(dto: CreateApplicationDto, actor: AuthUser): Promise<ApplicationResponseDto> {
    const salesOwnerId = await this.resolveSalesOwner(dto.salesOwnerId, actor);
    // Field by field: `dto.salesOwnerId` is never copied as-is.
    const values: NewApplication = {
      createdById: actor.id,
      salesOwnerId,
      assignedReviewerId: null,
      businessName: dto.businessName,
      legalBusinessName: dto.legalBusinessName,
      businessType: dto.businessType,
      registrationNumber: dto.registrationNumber,
      taxId: dto.taxId,
      ownerFullName: dto.ownerFullName,
      ownerEmail: dto.ownerEmail,
      ownerPhone: dto.ownerPhone,
      ownerNationalId: dto.ownerNationalId,
      merchantCategoryCode: dto.merchantCategoryCode,
      websiteUrl: dto.websiteUrl ?? null,
      expectedMonthlyVolumeMinor: dto.expectedMonthlyVolumeMinor,
      averageTicketSizeMinor: dto.averageTicketSizeMinor,
      currency: dto.currency ?? DEFAULT_CURRENCY,
      status: ApplicationStatus.DRAFT,
      kybStatus: KybStatus.NOT_STARTED,
      kybLevel: null,
      kybScore: null,
    };

    return this.dataSource.transaction(async (manager) => {
      const id = await this.applicationsRepository.insert(values, manager);
      await this.auditLogService.record(
        {
          actorType: AuditActorType.USER,
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.APPLICATION_CREATED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: id,
          meta: { status: ApplicationStatus.DRAFT, salesOwnerId },
        },
        manager,
      );
      return toApplicationResponse(await this.reReadInTransaction(id, actor, manager));
    });
  }

  async list(
    query: ListApplicationsQueryDto,
    actor: AuthUser,
  ): Promise<ApplicationListResponseDto> {
    const { items, total } = await this.applicationsRepository.findAccessiblePage(actor, {
      status: query.status,
      page: query.page,
      limit: query.limit,
    });
    return {
      items: items.map(toApplicationResponse),
      page: query.page,
      limit: query.limit,
      total,
    };
  }

  async get(id: string, actor: AuthUser): Promise<ApplicationDetailResponseDto> {
    const app = await this.applicationsRepository.findAccessible(id, actor);
    if (app === null) {
      throw new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE);
    }
    return toApplicationDetailResponse(app);
  }

  async update(
    id: string,
    dto: UpdateApplicationDto,
    actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    const changes: ApplicationChanges = this.presentChanges(dto);
    const changedFields = Object.keys(changes).sort();
    if (changedFields.length === 0) {
      throw new BadRequestException(NO_FIELDS_TO_UPDATE_MESSAGE);
    }

    return this.dataSource.transaction(async (manager) => {
      const app = await this.applicationsRepository.findAccessible(id, actor, manager);
      if (app === null) {
        throw new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE);
      }
      if (!isOperationAllowed(ApplicationOperation.UPDATE, app.status)) {
        throw this.conflict(NOT_EDITABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE);
      }
      const updated = await this.applicationsRepository.updateIfEditable(
        app.id,
        app.version,
        changes,
        actor,
        manager,
      );
      if (!updated) {
        throw this.conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE);
      }
      // Field names only, never their values.
      await this.auditLogService.record(
        {
          actorType: AuditActorType.USER,
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.APPLICATION_UPDATED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: app.id,
          meta: { changedFields, status: app.status },
        },
        manager,
      );
      return toApplicationResponse(await this.reReadInTransaction(app.id, actor, manager));
    });
  }

  /**
   * SUBMIT (docs/adrs/workflow.md §1.2-§1.3): DRAFT or INFO_REQUESTED → RISK_REVIEW. One
   * transaction does the scoped read, the single conditional write (which also resets the KYB
   * result) and the APPLICATION_SUBMITTED audit row. Only after it commits is the KYB check job
   * enqueued.
   */
  async submit(id: string, actor: AuthUser): Promise<ApplicationResponseDto> {
    // Defence in depth behind @Roles: REVIEWER (or any other role) → 403 before any DB work.
    if (!isRoleAllowed(TransitionAction.SUBMIT, actor.role)) {
      throw new ForbiddenException();
    }

    const result = await this.dataSource.transaction(async (manager): Promise<SubmitResult> => {
      const app = await this.applicationsRepository.findAccessible(id, actor, manager);
      if (app === null) {
        throw new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE);
      }
      const to = nextStatus(app.status, TransitionAction.SUBMIT);
      if (to === null) {
        throw this.conflict(NOT_SUBMITTABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE);
      }
      const submittedOk = await this.applicationsRepository.submitIfAllowed(
        app.id,
        app.version,
        to,
        actor,
        manager,
      );
      if (!submittedOk) {
        throw this.conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE);
      }
      const submitted = await this.reReadInTransaction(app.id, actor, manager);
      // Statuses and the counter only; `submissionNo` is read back from the row.
      await this.auditLogService.record(
        {
          actorType: AuditActorType.USER,
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.APPLICATION_SUBMITTED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: app.id,
          meta: { from: app.status, to, submissionNo: submitted.submissionCount },
        },
        manager,
      );
      return {
        response: toApplicationResponse(submitted),
        applicationId: app.id,
        submissionNo: submitted.submissionCount,
      };
    });

    // After the commit, never inside the transaction: the worker must see the committed row. The
    // result is ignored on purpose: `enqueue` never rejects, and the request succeeds even if Redis
    // is down (the application then stays in RISK_REVIEW; docs/adrs/kyb-check.md trade-off).
    await this.kybCheckQueue.enqueue(result.applicationId, result.submissionNo);
    return result.response;
  }

  /**
   * ASSIGN (docs/adrs/workflow.md §1.2): ADMIN assigns or reassigns the reviewer in RISK_REVIEW,
   * UNDER_REVIEW or INFO_REQUESTED. Order: role (403) → target is a REVIEWER (400, before the
   * transaction) → scoped read (404) → status (409 INVALID_STATE_TRANSITION) → guarded write (409
   * CONCURRENT_MODIFICATION). The REVIEWER_ASSIGNED audit row (ids only) shares the transaction.
   * Assigning the current reviewer again takes the same path (write, version bump, audit row).
   */
  async assignReviewer(
    id: string,
    dto: AssignReviewerDto,
    actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    // Defence in depth behind @Roles: SALES and REVIEWER → 403 before any DB work.
    if (!OPERATIONS[ApplicationOperation.ASSIGN].roles.includes(actor.role)) {
      throw new ForbiddenException();
    }
    // A malformed id, an unknown id and a non-REVIEWER user all get the same message.
    if (!(await this.usersRepository.existsWithRole(dto.reviewerId, UserRole.REVIEWER))) {
      throw new BadRequestException(REVIEWER_NOT_REVIEWER_MESSAGE);
    }

    return this.dataSource.transaction(async (manager) => {
      const app = await this.applicationsRepository.findAccessible(id, actor, manager);
      if (app === null) {
        throw new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE);
      }
      if (!isOperationAllowed(ApplicationOperation.ASSIGN, app.status)) {
        throw this.conflict(NOT_ASSIGNABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE);
      }
      const assigned = await this.applicationsRepository.assignReviewerIfAllowed(
        app.id,
        app.version,
        dto.reviewerId,
        actor,
        manager,
      );
      if (!assigned) {
        throw this.conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE);
      }
      // User ids only; `from` is null when no reviewer was assigned.
      await this.auditLogService.record(
        {
          actorType: AuditActorType.USER,
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.REVIEWER_ASSIGNED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: app.id,
          meta: { from: app.assignedReviewerId, to: dto.reviewerId },
        },
        manager,
      );
      return toApplicationResponse(await this.reReadInTransaction(app.id, actor, manager));
    });
  }

  /**
   * TRANSFER_OWNER (docs/adrs/workflow.md §1.2): ADMIN moves `salesOwnerId` to another SALES user
   * in any non-terminal status. The same order and transaction as `assignReviewer`, with an
   * OWNERSHIP_TRANSFERRED audit row (ids only). `createdById` never changes. Transferring to the
   * current owner takes the same path (write, version bump, audit row).
   */
  async transferOwner(
    id: string,
    dto: TransferOwnerDto,
    actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    // Defence in depth behind @Roles: SALES and REVIEWER → 403 before any DB work.
    if (!OPERATIONS[ApplicationOperation.TRANSFER_OWNER].roles.includes(actor.role)) {
      throw new ForbiddenException();
    }
    // A malformed id, an unknown id and a non-SALES user all get the same message.
    if (!(await this.usersRepository.existsWithRole(dto.salesOwnerId, UserRole.SALES))) {
      throw new BadRequestException(SALES_OWNER_NOT_SALES_MESSAGE);
    }

    return this.dataSource.transaction(async (manager) => {
      const app = await this.applicationsRepository.findAccessible(id, actor, manager);
      if (app === null) {
        throw new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE);
      }
      if (!isOperationAllowed(ApplicationOperation.TRANSFER_OWNER, app.status)) {
        throw this.conflict(NOT_TRANSFERABLE_MESSAGE, INVALID_STATE_TRANSITION_CODE);
      }
      const transferred = await this.applicationsRepository.transferOwnerIfAllowed(
        app.id,
        app.version,
        dto.salesOwnerId,
        actor,
        manager,
      );
      if (!transferred) {
        throw this.conflict(CONCURRENT_MODIFICATION_MESSAGE, CONCURRENT_MODIFICATION_CODE);
      }
      // User ids only.
      await this.auditLogService.record(
        {
          actorType: AuditActorType.USER,
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.OWNERSHIP_TRANSFERRED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: app.id,
          meta: { from: app.salesOwnerId, to: dto.salesOwnerId },
        },
        manager,
      );
      return toApplicationResponse(await this.reReadInTransaction(app.id, actor, manager));
    });
  }

  /**
   * Decides the owner of a new application (docs/adrs/database.md §`merchant_applications`).
   * SALES: always themselves; sending `salesOwnerId` at all (any value) → 403. ADMIN: must name a
   * SALES user → otherwise 400. Any other role → 403 (the route guard already blocks REVIEWER).
   */
  private async resolveSalesOwner(requested: unknown, actor: AuthUser): Promise<string> {
    switch (actor.role) {
      case UserRole.SALES:
        if (requested !== undefined) {
          throw new ForbiddenException();
        }
        return actor.id;
      case UserRole.ADMIN:
        if (requested === undefined || requested === null) {
          throw new BadRequestException(SALES_OWNER_REQUIRED_MESSAGE);
        }
        // A malformed id, an unknown id and a non-SALES user all get the same message.
        if (
          typeof requested !== 'string' ||
          !(await this.usersRepository.existsWithRole(requested, UserRole.SALES))
        ) {
          throw new BadRequestException(SALES_OWNER_NOT_SALES_MESSAGE);
        }
        return requested;
      default:
        throw new ForbiddenException();
    }
  }

  /** The PATCH change set: only the updatable fields whose key is present (not `undefined`). */
  private presentChanges(dto: UpdateApplicationDto): ApplicationChanges {
    const changes: Partial<UpdateApplicationDto> = {};
    for (const field of UPDATABLE_FIELDS) {
      if (dto[field] !== undefined) {
        copyField(changes, dto, field);
      }
    }
    return changes;
  }

  /** A 409 with the hand-built body the API uses (there is no global exception filter). */
  private conflict(message: string, code: string): ConflictException {
    return new ConflictException({ statusCode: 409, error: 'Conflict', message, code });
  }

  /**
   * Re-reads the row just written, through the same scope and transaction. A miss would mean the
   * write is not visible to its own author, so it throws inside the transaction: the change and
   * its audit row roll back and the client gets a 500.
   */
  private async reReadInTransaction(
    id: string,
    actor: AuthUser,
    manager: EntityManager,
  ): Promise<MerchantApplication> {
    const app = await this.applicationsRepository.findAccessible(id, actor, manager);
    if (app === null) {
      throw new Error('Application written in this transaction could not be re-read');
    }
    return app;
  }
}
