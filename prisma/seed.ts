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
  const adminEmail = 'admin.viascholar@yopmail.com';

  // 1. Seed Super Admin
  let adminUser = await prisma.user.findUnique({
    where: { email: adminEmail },
  });

  if (!adminUser) {
    const hashedPassword = await bcrypt.hash('AdminPassword123!', 10);
    adminUser = await prisma.user.create({
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
    console.log(`✅ Super Admin created successfully! (${adminUser.email})`);
  } else {
    console.log('⚡ Initial Super Admin already exists.');
  }

  // 2. Seed Global System Settings
  const existingSetting = await prisma.systemSetting.findFirst();
  if (!existingSetting) {
    await prisma.systemSetting.create({
      data: {
        grade_threshold: 90.0,
      },
    });
    console.log('✅ Global Grade Retention Threshold initialized to 90.00%.');
  } else {
    await prisma.systemSetting.update({
      where: { setting_id: existingSetting.setting_id },
      data: { grade_threshold: 90.0 },
    });
    console.log('✅ Global Grade Retention Threshold updated to 90.00%.');
  }

  // 3. Seed Baseline School Grading Systems
  const baselineSchools = [
    {
      school_name: 'High School / Senior High (DepEd Standard)',
      grading_scale: 'PERCENTAGE_100',
      highest_grade: 100.0,
      passing_grade: 75.0,
      failing_grade: 50.0,
      min_grade: 50.0,
      max_grade: 100.0,
      is_verified: true,
      notes: 'Standard DepEd Senior High School / Junior High School grading scale (Form 138 / SF9).',
    },
    {
      school_name: 'University of Southeastern Philippines (USEP)',
      grading_scale: 'NUMERIC_5_POINT',
      highest_grade: 1.0,
      passing_grade: 3.0,
      failing_grade: 5.0,
      min_grade: 1.0,
      max_grade: 5.0,
      is_verified: true,
      notes: 'State university inverse 5-point grading system. 1.00 is highest/excellent, 3.00 passing, 5.00 failed.',
    },
    {
      school_name: 'University of Mindanao (UM)',
      grading_scale: 'NUMERIC_4_POINT',
      highest_grade: 4.0,
      passing_grade: 2.0,
      failing_grade: 1.0,
      min_grade: 1.0,
      max_grade: 4.0,
      is_verified: true,
      special_codes: {
        '7.1': 'INCOMPLETE',
        '7.2': 'LACKING_REQUIREMENTS',
        '9.0': 'DROPPED',
      },
      notes: 'Undergraduate Grading Scale (Effective 1st Semester SY 2020-2021 to Present). 4.00 highest, 2.00 passing, 1.00 failing.',
    },
    {
      school_name: 'Ateneo de Davao University (ADDU)',
      grading_scale: 'NUMERIC_5_POINT',
      highest_grade: 1.0,
      passing_grade: 3.0,
      failing_grade: 5.0,
      min_grade: 1.0,
      max_grade: 5.0,
      is_verified: true,
      notes: 'Standard 5-point inverse numerical grading scale. 1.00 highest, 3.00 passing.',
    },
    {
      school_name: 'University of the Philippines (UP)',
      grading_scale: 'NUMERIC_5_POINT',
      highest_grade: 1.0,
      passing_grade: 3.0,
      failing_grade: 5.0,
      min_grade: 1.0,
      max_grade: 5.0,
      is_verified: true,
      special_codes: {
        INC: 'INCOMPLETE',
        DRP: 'DROPPED',
      },
      notes: 'UP System 5-point grading scale. 1.00 is highest/excellent, 3.00 passing, 5.00 failed.',
    },
  ];

  for (const school of baselineSchools) {
    const exists = await prisma.schoolGradingSystem.findUnique({
      where: { school_name: school.school_name },
    });
    if (!exists) {
      await prisma.schoolGradingSystem.create({
        data: school,
      });
      console.log(`✅ Seeded School Grading System: ${school.school_name}`);
    }
  }

  console.log('🎉 Database seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
