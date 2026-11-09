import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '../generated/prisma/client.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { CreateApplicationDto } from './dto/create-application.dto.js';
import { QueryApplicationsDto } from './dto/query-applications.dto.js';
import { EventsGateway } from '../events/events.gateway.js';
import { NotificationsService } from '../notifications/notifications.service.js';

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private eventsGateway: EventsGateway,
    private notificationsService: NotificationsService,
    private cacheService: AppCacheService,
  ) {}

  // 1. Scholar submits or updates their application details
  async submitApplication(userId: number, dto: CreateApplicationDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { applications: true, user: true, documents: true },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    // Verify student_number uniqueness across other profiles
    if (dto.student_number) {
      const duplicateStudentNum = await this.prisma.scholarProfile.findFirst({
        where: {
          student_number: dto.student_number,
          profile_id: { not: scholar.profile_id },
        },
      });
      if (duplicateStudentNum) {
        throw new ConflictException(
          'Student number is already in use by another applicant.',
        );
      }
    }

    // Verify phone_number uniqueness if provided/updated
    if (dto.phone_number) {
      const duplicatePhone = await this.prisma.scholarProfile.findFirst({
        where: {
          phone_number: dto.phone_number,
          profile_id: { not: scholar.profile_id },
        },
      });
      if (duplicatePhone) {
        throw new ConflictException(
          'Phone number is already in use by another profile.',
        );
      }
    }

    // Verify relative_employee uniqueness across other profiles (1 scholar per employee policy)
    if (dto.relative_employee?.trim()) {
      const trimmedRelative = dto.relative_employee.trim();
      const duplicateRelative = await this.prisma.scholarProfile.findFirst({
        where: {
          relative_employee: {
            equals: trimmedRelative,
            mode: 'insensitive',
          },
          profile_id: { not: scholar.profile_id },
        },
      });
      if (duplicateRelative) {
        throw new ConflictException(
          'This relative employee is already associated with another scholar or applicant. The company policy permits only 1 scholar per employee.',
        );
      }
    }

    const applicantName =
      `${scholar.first_name || ''} ${scholar.last_name || ''}`.trim() ||
      'An applicant';

    let scholarProfileSchoolId: number | null = scholar.school_id;

    if (dto.school_name?.trim()) {
      const trimmedSchool = dto.school_name.trim();

      // Check existing in schools table
      const existingSchool = await this.prisma.school.findFirst({
        where: {
          school_name: { equals: trimmedSchool, mode: 'insensitive' },
        },
      });

      // Check existing in school_grading_systems
      const matchedGrading = await this.prisma.schoolGradingSystem.findFirst({
        where: {
          school_name: { equals: trimmedSchool, mode: 'insensitive' },
        },
      });

      if (matchedGrading) {
        scholarProfileSchoolId = matchedGrading.school_id;
      } else {
        scholarProfileSchoolId = null;
      }

      if (!existingSchool) {
        // Propose new school: registered as inactive (pending staff verification)
        const sWords = trimmedSchool
          .replace(/[^a-zA-Z0-9\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length > 0 && !/^(of|the|and|in|at|de|del|la|for)$/i.test(w));
        let generatedCode = sWords.map((w) => w[0]?.toUpperCase()).join('').slice(0, 10);
        if (generatedCode.length < 2) {
          generatedCode = trimmedSchool.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase();
        }

        const codeExists = await this.prisma.school.findUnique({
          where: { school_code: generatedCode },
        });
        const finalCode = codeExists ? null : (generatedCode || null);

        const newSchool = await this.prisma.school.create({
          data: {
            school_name: trimmedSchool,
            school_code: finalCode,
            address: dto.school_address?.trim() || null,
            is_active: false, // Pending verification
            grading_system_id: matchedGrading?.school_id || null,
          },
        });

        await this.cacheService.delPattern('settings:schools_list:');
        this.eventsGateway.emitToAll('school:created', newSchool);

        // Notify Coordinator, Grantor, and Admin
        await this.notificationsService.createForRoles(
          [Role.COORDINATOR, Role.GRANTOR, Role.ADMIN],
          {
            title: 'New School Proposed',
            message: `${applicantName} proposed new school "${trimmedSchool}". Review and verify to make it available for all applicants.`,
            category: 'school',
            link: '/Schools',
          },
        );
      }
    }

    if (dto.course_of_study?.trim()) {
      const trimmedCourse = dto.course_of_study.trim();
      const existingProgram = await this.prisma.academicProgram.findFirst({
        where: {
          OR: [
            { program_name: { equals: trimmedCourse, mode: 'insensitive' } },
            { program_code: { equals: trimmedCourse.toUpperCase(), mode: 'insensitive' } },
          ],
        },
      });

      if (!existingProgram) {
        // Propose new academic program: registered as inactive (pending staff verification)
        const pWords = trimmedCourse
          .replace(/[^a-zA-Z0-9\s-]/g, '')
          .split(/[\s-]+/)
          .filter((w) => w.length > 0);
        let generatedProgramCode = '';
        if (pWords[0]?.toUpperCase().startsWith('BS') && pWords[0].length > 2) {
          generatedProgramCode = pWords[0].toUpperCase();
        } else if (
          ['BS', 'AB', 'BA', 'MS', 'MA', 'BEED', 'BSED'].includes(
            pWords[0]?.toUpperCase(),
          )
        ) {
          const prefix = pWords[0].toUpperCase();
          const rest = pWords
            .slice(1)
            .filter((w) => !/^(in|of|and|the|for|major)$/i.test(w))
            .map((w) => w[0]?.toUpperCase())
            .join('');
          generatedProgramCode = `${prefix}${rest}`.slice(0, 10);
        } else {
          generatedProgramCode = pWords
            .filter((w) => !/^(in|of|and|the|for|major)$/i.test(w))
            .map((w) => w[0]?.toUpperCase())
            .join('')
            .slice(0, 10);
        }

        if (!generatedProgramCode || generatedProgramCode.length < 2) {
          generatedProgramCode = trimmedCourse
            .replace(/[^A-Za-z0-9]/g, '')
            .slice(0, 6)
            .toUpperCase();
        }

        const pCodeExists = await this.prisma.academicProgram.findUnique({
          where: { program_code: generatedProgramCode },
        });
        if (pCodeExists) {
          generatedProgramCode = `${generatedProgramCode.slice(0, 8)}${Math.floor(
            10 + Math.random() * 89,
          )}`;
        }

        const newProgram = await this.prisma.academicProgram.create({
          data: {
            program_code: generatedProgramCode,
            program_name: trimmedCourse,
            category: 'College',
            description: `Proposed by applicant (${applicantName})`,
            is_active: false, // Pending verification
          },
        });

        await this.cacheService.delPattern('settings:programs:');
        this.eventsGateway.emitToAll('program:created', newProgram);

        // Notify Coordinator, Grantor, and Admin
        await this.notificationsService.createForRoles(
          [Role.COORDINATOR, Role.GRANTOR, Role.ADMIN],
          {
            title: 'New Program Proposed',
            message: `${applicantName} proposed new academic program "${trimmedCourse}". Review and verify to make it available for all applicants.`,
            category: 'program',
            link: '/AcademicPrograms',
          },
        );
      }
    }

    // Update track, course, student number, and addresses on scholar profile
    await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        scholarship_track: dto.scholarship_track,
        course_of_study: dto.course_of_study,
        school_name: dto.school_name,
        school_id: scholarProfileSchoolId,
        student_number: dto.student_number,
        student_address: dto.student_address,
        school_address: dto.school_address,
        phone_number: dto.phone_number || scholar.phone_number,
        relative_employee: dto.relative_employee?.trim() || scholar.relative_employee,
        current_year_level:
          dto.current_year_level !== undefined
            ? dto.current_year_level
            : scholar.current_year_level,
      },
    });

    // Find existing application or create new one
    let application = scholar.applications[0];

    if (!application) {
      application = await this.prisma.application.create({
        data: {
          scholar_profile_id: scholar.profile_id,
          stage: 'Draft',
          status: 'PENDING',
        },
      });
    }

    // Check if the applicant already has confirmed documents
    const hasConfirmedDoc = scholar.documents?.some(
      (d) => d.status === 'STUDENT_CONFIRMED' || d.status === 'VERIFIED',
    );

    // If documents have not yet been confirmed, this is Step 1 of the application wizard.
    // Save details without firing premature "Application Submitted" notifications to staff.
    if (!hasConfirmedDoc) {
      await this.auditService.log(
        userId,
        'APPLICATION_DETAILS_SAVED',
        `Scholar (User ID: ${userId}) saved applicant details for application (ID: ${application.application_id}).`,
      );
      return application;
    }

    // If documents are already confirmed, the student is updating their existing details.
    await this.auditService.log(
      userId,
      'APPLICATION_DETAILS_UPDATED',
      `Scholar (User ID: ${userId}) updated applicant details for application (ID: ${application.application_id}).`,
    );

    return application;
  }

  // 2. Scholar finalizes and submits their application after uploading & confirming documents (Step 2)
  async finalizeApplication(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        applications: true,
        documents: true,
        user: true,
      },
    });

    if (!scholar || scholar.applications.length === 0) {
      throw new NotFoundException(
        'No active application found. Please complete your applicant details first.',
      );
    }

    const hasConfirmedDoc = scholar.documents?.some(
      (d) => d.status === 'STUDENT_CONFIRMED' || d.status === 'VERIFIED',
    );

    if (!hasConfirmedDoc) {
      throw new BadRequestException(
        'Please upload and confirm your required document before submitting your application.',
      );
    }

    const existingApp = scholar.applications[0];
    const isDraft = !existingApp.stage || existingApp.stage === 'Draft';

    if (!isDraft) {
      // Application was already formally submitted; prevent duplicate coordinator notifications and emails
      return existingApp;
    }

    const application = await this.prisma.application.update({
      where: { application_id: existingApp.application_id },
      data: {
        stage: 'Submitted',
        status: 'PENDING',
        submitted_at: existingApp.submitted_at ?? new Date(),
      },
    });

    await this.auditService.log(
      userId,
      'APPLICATION_SUBMITTED',
      `Scholar (User ID: ${userId}) submitted application (ID: ${application.application_id}).`,
    );

    const studentName =
      `${scholar.first_name} ${scholar.last_name}`.trim() || 'Applicant';

    // Dispatch emails (non-blocking)
    if (scholar.user?.email) {
      void this.mailService.sendApplicationSubmittedStudent(
        scholar.user.email,
        {
          studentName,
          track: scholar.scholarship_track || 'Scholarship',
          applicationId: application.application_id,
        },
      );
    }

    void this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        void this.mailService.sendApplicationSubmittedStaff(staffEmails, {
          studentName,
          track: scholar.scholarship_track || 'Scholarship',
          course: scholar.course_of_study || 'N/A',
          school: scholar.school_name || 'N/A',
          applicationId: application.application_id,
        });
      }
    });

    // Real-time broadcast to all coordinators and staff
    this.eventsGateway.emitToStaff('application:submitted', {
      applicationId: application.application_id,
      scholarProfileId: scholar.profile_id,
      studentName,
      studentNumber: scholar.student_number || null,
      track: scholar.scholarship_track || null,
      course: scholar.course_of_study || null,
      school: scholar.school_name || null,
      currentYearLevel: scholar.current_year_level ?? null,
      stage: application.stage,
      status: application.status,
      submittedAt: application.submitted_at.toISOString(),
    });

    void this.notificationsService.notifyStaff({
      title: 'New Application Submitted',
      message: `A new application was submitted by ${studentName} for ${scholar.scholarship_track || 'scholarship'}.`,
      category: 'application',
      link: '/CoordinatorApplicants',
    });

    void this.notificationsService.notifyUser(userId, {
      title: 'Application Submitted',
      message: `Your scholarship application for ${scholar.scholarship_track || 'scholarship'} was submitted successfully!`,
      category: 'application',
      link: '/ApplicantsDashboard',
    });

    return application;
  }

  // 2. Scholar views their own application progress timeline
  async getMyApplication(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        applications: {
          include: {
            reviewed_by_employee: true,
            scholar_profile: true,
          },
        },
        documents: true,
      },
    });

    if (!scholar || scholar.applications.length === 0) {
      throw new NotFoundException(
        'No active application found for this scholar.',
      );
    }

    return scholar.applications[0];
  }

  // 3. Staff list all applications with filters (Drafts excluded)
  async findAll(query: QueryApplicationsDto) {
    const where: Prisma.ApplicationWhereInput = {
      stage: { not: 'Draft' },
      ...(query.include_archived === 'true' ? {} : { archived_at: null }),
    };

    if (query.status) {
      where.status = query.status;
    }

    const scholarProfileWhere: Prisma.ScholarProfileWhereInput = {};
    if (query.track) {
      scholarProfileWhere.scholarship_track = query.track;
    }

    if (query.search) {
      scholarProfileWhere.OR = [
        { first_name: { contains: query.search, mode: 'insensitive' } },
        { last_name: { contains: query.search, mode: 'insensitive' } },
        { student_number: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    if (query.track || query.search) {
      where.scholar_profile = { is: scholarProfileWhere };
    }

    const applications = await this.prisma.application.findMany({
      where,
      orderBy: { submitted_at: 'desc' },
      include: {
        scholar_profile: {
          include: {
            _count: {
              select: { documents: true, contracts: true },
            },
            contracts: {
              select: {
                contract_id: true,
                contract_number: true,
                status: true,
              },
            },
          },
        },
        reviewed_by_employee: true,
      },
    });

    // Attach each applicant's General Average. The coordinator reviews
    // against the student's own confirmed document data
    // (confirmed_data.general_average, latest document first), falling back
    // to the latest verified grade report GPA when nothing is confirmed yet.
    const profileIds = [
      ...new Set(applications.map((a) => a.scholar_profile_id)),
    ];
    const [latestReports, documents] = await Promise.all([
      this.prisma.gradeReport.findMany({
        where: { scholar_profile_id: { in: profileIds } },
        orderBy: { submitted_at: 'desc' },
        select: { scholar_profile_id: true, gpa: true },
      }),
      this.prisma.scholarDocument.findMany({
        where: { scholar_profile_id: { in: profileIds } },
        orderBy: { uploaded_at: 'desc' },
        select: { scholar_profile_id: true, confirmed_data: true },
      }),
    ]);
    const gpaByProfile = new Map<number, number>();
    for (const report of latestReports) {
      if (!gpaByProfile.has(report.scholar_profile_id)) {
        gpaByProfile.set(report.scholar_profile_id, Number(report.gpa));
      }
    }
    const confirmedByProfile = new Map<number, number>();
    for (const doc of documents) {
      if (confirmedByProfile.has(doc.scholar_profile_id)) continue;
      const raw = (doc.confirmed_data as { general_average?: unknown } | null)
        ?.general_average;
      const value =
        typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
      if (Number.isFinite(value) && value > 0) {
        confirmedByProfile.set(doc.scholar_profile_id, value);
      }
    }

    return applications.map((a) => {
      const confirmed = confirmedByProfile.get(a.scholar_profile_id);
      if (confirmed !== undefined) {
        return {
          ...a,
          general_average: confirmed,
          general_average_source: 'confirmed' as const,
        };
      }
      const gpa = gpaByProfile.get(a.scholar_profile_id);
      return {
        ...a,
        general_average: gpa ?? null,
        general_average_source: gpa !== undefined ? 'verified' : null,
      };
    });
  }

  // 4. Staff views every document an applicant has uploaded (for coordinator
  // document confirmation). Same field shape as GET /documents/me so the
  // coordinator preview can reuse it (file, OCR data, confirmed data).
  async getApplicationDocuments(applicationId: number) {
    const application = await this.prisma.application.findUnique({
      where: { application_id: applicationId },
    });

    if (!application) {
      throw new NotFoundException(`Application ID ${applicationId} not found.`);
    }

    return this.prisma.scholarDocument.findMany({
      where: { scholar_profile_id: application.scholar_profile_id },
      orderBy: { uploaded_at: 'desc' },
      select: {
        document_id: true,
        document_type: true,
        label: true,
        file_name: true,
        file_url: true,
        file_type: true,
        status: true,
        rejection_reason: true,
        extracted_data: true,
        confirmed_data: true,
        uploaded_at: true,
        verified_at: true,
      },
    });
  }
}
