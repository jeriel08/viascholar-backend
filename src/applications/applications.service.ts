import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { MailService } from '../mail/mail.service.js';
import { CreateApplicationDto } from './dto/create-application.dto.js';
import { QueryApplicationsDto } from './dto/query-applications.dto.js';
import { EventsGateway } from '../events/events.gateway.js';

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private mailService: MailService,
    private eventsGateway: EventsGateway,
  ) {}

  // 1. Scholar submits or updates their application details
  async submitApplication(userId: number, dto: CreateApplicationDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { applications: true, user: true },
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

    // Update track, course, student number, and addresses on scholar profile
    await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        scholarship_track: dto.scholarship_track,
        course_of_study: dto.course_of_study,
        school_name: dto.school_name,
        student_number: dto.student_number,
        student_address: dto.student_address,
        school_address: dto.school_address,
        phone_number: dto.phone_number || scholar.phone_number,
        relative_employee: dto.relative_employee,
      },
    });

    // Find existing application or create new one
    let application = scholar.applications[0];

    if (!application) {
      application = await this.prisma.application.create({
        data: {
          scholar_profile_id: scholar.profile_id,
          stage: 'Submitted',
          status: 'PENDING',
        },
      });
    }

    await this.auditService.log(
      userId,
      'APPLICATION_SUBMITTED',
      `Scholar (User ID: ${userId}) submitted application (ID: ${application.application_id}).`,
    );

    // Dispatch emails (non-blocking)
    const studentName =
      `${scholar.first_name} ${scholar.last_name}`.trim() || 'Applicant';

    if (scholar.user?.email) {
      void this.mailService.sendApplicationSubmittedStudent(
        scholar.user.email,
        {
          studentName,
          track: dto.scholarship_track,
          applicationId: application.application_id,
        },
      );
    }

    void this.mailService.getStaffEmails().then((staffEmails) => {
      if (staffEmails.length > 0) {
        void this.mailService.sendApplicationSubmittedStaff(staffEmails, {
          studentName,
          track: dto.scholarship_track,
          course: dto.course_of_study,
          school: dto.school_name,
          applicationId: application.application_id,
        });
      }
    });

    // Real-time broadcast to all coordinators and staff
    this.eventsGateway.emitToStaff('application:submitted', {
      applicationId: application.application_id,
      scholarProfileId: scholar.profile_id,
      studentName,
      studentNumber: dto.student_number || scholar.student_number || null,
      track: dto.scholarship_track,
      course: dto.course_of_study,
      school: dto.school_name,
      stage: application.stage,
      status: application.status,
      submittedAt: new Date().toISOString(),
    });

    return application;
  }

  // 2. Scholar views their own application progress timeline
  async getMyApplication(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        applications: {
          include: { reviewed_by_employee: true },
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

  // 3. Staff list all applications with filters
  async findAll(query: QueryApplicationsDto) {
    const where: Prisma.ApplicationWhereInput = {};

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
        scholar_profile: true,
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
