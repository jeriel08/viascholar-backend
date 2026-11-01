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

  // 4. Seed Baseline Academic Programs
  const baselinePrograms = [
    {
      program_code: 'BSIT',
      program_name: 'BS Information Technology',
      category: 'College',
      description: 'Bachelor of Science in Information Technology',
    },
    {
      program_code: 'BSCS',
      program_name: 'BS Computer Science',
      category: 'College',
      description: 'Bachelor of Science in Computer Science',
    },
    {
      program_code: 'BSIS',
      program_name: 'BS Information Systems',
      category: 'College',
      description: 'Bachelor of Science in Information Systems',
    },
    {
      program_code: 'BSA',
      program_name: 'BS Accountancy',
      category: 'College',
      description: 'Bachelor of Science in Accountancy',
    },
    {
      program_code: 'BSMA',
      program_name: 'BS Management Accounting',
      category: 'College',
      description: 'Bachelor of Science in Management Accounting',
    },
    {
      program_code: 'BSBA',
      program_name: 'BS Business Administration',
      category: 'College',
      description: 'Bachelor of Science in Business Administration',
    },
    {
      program_code: 'BSHM',
      program_name: 'BS Hospitality Management',
      category: 'College',
      description: 'Bachelor of Science in Hospitality Management',
    },
    {
      program_code: 'BSTM',
      program_name: 'BS Tourism Management',
      category: 'College',
      description: 'Bachelor of Science in Tourism Management',
    },
    {
      program_code: 'BSN',
      program_name: 'BS Nursing',
      category: 'College',
      description: 'Bachelor of Science in Nursing',
    },
    {
      program_code: 'BSMT',
      program_name: 'BS Medical Technology',
      category: 'College',
      description: 'Bachelor of Science in Medical Technology',
    },
    {
      program_code: 'BSPharm',
      program_name: 'BS Pharmacy',
      category: 'College',
      description: 'Bachelor of Science in Pharmacy',
    },
    {
      program_code: 'BSCE',
      program_name: 'BS Civil Engineering',
      category: 'College',
      description: 'Bachelor of Science in Civil Engineering',
    },
    {
      program_code: 'BSME',
      program_name: 'BS Mechanical Engineering',
      category: 'College',
      description: 'Bachelor of Science in Mechanical Engineering',
    },
    {
      program_code: 'BSEE',
      program_name: 'BS Electrical Engineering',
      category: 'College',
      description: 'Bachelor of Science in Electrical Engineering',
    },
    {
      program_code: 'BSECE',
      program_name: 'BS Electronics Engineering',
      category: 'College',
      description: 'Bachelor of Science in Electronics Engineering',
    },
    {
      program_code: 'BSIE',
      program_name: 'BS Industrial Engineering',
      category: 'College',
      description: 'Bachelor of Science in Industrial Engineering',
    },
    {
      program_code: 'BSArch',
      program_name: 'BS Architecture',
      category: 'College',
      description: 'Bachelor of Science in Architecture',
    },
    {
      program_code: 'BEED',
      program_name: 'Bachelor of Elementary Education',
      category: 'College',
      description: 'Bachelor of Elementary Education',
    },
    {
      program_code: 'BSED',
      program_name: 'Bachelor of Secondary Education',
      category: 'College',
      description: 'Bachelor of Secondary Education',
    },
    {
      program_code: 'ABComm',
      program_name: 'AB Communication',
      category: 'College',
      description: 'Bachelor of Arts in Communication',
    },
    {
      program_code: 'BSPsych',
      program_name: 'BS Psychology',
      category: 'College',
      description: 'Bachelor of Science in Psychology',
    },
    {
      program_code: 'STEM',
      program_name: 'Senior High School - STEM Strand',
      category: 'Senior High School',
      description: 'Science, Technology, Engineering, and Mathematics',
    },
    {
      program_code: 'ABM',
      program_name: 'Senior High School - ABM Strand',
      category: 'Senior High School',
      description: 'Accountancy, Business, and Management',
    },
    {
      program_code: 'HUMSS',
      program_name: 'Senior High School - HUMSS Strand',
      category: 'Senior High School',
      description: 'Humanities and Social Sciences',
    },
    {
      program_code: 'GAS',
      program_name: 'Senior High School - GAS Strand',
      category: 'Senior High School',
      description: 'General Academic Strand',
    },
    {
      program_code: 'TVL',
      program_name: 'Senior High School - TVL Track',
      category: 'Senior High School',
      description: 'Technical-Vocational-Livelihood Track',
    },
  ];

  for (const prog of baselinePrograms) {
    const exists = await prisma.academicProgram.findUnique({
      where: { program_code: prog.program_code },
    });
    if (!exists) {
      await prisma.academicProgram.create({
        data: prog,
      });
      console.log(`✅ Seeded Academic Program: ${prog.program_name} (${prog.program_code})`);
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
