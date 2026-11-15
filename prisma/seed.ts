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

  // 2.5 Clean up legacy parenthetical abbreviations in existing seeded schools & profiles
  const legacySchoolRenames: Array<{ oldName: string; newName: string }> = [
    {
      oldName: 'University of Southeastern Philippines (USEP)',
      newName: 'University of Southeastern Philippines',
    },
    {
      oldName: 'University of Mindanao (UM)',
      newName: 'University of Mindanao',
    },
    {
      oldName: 'Ateneo de Davao University (ADDU)',
      newName: 'Ateneo de Davao University',
    },
    {
      oldName: 'University of the Philippines (UP)',
      newName: 'University of the Philippines',
    },
    {
      oldName: 'Mapúa Malayan Colleges Mindanao (MMCM)',
      newName: 'Mapúa Malayan Colleges Mindanao',
    },
    {
      oldName: 'San Pedro College (SPC)',
      newName: 'San Pedro College',
    },
    {
      oldName: 'University of the Immaculate Conception (UIC)',
      newName: 'University of the Immaculate Conception',
    },
  ];

  for (const { oldName, newName } of legacySchoolRenames) {
    const oldGrading = await prisma.schoolGradingSystem.findUnique({
      where: { school_name: oldName },
    });
    if (oldGrading) {
      const existingCleanGrading = await prisma.schoolGradingSystem.findUnique({
        where: { school_name: newName },
      });
      if (!existingCleanGrading) {
        await prisma.schoolGradingSystem.update({
          where: { school_id: oldGrading.school_id },
          data: { school_name: newName },
        });
        console.log(
          `✅ Renamed School Grading System: ${oldName} -> ${newName}`,
        );
      } else {
        await prisma.school.updateMany({
          where: { grading_system_id: oldGrading.school_id },
          data: { grading_system_id: existingCleanGrading.school_id },
        });
        const linkedScholarCount = await prisma.scholarProfile.count({
          where: { school_id: oldGrading.school_id },
        });
        if (linkedScholarCount === 0) {
          await prisma.schoolGradingSystem.delete({
            where: { school_id: oldGrading.school_id },
          });
          console.log(
            `✅ Merged duplicate School Grading System: ${oldName} -> ${newName}`,
          );
        }
      }
    }

    const oldSchool = await prisma.school.findUnique({
      where: { school_name: oldName },
    });
    if (oldSchool) {
      const existingCleanSchool = await prisma.school.findUnique({
        where: { school_name: newName },
      });
      if (!existingCleanSchool) {
        await prisma.school.update({
          where: { school_id: oldSchool.school_id },
          data: { school_name: newName },
        });
        console.log(`✅ Renamed School Entity: ${oldName} -> ${newName}`);
      } else {
        const linkedScholarCount = await prisma.scholarProfile.count({
          where: { school_id: oldSchool.school_id },
        });
        if (linkedScholarCount === 0) {
          await prisma.school.delete({
            where: { school_id: oldSchool.school_id },
          });
          console.log(`✅ Removed duplicate legacy School Entity: ${oldName}`);
        }
      }
    }

    const updatedProfiles = await prisma.scholarProfile.updateMany({
      where: { school_name: oldName },
      data: { school_name: newName },
    });
    if (updatedProfiles.count > 0) {
      console.log(
        `✅ Updated ${updatedProfiles.count} scholar profile school_name(s): ${oldName} -> ${newName}`,
      );
    }
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
      notes:
        'Standard DepEd Senior High School / Junior High School grading scale (Form 138 / SF9).',
    },
    {
      school_name: 'University of Southeastern Philippines',
      grading_scale: 'NUMERIC_5_POINT',
      highest_grade: 1.0,
      passing_grade: 3.0,
      failing_grade: 5.0,
      min_grade: 1.0,
      max_grade: 5.0,
      is_verified: true,
      notes:
        'State university inverse 5-point grading system. 1.00 is highest/excellent, 3.00 passing, 5.00 failed.',
    },
    {
      school_name: 'University of Mindanao',
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
      notes:
        'Undergraduate Grading Scale (Effective 1st Semester SY 2020-2021 to Present). 4.00 highest, 2.00 passing, 1.00 failing.',
    },
    {
      school_name: 'Ateneo de Davao University',
      grading_scale: 'NUMERIC_5_POINT',
      highest_grade: 1.0,
      passing_grade: 3.0,
      failing_grade: 5.0,
      min_grade: 1.0,
      max_grade: 5.0,
      is_verified: true,
      notes:
        'Standard 5-point inverse numerical grading scale. 1.00 highest, 3.00 passing.',
    },
    {
      school_name: 'University of the Philippines',
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
      notes:
        'UP System 5-point grading scale. 1.00 is highest/excellent, 3.00 passing, 5.00 failed.',
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

  // 3.5 Seed Baseline School Institutions (Normalized Higher-Ed Schools table linked to Grading System)
  // Note: DepEd remains in SchoolGradingSystem for Form 138 high school evaluation,
  // but is excluded from the Higher Education Schools list to avoid student confusion.
  await prisma.school.deleteMany({
    where: {
      OR: [
        { school_code: 'DEPED' },
        { school_name: { contains: 'DepEd', mode: 'insensitive' } },
        { school_name: { contains: 'High School', mode: 'insensitive' } },
      ],
    },
  });

  const baselineInstitutions = [
    {
      school_name: 'University of Southeastern Philippines',
      school_code: 'USEP',
      address: 'Iñigo St, Bo. Obrero, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'University of Southeastern Philippines',
      is_active: true,
    },
    {
      school_name: 'University of Mindanao',
      school_code: 'UM',
      address: 'Bolton & Matina Campus, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'University of Mindanao',
      is_active: true,
    },
    {
      school_name: 'Ateneo de Davao University',
      school_code: 'ADDU',
      address:
        'E. Jacinto St, Poblacion District, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'Ateneo de Davao University',
      is_active: true,
    },
    {
      school_name: 'University of the Philippines',
      school_code: 'UP',
      address: 'Mintal, Tugbok District, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'University of the Philippines',
      is_active: true,
    },
    {
      school_name: 'Mapúa Malayan Colleges Mindanao',
      school_code: 'MMCM',
      address:
        'Gen. Douglas MacArthur Hwy, Matina, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'University of Mindanao',
      is_active: true,
    },
    {
      school_name: 'San Pedro College',
      school_code: 'SPC',
      address:
        '12 C. de Guzman St, Poblacion District, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'High School / Senior High (DepEd Standard)',
      is_active: true,
    },
    {
      school_name: 'University of the Immaculate Conception',
      school_code: 'UIC',
      address: 'Father Selga St, Davao City, 8000 Davao del Sur',
      grading_scale_match: 'University of Mindanao',
      is_active: true,
    },
  ];

  for (const inst of baselineInstitutions) {
    const gradingSystem = await prisma.schoolGradingSystem.findUnique({
      where: { school_name: inst.grading_scale_match },
    });

    const exists = await prisma.school.findUnique({
      where: { school_name: inst.school_name },
    });

    if (!exists) {
      await prisma.school.create({
        data: {
          school_name: inst.school_name,
          school_code: inst.school_code,
          address: inst.address,
          grading_system_id: gradingSystem?.school_id || null,
          is_active: inst.is_active,
        },
      });
      console.log(
        `✅ Seeded School Entity: ${inst.school_name} (${inst.school_code})`,
      );
    } else if (!exists.grading_system_id && gradingSystem) {
      await prisma.school.update({
        where: { school_id: exists.school_id },
        data: { grading_system_id: gradingSystem.school_id },
      });
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
  ];

  for (const prog of baselinePrograms) {
    const exists = await prisma.academicProgram.findUnique({
      where: { program_code: prog.program_code },
    });
    if (!exists) {
      await prisma.academicProgram.create({
        data: prog,
      });
      console.log(
        `✅ Seeded Academic Program: ${prog.program_name} (${prog.program_code})`,
      );
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
