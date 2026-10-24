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
import { UsersRepository } from '../users/users.repository';
import { ApplicationStatus, KybStatus } from './application.enums';
import { isEditable } from './application-status';
import {
  ApplicationChanges,
  ApplicationsRepository,
  NewApplication,
} from './applications.repository';
import {
  ApplicationListResponseDto,
  ApplicationResponseDto,
  toApplicationResponse,
} from './dto/application-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
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

/**
 * Create, list, read and edit applications (docs/adrs/auth.md matrix, docs/adrs/workflow.md §1.2
 * "Operations that do not change status"). Every read goes through the scoped
 * `ApplicationsRepository`; each write and its audit row share one transaction. Responses are
 * masked by `toApplicationResponse`. Nothing here logs the payload.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly auditLogService: AuditLogService,
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

  async get(id: string, actor: AuthUser): Promise<ApplicationResponseDto> {
    const app = await this.applicationsRepository.findAccessible(id, actor);
    if (app === null) {
      throw new NotFoundException(APPLICATION_NOT_FOUND_MESSAGE);
    }
    return toApplicationResponse(app);
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
      if (!isEditable(app.status)) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: NOT_EDITABLE_MESSAGE,
          code: INVALID_STATE_TRANSITION_CODE,
        });
      }
      const updated = await this.applicationsRepository.updateIfEditable(
        app.id,
        app.version,
        changes,
        actor,
        manager,
      );
      if (!updated) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: CONCURRENT_MODIFICATION_MESSAGE,
          code: CONCURRENT_MODIFICATION_CODE,
        });
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
