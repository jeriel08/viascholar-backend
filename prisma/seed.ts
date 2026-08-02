// prisma/seed.ts

import * as bcrypt from 'bcrypt';
import { PrismaClient, Role } from '../src/generated/prisma/client.js';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const adminEmail = 'admin@viascholar.com';

  // Check if admin already exists
  const existingAdmin = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (existingAdmin) {
    console.log('⚡ Initial Super Admin already exists.');
    return;
  }

  // Hash initial admin password
  const hashedPassword = await bcrypt.hash('AdminPassword123!', 10);

  // Create initial Admin User + Employee profile
  const adminUser = await prisma.user.create({
    data: {
      email: adminEmail,
      password_hash: hashedPassword,
      role: Role.ADMIN,
      is_active: true,
      employee: {
        create: {
          first_name: 'Super',
          last_name: 'Admin',
          title: 'System Administrator',
          department: 'Executive Office',
        },
      },
    },
  });

  console.log(`✅ Super Admin created successfully!`);
  console.log(`📧 Email: ${adminUser.email}`);
  console.log(`🔑 Password: AdminPassword123!`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
