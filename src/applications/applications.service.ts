import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { Role } from '../generated/prisma/enums.js';
import { CreateApplicationDto } from './dto/create-application.dto.js';
import { QueryApplicationsDto } from './dto/query-applications.dto.js';
import { UpdateApplicationStageDto } from './dto/update-stage.dto.js';

@Injectable()
export class ApplicationsService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
  ) {}

  // 1. Scholar submits or updates their application details
  async submitApplication(userId: number, dto: CreateApplicationDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { applications: true },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    // Update track and course on scholar profile
    await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        scholarship_track: dto.scholarship_track,
        course_of_study: dto.course_of_study,
        school_name: dto.school_name,
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
    const where: any = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.track) {
      where.scholar_profile = { scholarship_track: query.track };
    }

    if (query.search) {
      where.scholar_profile = {
        OR: [
          { first_name: { contains: query.search, mode: 'insensitive' } },
          { last_name: { contains: query.search, mode: 'insensitive' } },
          { student_number: { contains: query.search, mode: 'insensitive' } },
        ],
      };
    }

    return this.prisma.application.findMany({
      where,
      orderBy: { submitted_at: 'desc' },
      include: {
        scholar_profile: true,
        reviewed_by_employee: true,
      },
    });
  }

  // 4. Staff updates application stage (Review, Schedule Interview, Approve, Reject)
  async updateStage(
    employeeUserId: number,
    applicationId: number,
    dto: UpdateApplicationStageDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });

    if (!employee) {
      throw new BadRequestException(
        'Reviewing staff employee record not found.',
      );
    }

    const application = await this.prisma.application.findUnique({
      where: { application_id: applicationId },
    });

    if (!application) {
      throw new NotFoundException(`Application ID ${applicationId} not found.`);
    }

    const { application: updated, promoted } = await this.prisma.$transaction(
      async (tx) => {
        const application = await tx.application.update({
          where: { application_id: applicationId },
          data: {
            status: dto.status,
            stage: dto.stage,
            stage_updated_at: new Date(),
            interview_at: dto.interview_at
              ? new Date(dto.interview_at)
              : undefined,
            provider_notes: dto.provider_notes,
            rejection_reason: dto.rejection_reason,
            reviewed_by_employee_id: employee.employee_id,
            decision_at: ['APPROVED', 'REJECTED'].includes(dto.status)
              ? new Date()
              : undefined,
          },
        });

        let promotedCount = 0;

        if (dto.status === 'APPROVED') {
          const result = await tx.user.updateMany({
            where: {
              scholar_profile: { profile_id: application.scholar_profile_id },
              role: Role.APPLICANT,
            },
            data: { role: Role.SCHOLAR },
          });
          promotedCount = result.count;
        }

        return { application, promoted: promotedCount > 0 };
      },
    );

    // Audit log stage transition
    await this.auditService.log(
      employeeUserId,
      'APPLICATION_STAGE_UPDATED',
      `Application ID ${applicationId} stage updated to '${dto.stage}' (${dto.status})` +
        (promoted ? ' — applicant promoted to SCHOLAR' : ''),
    );

    return updated;
  }
}
