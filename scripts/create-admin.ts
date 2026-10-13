// scripts/create-admin.ts
// Creates accounts that the dashboard intentionally cannot create. Roles:
//   super_admin    the unit director. Only ONE can ever exist.
//   admin_manager  creates and removes officers from the dashboard.
//   officer        works reports. (Normally created by an admin manager in the dashboard.)
//
//   npx tsx scripts/create-admin.ts admin_manager manager@icpc.gov.ng "Full Name"
//   npx tsx scripts/create-admin.ts super_admin director@icpc.gov.ng "Full Name"
// Against production: railway run npx tsx scripts/create-admin.ts ...
import 'dotenv/config';
import { prisma } from '../src/db';
import { hashPassword, generateTempPassword } from '../src/utils/password';

const ROLES = { super_admin: 'SUPER_ADMIN', admin_manager: 'ADMIN_MANAGER', officer: 'OFFICER' } as const;

async function main() {
  const [roleArg, emailArg, nameArg] = process.argv.slice(2);
  const role = ROLES[roleArg as keyof typeof ROLES];
  if (!role || !emailArg || !emailArg.includes('@')) {
    console.error('Usage: npx tsx scripts/create-admin.ts <super_admin|admin_manager|officer> <email> [name]');
    process.exit(1);
  }

  if (role === 'SUPER_ADMIN') {
    const existing = await prisma.admin.findFirst({ where: { role: 'SUPER_ADMIN' }, select: { email: true } });
    if (existing) {
      console.error(`A super admin already exists (${existing.email}). Only one is allowed.`);
      process.exit(1);
    }
  }

  const email = emailArg.trim().toLowerCase();
  if (await prisma.admin.findUnique({ where: { email } })) {
    console.error(`An account with ${email} already exists.`);
    process.exit(1);
  }

  const tempPassword = generateTempPassword();
  await prisma.admin.create({
    data: {
      email,
      name: nameArg?.trim() || email.split('@')[0],
      role,
      passwordHash: await hashPassword(tempPassword),
      mustChangePassword: true,
    },
  });

  console.log(`\n${role} created.`);
  console.log(`  Email:              ${email}`);
  console.log(`  Temporary password: ${tempPassword}`);
  console.log('They must change it at first sign-in. This password is not shown again.\n');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());