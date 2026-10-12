// scripts/backfill-tracking-codes.ts
// Gives every report created before this feature a tracking code (and a first status event).
//   npx tsx scripts/backfill-tracking-codes.ts
// After it finishes you can change `trackingCode String?` to `String` in schema.prisma and migrate.
import "dotenv/config";
import { prisma } from "../src/db";
import { generateTrackingCode } from "../src/utils/trackingCode";

const BATCH = 500;

async function main() {
  let total = 0;
  for (;;) {
    const rows = await prisma.report.findMany({
      where: { trackingCode: null },
      select: { id: true, createdAt: true },
      take: BATCH,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await prisma.report.update({
            where: { id: row.id },
            data: {
              trackingCode: generateTrackingCode(),
              statusUpdatedAt: row.createdAt,
              events: {
                create: { toStatus: "RECEIVED", createdAt: row.createdAt },
              },
            },
          });
          total++;
          break;
        } catch (err: any) {
          const collision =
            err?.code === "P2002" &&
            String(err?.meta?.target).includes("trackingCode");
          if (!collision) throw err;
        }
      }
    }
    console.log(`Backfilled ${total} reports so far…`);
  }
  console.log(`Done. ${total} reports now have tracking codes.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
