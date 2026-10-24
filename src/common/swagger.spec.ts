import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { API_VERSION, buildSwaggerConfig, SWAGGER_BEARER_AUTH_NAME, setupSwagger } from './swagger';

describe('buildSwaggerConfig', () => {
  it('sets the title and version', () => {
    const config = buildSwaggerConfig();

    expect(config.info.title).toBe('Merchant onboarding API');
    expect(config.info.version).toBe(API_VERSION);
  });

  it('declares one HTTP bearer (JWT) security scheme', () => {
    const scheme = buildSwaggerConfig().components?.securitySchemes?.[SWAGGER_BEARER_AUTH_NAME];

    if (scheme === undefined) {
      throw new Error('bearer security scheme is missing');
    }
    expect(scheme).toMatchObject({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  });

  it('applies no global security requirement, so login stays public', () => {
    expect(buildSwaggerConfig().security).toBeUndefined();
  });
});

describe('API_VERSION', () => {
  it('matches the version in package.json', () => {
    const raw: unknown = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));

    expect(raw).toMatchObject({ version: API_VERSION });
  });
});

describe('setupSwagger', () => {
  let setupSpy: jest.SpyInstance;

  beforeEach(() => {
    setupSpy = jest.spyOn(SwaggerModule, 'setup');
  });

  afterEach(() => {
    setupSpy.mockRestore();
  });

  it('registers nothing and returns false when disabled', () => {
    const fakeApp = {} as unknown as INestApplication;

    expect(setupSwagger(fakeApp, false)).toBe(false);
    expect(setupSpy).not.toHaveBeenCalled();
  });
});
