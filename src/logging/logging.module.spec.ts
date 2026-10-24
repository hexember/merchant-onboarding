import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppLogger } from './app-logger.service';
import { ConsoleTransport } from './console.transport';
import { LoggingModule } from './logging.module';
import { LOG_TRANSPORTS } from './log-transport';

describe('LoggingModule', () => {
  async function compile(): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [(): Record<string, string> => ({ LOG_LEVEL: 'log', NODE_ENV: 'test' })],
        }),
        LoggingModule,
      ],
    }).compile();
  }

  it('resolves AppLogger', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(AppLogger)).toBeInstanceOf(AppLogger);
  });

  it('provides LOG_TRANSPORTS as an array with one ConsoleTransport', async () => {
    const moduleRef = await compile();

    const transports = moduleRef.get<unknown[]>(LOG_TRANSPORTS);
    expect(Array.isArray(transports)).toBe(true);
    expect(transports).toHaveLength(1);
    expect(transports[0]).toBeInstanceOf(ConsoleTransport);
  });
});
