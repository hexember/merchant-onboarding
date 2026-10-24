import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupSwagger } from '../src/common/swagger';

// Builds the full app (real Postgres test DB) and registers Swagger with the given flag,
// the same way main.ts does.
async function createApp(swaggerEnabled: boolean): Promise<INestApplication<App>> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = module.createNestApplication<INestApplication<App>>();
  setupSwagger(app, swaggerEnabled);
  await app.init();
  return app;
}

describe('Swagger (e2e)', () => {
  let app: INestApplication<App> | undefined;

  // The HTTP server of the app built in beforeEach.
  function server(): App {
    if (!app) {
      throw new Error('app was not created');
    }
    return app.getHttpServer();
  }

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  describe('when enabled', () => {
    beforeEach(async () => {
      app = await createApp(true);
    });

    it('serves the OpenAPI JSON document with the bearer scheme', async () => {
      const res = await request(server()).get('/docs-json').expect(200);

      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('openapi', expect.stringMatching(/^3\./));
      expect(res.body).toMatchObject({
        info: { title: 'Merchant onboarding API' },
        components: {
          securitySchemes: {
            bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
      });
    });

    it('serves the Swagger UI at /docs', async () => {
      let res = await request(server()).get('/docs');
      // Some library versions redirect /docs to /docs/; follow it instead of hard-coding a status.
      if (res.status >= 300 && res.status < 400) {
        res = await request(server()).get('/docs/');
      }

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/html/);
    });
  });

  describe('when disabled (denied)', () => {
    beforeEach(async () => {
      app = await createApp(false);
    });

    it.each(['/docs', '/docs-json', '/docs-yaml'])('returns 404 for %s', async (path) => {
      await request(server()).get(path).expect(404);
    });
  });
});
