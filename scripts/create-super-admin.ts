// scripts/create-super-admin.ts
// Run once to bootstrap the first super admin (there is deliberately no public signup):
//   npx tsx scripts/create-super-admin.ts you@icpc.gov.ng "Your Name"
// Against production, run it with the production DATABASE_URL, e.g. `railway run npx tsx ...`
import "dotenv/config";
import { prisma } from "../src/db";
import { generateTempPassword, hashPassword } from "../src/utils/password";

async function main() {
  const [emailArg, nameArg] = process.argv.slice(2);
  if (!emailArg || !emailArg.includes("@")) {
    console.error(
      "Usage: npx tsx scripts/create-super-admin.ts <email> [name]",
    );
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    console.error(`An admin with ${email} already exists.`);
    process.exit(1);
  }

  const tempPassword = generateTempPassword();
  await prisma.admin.create({
    data: {
      email,
      name: nameArg?.trim() || "Super Admin",
      role: "SUPER_ADMIN",
      passwordHash: await hashPassword(tempPassword),
      mustChangePassword: true,
    },
  });

  console.log("\nSuper admin created.");
  console.log(`  Email:              ${email}`);
  console.log(`  Temporary password: ${tempPassword}`);
  console.log(
    "You will be asked to change it on first sign-in. This password is not shown again.\n",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
