import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { UserRole } from '../../common/common.enums';
import { ROLES_KEY } from '../auth.constants';

/** Limits a route (or controller) to the given roles. Checked by the global `RolesGuard`. */
export const Roles = (...roles: UserRole[]): CustomDecorator => SetMetadata(ROLES_KEY, roles);
