// Swagger UI and OpenAPI document setup, shared by main.ts and the e2e tests.
import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Swagger UI is served at `/docs`. */
export const SWAGGER_PATH = 'docs';
/** OpenAPI JSON document URL (`/docs-json`). Set explicitly, not left to the library default. */
export const SWAGGER_JSON_PATH = 'docs-json';
/** OpenAPI YAML document URL (`/docs-yaml`). Set explicitly, not left to the library default. */
export const SWAGGER_YAML_PATH = 'docs-yaml';
/** Name of the bearer (JWT) security scheme. Protected controllers use `@ApiBearerAuth(SWAGGER_BEARER_AUTH_NAME)`. */
export const SWAGGER_BEARER_AUTH_NAME = 'bearer';

// Keep in step with `version` in package.json. It is not imported from there, because that would
// need `resolveJsonModule` and would change the dist/ layout.
export const API_VERSION = '0.1.0';

/**
 * Document metadata plus one HTTP bearer (JWT) scheme (docs/adrs/auth.md). Security is not applied
 * globally, because `POST /auth/login` is public; each controller opts in.
 */
export function buildSwaggerConfig(): Omit<OpenAPIObject, 'paths'> {
  return new DocumentBuilder()
    .setTitle('Merchant onboarding API')
    .setDescription(
      'Merchant onboarding and risk review API. Use POST /auth/login to get a JWT, then Authorize with it.',
    )
    .setVersion(API_VERSION)
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT access token from POST /auth/login',
      },
      SWAGGER_BEARER_AUTH_NAME,
    )
    .build();
}

/**
 * Registers the Swagger UI at `/docs`, the JSON document at `/docs-json` and the YAML document at
 * `/docs-yaml` when `enabled` is true. Returns whether it registered anything. The flag is passed
 * in, so this function never reads config itself. `persistAuthorization` stays off, so a pasted
 * JWT is not kept in the browser's localStorage.
 */
export function setupSwagger(app: INestApplication, enabled: boolean): boolean {
  if (!enabled) {
    return false;
  }
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    yamlDocumentUrl: SWAGGER_YAML_PATH,
  });
  return true;
}
