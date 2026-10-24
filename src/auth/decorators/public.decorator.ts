import { CustomDecorator, SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth.constants';

/** Opts a route (or controller) out of the global `JwtAuthGuard`. Use only where the ADR allows. */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);
