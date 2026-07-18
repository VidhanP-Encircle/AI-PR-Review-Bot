import { prisma } from './src/db/prisma.js';
import bcrypt from 'bcryptjs';

async function main() {
  const email = 'admin@example.com';
  const plainPassword = 'password123';

  // Create an org first
  let org = await prisma.organization.findFirst({
    where: { name: 'Acme Corp' },
  });

  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'Acme Corp'
      }
    });
  }

  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  const user = await prisma.user.upsert({
    where: { email },
    update: {
      hashedPassword,
      organizationId: org.id
    },
    create: {
      email,
      hashedPassword,
      role: 'ADMIN',
      organizationId: org.id
    }
  });

  console.log(`User created: ${user.email} / ${plainPassword}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
