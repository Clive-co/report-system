// scripts/reset-admin-password.ts
// Recovery path for accounts the dashboard can't reset: the super admin and admin managers.
// (Admin managers reset OFFICER passwords from the dashboard.)
//   npx tsx scripts/reset-admin-password.ts director@icpc.gov.ng
import 'dotenv/config';
import { prisma } from '../src/db';
import { hashPassword, generateTempPassword } from '../src/utils/password';

async function main() {
  const emailArg = process.argv[2];
  if (!emailArg) {
    console.error('Usage: npx tsx scripts/reset-admin-password.ts <email>');
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  const admin = await prisma.admin.findUnique({ where: { email } });
  if (!admin) {
    console.error(`No account found for ${email}.`);
    process.exit(1);
  }

  const tempPassword = generateTempPassword();
  await prisma.$transaction([
    prisma.admin.update({
      where: { id: admin.id },
      data: { passwordHash: await hashPassword(tempPassword), mustChangePassword: true, failedAttempts: 0, lockedUntil: null },
    }),
    prisma.adminSession.deleteMany({ where: { adminId: admin.id } }),
  ]);

  console.log(`\nPassword reset for ${email} (${admin.role}). They are signed out everywhere.`);
  console.log(`  Temporary password: ${tempPassword}`);
  console.log('They must change it at first sign-in. This password is not shown again.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());