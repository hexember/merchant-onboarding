import { Global, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppLogger } from './app-logger.service';
import { ConsoleTransport } from './console.transport';
import { LOG_TRANSPORTS, LogTransport } from './log-transport';

// Global, so `AppLogger` is available everywhere. `ConfigService` comes from the global
// `ConfigModule` that each root module registers.
@Global()
@Module({
  providers: [
    AppLogger,
    ConsoleTransport,
    {
      provide: LOG_TRANSPORTS,
      // Plug-in point: to add an output, provide its LogTransport class above, inject it here
      // and add it to this list.
      useFactory: (console: ConsoleTransport): LogTransport[] => [console],
      inject: [ConsoleTransport],
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
  exports: [AppLogger],
})
export class LoggingModule {}
