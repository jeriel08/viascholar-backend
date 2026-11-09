// Temporary archive-verification helper — creates a synthetic school, program slot, and
// scholar user purely for testing the archive endpoints, then removes them on cleanup.
// Usage: npx tsx --env-file=.env scripts/archive-test-fixture.ts setup | cleanup
import 'dotenv/config';
import { PrismaClient, Role } from '../src/generated/prisma/client.js';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const connectionString = `${process.env.DATABASE_URL}`;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const TOKEN = Date.now().toString().slice(-6);
const SCHOOL_NAME = `ViaScholar Archive Test ${TOKEN}`;
const SCHOOL_CODE = `ARCTEST${TOKEN}`;
const SCHOLAR_EMAIL = `arch.test.${TOKEN}@example.com`;

async function setup() {
  const school = await prisma.school.create({
    data: {
      school_name: SCHOOL_NAME,
      school_code: SCHOOL_CODE,
      address: '1 Test Way',
      is_active: true,
    },
  });

  const scholarUser = await prisma.user.create({
    data: {
      email: SCHOLAR_EMAIL,
      password_hash: await bcrypt.hash('ArchiveTest123!', 10),
      role: Role.SCHOLAR,
      is_active: true,
      scholar_profile: {
        create: {
          first_name: 'Archive',
          last_name: 'Test',
          phone_number: `09${TOKEN}01`,
          course_of_study: 'BS QA Testing',
          scholarship_track: 'Academic',
        },
      },
    },
    include: { scholar_profile: true },
  });

  console.log(
    JSON.stringify({
      school_id: school.school_id,
      school_name: SCHOOL_NAME,
      school_code: SCHOOL_CODE,
      scholar_user_id: scholarUser.user_id,
      scholar_profile_id: scholarUser.scholar_profile?.profile_id,
      scholar_email: SCHOLAR_EMAIL,
    }),
  );
}

async function cleanup() {
  const school = await prisma.school.findFirst({ where: { school_code: { startsWith: 'ARCTEST' } } });
  if (school) {
    await prisma.scholarProfile.updateMany({ where: { school_id: school.school_id }, data: { school_id: null } });
    await prisma.school.delete({ where: { school_id: school.school_id } });
    console.log(`Deleted test school ${school.school_code}`);
  }
  const user = await prisma.user.findFirst({ where: { email: { startsWith: 'arch.test.' } } });
  if (user) {
    await prisma.user.delete({ where: { user_id: user.user_id } });
    console.log(`Deleted test scholar user ${user.email}`);
  }
  const program = await prisma.academicProgram.findFirst({
    where: { program_code: 'ARCH-TEST-901' },
  });
  if (program) {
    await prisma.academicProgram.delete({ where: { program_id: program.program_id } });
    console.log(`Deleted test program ${program.program_code}`);
  }
}

const command = process.argv[2];
if (command === 'setup') {
  await setup();
} else if (command === 'cleanup') {
  await cleanup();
} else {
  console.error('Usage: npx tsx scripts/archive-test-fixture.ts setup|cleanup');
  process.exit(1);
}

await prisma.$disconnect();
await pool.end();
