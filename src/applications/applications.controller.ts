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
import { ApplicationListResponseDto, ApplicationResponseDto } from './dto/application-response.dto';
import { CreateApplicationDto } from './dto/create-application.dto';
import { ListApplicationsQueryDto } from './dto/list-applications-query.dto';
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
  @ApiOperation({ summary: 'Get one application' })
  @ApiOkResponse({ type: ApplicationResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown id or not visible to the caller' })
  get(@Param('id') id: string, @CurrentUser() actor: AuthUser): Promise<ApplicationResponseDto> {
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
}
