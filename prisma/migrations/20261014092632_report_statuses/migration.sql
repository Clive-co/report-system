-- New statuses: RECEIVED, UNDER_REVIEW, INVESTIGATING, IN_COURT, REFILED, CLOSED
--
-- How to apply:
--   1. npx prisma migrate dev --create-only --name report_statuses
--   2. Open prisma/migrations/<timestamp>_report_statuses/migration.sql and REPLACE its whole
--      contents with this file (Prisma's generated version would fail on existing rows).
--   3. npx prisma migrate dev          (on Railway / production: npx prisma migrate deploy)
--
-- Existing data is converted, not lost:
--   RESOLVED  -> CLOSED   (renamed)
--   DISMISSED -> CLOSED   (the status is removed; reports and history entries that used it become Closed)
-- Postgres can't drop a value from an enum, so the enum is recreated and the columns are switched over.

BEGIN;

CREATE TYPE "ReportStatus_new" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'INVESTIGATING', 'IN_COURT', 'REFILED', 'CLOSED');

ALTER TABLE "Report" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "Report" ALTER COLUMN "status" TYPE "ReportStatus_new"
  USING (CASE "status"::text WHEN 'RESOLVED' THEN 'CLOSED' WHEN 'DISMISSED' THEN 'CLOSED' ELSE "status"::text END)::"ReportStatus_new";

ALTER TABLE "StatusEvent" ALTER COLUMN "fromStatus" TYPE "ReportStatus_new"
  USING (CASE "fromStatus"::text WHEN 'RESOLVED' THEN 'CLOSED' WHEN 'DISMISSED' THEN 'CLOSED' ELSE "fromStatus"::text END)::"ReportStatus_new";

ALTER TABLE "StatusEvent" ALTER COLUMN "toStatus" TYPE "ReportStatus_new"
  USING (CASE "toStatus"::text WHEN 'RESOLVED' THEN 'CLOSED' WHEN 'DISMISSED' THEN 'CLOSED' ELSE "toStatus"::text END)::"ReportStatus_new";

ALTER TABLE "Report" ALTER COLUMN "status" SET DEFAULT 'RECEIVED';

ALTER TYPE "ReportStatus" RENAME TO "ReportStatus_old";
ALTER TYPE "ReportStatus_new" RENAME TO "ReportStatus";
DROP TYPE "ReportStatus_old";

COMMIT;