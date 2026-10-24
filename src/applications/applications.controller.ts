import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../common/common.enums';
import { SWAGGER_BEARER_AUTH_NAME } from '../common/swagger';
import { ApplicationsService } from './applications.service';
import {
  ApplicationDetailResponseDto,
  ApplicationListResponseDto,
  ApplicationResponseDto,
} from './dto/application-response.dto';
import { AssignReviewerDto } from './dto/assign-reviewer.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
import { RecordDecisionDto } from './dto/record-decision.dto';
import { TransferOwnerDto } from './dto/transfer-owner.dto';
import { UpdateApplicationDto } from './dto/update-application.dto';

// Roles per route follow the docs/adrs/auth.md matrix. Scoping (404 for out-of-scope ids) is done
// by the service through ApplicationsRepository. `:id` has no ParseUUIDPipe on purpose: a
// malformed id must get the same 404 as any unknown id.
@ApiTags('applications')
@ApiBearerAuth(SWAGGER_BEARER_AUTH_NAME)
@ApiUnauthorizedResponse({ description: 'Missing or invalid token' })
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @Roles(UserRole.ADMIN, UserRole.SALES)
  @ApiOperation({ summary: 'Create a DRAFT application' })
  @ApiCreatedResponse({ type: ApplicationResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or ADMIN gave no valid SALES owner' })
  @ApiForbiddenResponse({ description: 'Wrong role, or SALES sent salesOwnerId' })
  create(
    @Body() dto: CreateApplicationDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    return this.applicationsService.create(dto, actor);
  }

  @Get()
  @Roles(UserRole.ADMIN, UserRole.REVIEWER, UserRole.SALES)
  @ApiOperation({ summary: 'List the applications the caller may see, newest first' })
  @ApiOkResponse({ type: ApplicationListResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid query parameters' })
  list(
    @Query() query: ListApplicationsQueryDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationListResponseDto> {
    return this.applicationsService.list(query, actor);
  }

  @Get(':id')
  @Roles(UserRole.ADMIN, UserRole.REVIEWER, UserRole.SALES)
  @ApiOperation({ summary: 'Get one application, with its KYB check status' })
  @ApiOkResponse({ type: ApplicationDetailResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown id or not visible to the caller' })
  get(
    @Param('id') id: string,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationDetailResponseDto> {
    return this.applicationsService.get(id, actor);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN, UserRole.SALES)
  @ApiOperation({ summary: 'Edit an application in DRAFT or INFO_REQUESTED' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed or no fields to update' })
  @ApiForbiddenResponse({ description: 'Wrong role' })
  @ApiNotFoundResponse({ description: 'Unknown id or not visible to the caller' })
  @ApiConflictResponse({
    description: 'Not editable in its status (INVALID_STATE_TRANSITION) or changed concurrently',
  })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    return this.applicationsService.update(id, dto, actor);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.SALES)
  @ApiOperation({ summary: 'Submit a DRAFT or INFO_REQUESTED application for the KYB check' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiForbiddenResponse({ description: 'Wrong role' })
  @ApiNotFoundResponse({ description: 'Unknown id or not visible to the caller' })
  @ApiConflictResponse({
    description:
      'Not submittable in its status (INVALID_STATE_TRANSITION) or changed concurrently (CONCURRENT_MODIFICATION)',
  })
  submit(@Param('id') id: string, @CurrentUser() actor: AuthUser): Promise<ApplicationResponseDto> {
    return this.applicationsService.submit(id, actor);
  }

  @Post(':id/assign')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Assign or reassign the reviewer (ADMIN)' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or reviewerId is not a REVIEWER user' })
  @ApiForbiddenResponse({ description: 'Wrong role' })
  @ApiNotFoundResponse({ description: 'Unknown id' })
  @ApiConflictResponse({
    description:
      'Not assignable in its status (INVALID_STATE_TRANSITION) or changed concurrently (CONCURRENT_MODIFICATION)',
  })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignReviewerDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    return this.applicationsService.assignReviewer(id, dto, actor);
  }

  @Post(':id/transfer-owner')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Transfer the application to another SALES owner (ADMIN)' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation failed, or salesOwnerId is not a SALES user',
  })
  @ApiForbiddenResponse({ description: 'Wrong role' })
  @ApiNotFoundResponse({ description: 'Unknown id' })
  @ApiConflictResponse({
    description:
      'Not transferable in its status (INVALID_STATE_TRANSITION) or changed concurrently (CONCURRENT_MODIFICATION)',
  })
  transferOwner(
    @Param('id') id: string,
    @Body() dto: TransferOwnerDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    return this.applicationsService.transferOwner(id, dto, actor);
  }

  @Post(':id/decision')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.REVIEWER)
  @ApiOperation({ summary: 'Record a decision (assigned REVIEWER)' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiForbiddenResponse({ description: 'Wrong role' })
  @ApiNotFoundResponse({ description: 'Unknown id or not assigned to the caller' })
  @ApiConflictResponse({
    description:
      'Not decidable in its status (INVALID_STATE_TRANSITION), APPROVE before the KYB check completed (KYB_NOT_COMPLETED) or changed concurrently (CONCURRENT_MODIFICATION)',
  })
  decide(
    @Param('id') id: string,
    @Body() dto: RecordDecisionDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<ApplicationResponseDto> {
    return this.applicationsService.decide(id, dto, actor);
  }
}
