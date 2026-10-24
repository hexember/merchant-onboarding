import { MigrationInterface, QueryRunner } from 'typeorm';

// docs/adrs/database.md §`kyb_checks`. DDL in the TypeORM-generated style of the KybCheck entity.
// No CREATE TYPE: `kyb_level` is owned by CreateMerchantApplications1792800000002, so `down` does
// not drop it either. The FK points at `merchant_applications`.
export class CreateKybChecks1792800000003 implements MigrationInterface {
  name = 'CreateKybChecks1792800000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "kyb_checks" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "application_id" uuid NOT NULL, "submission_no" integer NOT NULL, "provider_reference" character varying(100) NOT NULL, "score" smallint NOT NULL, "level" "public"."kyb_level" NOT NULL, "reasons" jsonb NOT NULL DEFAULT '[]', "meta" jsonb NOT NULL DEFAULT '{}', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_kyb_checks_application_submission" UNIQUE ("application_id", "submission_no"), CONSTRAINT "CHK_kyb_checks_score_range" CHECK ("score" >= 0 AND "score" <= 100), CONSTRAINT "PK_kyb_checks" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "kyb_checks" ADD CONSTRAINT "FK_kyb_checks_application" FOREIGN KEY ("application_id") REFERENCES "merchant_applications"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "kyb_checks" DROP CONSTRAINT "FK_kyb_checks_application"`);
    await queryRunner.query(`DROP TABLE "kyb_checks"`);
  }
}
