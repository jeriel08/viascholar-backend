import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { Role } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ArchiveRecordDto, ArchiveReason } from './dto/archive-record.dto.js';
import {
  ArchiveEntity,
  QueryArchiveDto,
} from './dto/query-archive.dto.js';

const SCHOOL_ARCHIVE_REASONS: ArchiveReason[] = ['SCHOOL_CLOSED', 'OTHER'];
const PROGRAM_ARCHIVE_REASONS: ArchiveReason[] = [
  'PROGRAM_OUTDATED',
  'PROGRAM_REMOVED',
  'OTHER',
];
const SCHOLAR_ARCHIVE_REASONS: ArchiveReason[] = [
  'GRADUATED',
  'FAILED_SECOND_CHANCE',
  'WITHDRAWN',
  'TERMINATED',
  'OTHER',
];
const APPLICANT_ARCHIVE_REASONS: ArchiveReason[] = [
  'APPLICATION_REJECTED',
  'OTHER',
];

export interface ArchiveListResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class ArchiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
    private readonly cacheService: AppCacheService,
    @Optional() private readonly notificationsService?: NotificationsService,
  ) {}

  // ==========================================
  // ARCHIVE LISTS
  // ==========================================

  async listArchived(query: QueryArchiveDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const entity: ArchiveEntity = query.entity ?? 'scholar';

    switch (entity) {
      case 'school':
        return this.listArchivedSchools(query, page, limit);
      case 'program':
        return this.listArchivedPrograms(query, page, limit);
      case 'applicant':
        return this.listArchivedApplicants(query, page, limit);
      case 'scholar':
      default:
        return this.listArchivedScholars(query, page, limit);
    }
  }

  private buildPaginatedResult<T>(
    data: T[],
    total: number,
    page: number,
    limit: number,
  ): ArchiveListResult<T> {
    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 0,
    };
  }

  private async listArchivedScholars(
    query: QueryArchiveDto,
    page: number,
    limit: number,
  ) {
    const where: Prisma.ScholarProfileWhereInput = {
      archived_at: { not: null },
      user: { role: 'SCHOLAR' },
    };

    if (query.reason) {
      where.archive_reason = query.reason;
    }

    if (query.search) {
      where.OR = [
        { first_name: { contains: query.search, mode: 'insensitive' } },
        { last_name: { contains: query.search, mode: 'insensitive' } },
        { student_number: { contains: query.search, mode: 'insensitive' } },
        { course_of_study: { contains: query.search, mode: 'insensitive' } },
        { school_name: { contains: query.search, mode: 'insensitive' } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.scholarProfile.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { archived_at: 'desc' },
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
              role: true,
              is_active: true,
            },
          },
          school: true,
        },
      }),
      this.prisma.scholarProfile.count({ where }),
    ]);

    return this.buildPaginatedResult(data, total, page, limit);
  }

  private async listArchivedApplicants(
    query: QueryArchiveDto,
    page: number,
    limit: number,
  ) {
    const where: Prisma.ScholarProfileWhereInput = {
      archived_at: { not: null },
      user: { role: 'APPLICANT' },
    };

    if (query.reason) {
      where.archive_reason = query.reason;
    }

    if (query.search) {
      where.OR = [
        { first_name: { contains: query.search, mode: 'insensitive' } },
        { last_name: { contains: query.search, mode: 'insensitive' } },
        { student_number: { contains: query.search, mode: 'insensitive' } },
        { course_of_study: { contains: query.search, mode: 'insensitive' } },
        { school_name: { contains: query.search, mode: 'insensitive' } },
        { user: { email: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.scholarProfile.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { archived_at: 'desc' },
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
              role: true,
              is_active: true,
            },
          },
          applications: {
            orderBy: { submitted_at: 'desc' },
            select: {
              application_id: true,
              status: true,
              stage: true,
              rejection_reason: true,
              decision_at: true,
              archived_at: true,
            },
          },
        },
      }),
      this.prisma.scholarProfile.count({ where }),
    ]);

    return this.buildPaginatedResult(data, total, page, limit);
  }

  private async listArchivedSchools(
    query: QueryArchiveDto,
    page: number,
    limit: number,
  ) {
    const where: Prisma.SchoolWhereInput = {
      archived_at: { not: null },
    };

    if (query.reason) {
      where.archive_reason = query.reason;
    }

    if (query.search) {
      where.OR = [
        { school_name: { contains: query.search, mode: 'insensitive' } },
        { school_code: { contains: query.search, mode: 'insensitive' } },
        { address: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.school.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { archived_at: 'desc' },
        include: {
          grading_system: true,
          _count: { select: { scholar_profiles: true } },
        },
      }),
      this.prisma.school.count({ where }),
    ]);

    return this.buildPaginatedResult(data, total, page, limit);
  }

  private async listArchivedPrograms(
    query: QueryArchiveDto,
    page: number,
    limit: number,
  ) {
    const where: Prisma.AcademicProgramWhereInput = {
      archived_at: { not: null },
    };

    if (query.reason) {
      where.archive_reason = query.reason;
    }

    if (query.search) {
      where.OR = [
        { program_name: { contains: query.search, mode: 'insensitive' } },
        { program_code: { contains: query.search, mode: 'insensitive' } },
        { category: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      this.prisma.academicProgram.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { archived_at: 'desc' },
      }),
      this.prisma.academicProgram.count({ where }),
    ]);

    return this.buildPaginatedResult(data, total, page, limit);
  }

  async getArchiveSummary() {
    const [
      scholars,
      applicants,
      schools,
      programs,
      graduated,
      failedSecondChance,
      withdrawn,
      terminated,
      rejectedApplicants,
      closedSchools,
      outdatedPrograms,
    ] = await Promise.all([
      this.prisma.scholarProfile.count({
        where: { archived_at: { not: null }, user: { role: 'SCHOLAR' } },
      }),
      this.prisma.scholarProfile.count({
        where: { archived_at: { not: null }, user: { role: 'APPLICANT' } },
      }),
      this.prisma.school.count({ where: { archived_at: { not: null } } }),
      this.prisma.academicProgram.count({
        where: { archived_at: { not: null } },
      }),
      this.prisma.scholarProfile.count({
        where: { archive_reason: 'GRADUATED' },
      }),
      this.prisma.scholarProfile.count({
        where: { archive_reason: 'FAILED_SECOND_CHANCE' },
      }),
      this.prisma.scholarProfile.count({
        where: { archive_reason: 'WITHDRAWN' },
      }),
      this.prisma.scholarProfile.count({
        where: { archive_reason: 'TERMINATED' },
      }),
      this.prisma.scholarProfile.count({
        where: { archive_reason: 'APPLICATION_REJECTED' },
      }),
      this.prisma.school.count({
        where: { archive_reason: 'SCHOOL_CLOSED' },
      }),
      this.prisma.academicProgram.count({
        where: {
          archive_reason: { in: ['PROGRAM_OUTDATED', 'PROGRAM_REMOVED'] },
        },
      }),
    ]);

    return {
      totals: {
        scholars,
        applicants,
        schools,
        programs,
        all: scholars + applicants + schools + programs,
      },
      scholar_reasons: {
        GRADUATED: graduated,
        FAILED_SECOND_CHANCE: failedSecondChance,
        WITHDRAWN: withdrawn,
        TERMINATED: terminated,
      },
      applicant_reasons: {
        APPLICATION_REJECTED: rejectedApplicants,
      },
      school_reasons: {
        SCHOOL_CLOSED: closedSchools,
      },
      program_reasons: {
        OUTDATED_OR_REMOVED: outdatedPrograms,
      },
    };
  }

  // ==========================================
  // SCHOOLS
  // ==========================================

  async archiveSchool(
    adminUserId: number,
    schoolId: number,
    dto: ArchiveRecordDto,
  ) {
    this.assertReasonAllowed(
      dto.archive_reason,
      SCHOOL_ARCHIVE_REASONS,
      'school',
    );

    const school = await this.prisma.school.findUnique({
      where: { school_id: schoolId },
      include: {
        _count: { select: { scholar_profiles: true } },
      },
    });

    if (!school) {
      throw new NotFoundException(`School with ID ${schoolId} not found.`);
    }

    if (school.archived_at) {
      throw new BadRequestException(
        `School '${school.school_name}' is already archived.`,
      );
    }

    const updated = await this.prisma.school.update({
      where: { school_id: schoolId },
      data: {
        archived_at: new Date(),
        archived_by_user_id: adminUserId,
        archive_reason: dto.archive_reason,
        archive_notes: dto.archive_notes?.trim() || null,
        is_active: false,
      },
      include: { grading_system: true },
    });

    await this.auditService.log(
      adminUserId,
      'SCHOOL_ARCHIVED',
      `Archived school '${school.school_name}' (${school.school_code || 'N/A'}). Reason: ${dto.archive_reason}. Scholars linked: ${school._count.scholar_profiles}.`,
    );

    await this.cacheService.delPattern('settings:schools_list:');
    this.eventsGateway.emitToAll('school:updated', updated);

    return {
      message: `School '${school.school_name}' archived successfully.`,
      school: updated,
    };
  }

  async restoreSchool(adminUserId: number, schoolId: number) {
    const school = await this.prisma.school.findUnique({
      where: { school_id: schoolId },
    });

    if (!school) {
      throw new NotFoundException(`School with ID ${schoolId} not found.`);
    }

    if (!school.archived_at) {
      throw new BadRequestException(
        `School '${school.school_name}' is not archived.`,
      );
    }

    const restored = await this.prisma.school.update({
      where: { school_id: schoolId },
      data: {
        archived_at: null,
        archived_by_user_id: null,
        archive_reason: null,
        archive_notes: null,
        is_active: true,
      },
      include: { grading_system: true },
    });

    await this.auditService.log(
      adminUserId,
      'SCHOOL_RESTORED',
      `Restored school '${school.school_name}' (${school.school_code || 'N/A'}) from the archive.`,
    );

    await this.cacheService.delPattern('settings:schools_list:');
    this.eventsGateway.emitToAll('school:updated', restored);

    return {
      message: `School '${school.school_name}' restored successfully.`,
      school: restored,
    };
  }

  // ==========================================
  // PROGRAMS
  // ==========================================

  async archiveProgram(
    adminUserId: number,
    programId: number,
    dto: ArchiveRecordDto,
  ) {
    this.assertReasonAllowed(
      dto.archive_reason,
      PROGRAM_ARCHIVE_REASONS,
      'program',
    );

    const program = await this.prisma.academicProgram.findUnique({
      where: { program_id: programId },
    });

    if (!program) {
      throw new NotFoundException(
        `Academic program with ID ${programId} not found.`,
      );
    }

    if (program.archived_at) {
      throw new BadRequestException(
        `Program '${program.program_name}' is already archived.`,
      );
    }

    const updated = await this.prisma.academicProgram.update({
      where: { program_id: programId },
      data: {
        archived_at: new Date(),
        archived_by_user_id: adminUserId,
        archive_reason: dto.archive_reason,
        archive_notes: dto.archive_notes?.trim() || null,
        is_active: false,
      },
    });

    await this.auditService.log(
      adminUserId,
      'PROGRAM_ARCHIVED',
      `Archived academic program '${program.program_name}' (${program.program_code}). Reason: ${dto.archive_reason}.`,
    );

    await this.cacheService.delPattern('settings:programs:');
    this.eventsGateway.emitToAll('program:updated', updated);

    return {
      message: `Program '${program.program_name}' archived successfully.`,
      program: updated,
    };
  }

  async restoreProgram(adminUserId: number, programId: number) {
    const program = await this.prisma.academicProgram.findUnique({
      where: { program_id: programId },
    });

    if (!program) {
      throw new NotFoundException(
        `Academic program with ID ${programId} not found.`,
      );
    }

    if (!program.archived_at) {
      throw new BadRequestException(
        `Program '${program.program_name}' is not archived.`,
      );
    }

    const restored = await this.prisma.academicProgram.update({
      where: { program_id: programId },
      data: {
        archived_at: null,
        archived_by_user_id: null,
        archive_reason: null,
        archive_notes: null,
        is_active: true,
      },
    });

    await this.auditService.log(
      adminUserId,
      'PROGRAM_RESTORED',
      `Restored academic program '${program.program_name}' (${program.program_code}) from the archive.`,
    );

    await this.cacheService.delPattern('settings:programs:');
    this.eventsGateway.emitToAll('program:updated', restored);

    return {
      message: `Program '${program.program_name}' restored successfully.`,
      program: restored,
    };
  }

  // ==========================================
  // SCHOLARS
  // ==========================================

  async archiveScholar(
    adminUserId: number,
    profileId: number,
    dto: ArchiveRecordDto,
  ) {
    this.assertReasonAllowed(
      dto.archive_reason,
      SCHOLAR_ARCHIVE_REASONS,
      'scholar',
    );

    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: { user: true },
    });

    if (!scholar) {
      throw new NotFoundException(
        `Scholar profile with ID ${profileId} not found.`,
      );
    }

    if (scholar.archived_at) {
      throw new BadRequestException(
        `Scholar '${this.scholarName(scholar)}' is already archived.`,
      );
    }

    const shouldTerminate =
      dto.archive_reason === 'FAILED_SECOND_CHANCE' ||
      dto.archive_reason === 'TERMINATED';

    await this.prisma.$transaction([
      this.prisma.scholarProfile.update({
        where: { profile_id: profileId },
        data: {
          archived_at: new Date(),
          archived_by_user_id: adminUserId,
          archive_reason: dto.archive_reason,
          archive_notes: dto.archive_notes?.trim() || null,
          ...(dto.archive_reason === 'FAILED_SECOND_CHANCE'
            ? { academic_baseline_status: 'DISCONTINUED' }
            : {}),
        },
      }),
      this.prisma.user.update({
        where: { user_id: scholar.user_id },
        data: { is_active: true },
      }),
      ...(shouldTerminate
        ? [
            this.prisma.contract.updateMany({
              where: {
                scholar_profile_id: profileId,
                status: { in: ['SIGNED', 'PENDING'] },
              },
              data: { status: 'TERMINATED' },
            }),
            this.prisma.disbursement.updateMany({
              where: {
                scholar_profile_id: profileId,
                status: { in: ['PENDING', 'AUTHORIZED'] },
              },
              data: {
                status: 'CANCELLED',
                remarks: `Scholarship archived: ${dto.archive_reason}.`,
              },
            }),
          ]
        : []),
    ]);

    const updated = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            role: true,
            is_active: true,
          },
        },
        school: true,
      },
    });

    await this.auditService.log(
      adminUserId,
      'SCHOLAR_ARCHIVED',
      `Archived scholar '${this.scholarName(scholar)}' (Profile #${profileId}). Reason: ${dto.archive_reason}.`,
    );

    await this.cacheService.delPattern('dashboard:');
    this.eventsGateway.emitToStaff('scholar:archived', updated);

    return {
      message: `Scholar '${this.scholarName(scholar)}' archived successfully.`,
      scholar: updated,
    };
  }

  async restoreScholar(adminUserId: number, profileId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: { user: true },
    });

    if (!scholar) {
      throw new NotFoundException(
        `Scholar profile with ID ${profileId} not found.`,
      );
    }

    if (!scholar.archived_at) {
      throw new BadRequestException(
        `Scholar '${this.scholarName(scholar)}' is not archived.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.scholarProfile.update({
        where: { profile_id: profileId },
        data: {
          archived_at: null,
          archived_by_user_id: null,
          archive_reason: null,
          archive_notes: null,
          ...(scholar.academic_baseline_status === 'DISCONTINUED'
            ? { academic_baseline_status: 'ON_PROBATION' }
            : {}),
        },
      });

      await tx.user.update({
        where: { user_id: scholar.user_id },
        data: { is_active: true },
      });

      // Unlock any FLAGGED grade reports whose appeal was not yet approved (e.g. DENIED on 2nd chance exhaustion)
      await tx.gradeReport.updateMany({
        where: {
          scholar_profile_id: profileId,
          status: 'FLAGGED',
          appeal_status: { not: 'APPROVED' },
        },
        data: {
          appeal_status: 'APPROVED',
          appeal_reviewed_at: new Date(),
          appeal_decision_notes:
            'Restored from Archive by Grantor (Extended Probation granted).',
        },
      });

      // Restore latest terminated contract so restored scholar returns to active contractual status
      const latestTerminatedContract = await tx.contract.findFirst({
        where: {
          scholar_profile_id: profileId,
          status: 'TERMINATED',
        },
        orderBy: { contract_id: 'desc' },
      });

      if (latestTerminatedContract) {
        await tx.contract.update({
          where: { contract_id: latestTerminatedContract.contract_id },
          data: { status: 'SIGNED' },
        });
      }
    });

    const restored = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            role: true,
            is_active: true,
          },
        },
        school: true,
      },
    });

    await this.auditService.log(
      adminUserId,
      'SCHOLAR_RESTORED',
      `Restored scholar '${this.scholarName(scholar)}' (Profile #${profileId}) from the archive.`,
    );

    await this.cacheService.delPattern('dashboard:');
    this.eventsGateway.emitToStaff('scholar:restored', restored);
    this.eventsGateway.emitToUser(scholar.user_id, 'scholar:restored', {
      profile_id: profileId,
    });

    if (this.notificationsService) {
      const fullName = this.scholarName(scholar);
      void this.notificationsService.createForRoles([Role.COORDINATOR], {
        title: 'Archived Scholar Restored',
        message: `${fullName} has been restored from the archive by the Grantor and placed on probationary standing.`,
        category: 'academic',
        link: '/CoordinatorActiveScholars',
      });
      void this.notificationsService.notifyUser(scholar.user_id, {
        title: 'Scholarship Restored by Grantor',
        message:
          'The Grantor has reviewed your case and restored your scholarship under probationary standing. Your portal and next-term enrollment are now unlocked.',
        category: 'academic',
        link: '/scholardashboard',
      });
    }

    return {
      message: `Scholar '${this.scholarName(scholar)}' restored successfully.`,
      scholar: restored,
    };
  }

  // ==========================================
  // APPLICANTS
  // ==========================================

  async archiveApplicant(
    adminUserId: number,
    profileId: number,
    dto: ArchiveRecordDto,
  ) {
    this.assertReasonAllowed(
      dto.archive_reason,
      APPLICANT_ARCHIVE_REASONS,
      'applicant',
    );

    const applicant = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: {
        user: true,
        applications: {
          select: { application_id: true, status: true, stage: true },
        },
      },
    });

    if (!applicant) {
      throw new NotFoundException(
        `Applicant profile with ID ${profileId} not found.`,
      );
    }

    if (applicant.archived_at) {
      throw new BadRequestException(
        `Applicant '${this.scholarName(applicant)}' is already archived.`,
      );
    }

    if (
      dto.archive_reason === 'APPLICATION_REJECTED' &&
      !applicant.applications.some((app) => app.status === 'REJECTED')
    ) {
      throw new BadRequestException(
        'Applicant has no rejected application. Use reason OTHER to archive manually.',
      );
    }

    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.scholarProfile.update({
        where: { profile_id: profileId },
        data: {
          archived_at: now,
          archived_by_user_id: adminUserId,
          archive_reason: dto.archive_reason,
          archive_notes: dto.archive_notes?.trim() || null,
        },
      }),
      this.prisma.application.updateMany({
        where: { scholar_profile_id: profileId, archived_at: null },
        data: { archived_at: now },
      }),
    ]);

    const updated = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            role: true,
            is_active: true,
          },
        },
        applications: true,
      },
    });

    await this.auditService.log(
      adminUserId,
      'APPLICANT_ARCHIVED',
      `Archived applicant '${this.scholarName(applicant)}' (Profile #${profileId}). Reason: ${dto.archive_reason}.`,
    );

    await this.cacheService.delPattern('dashboard:');
    this.eventsGateway.emitToStaff('applicant:archived', updated);

    return {
      message: `Applicant '${this.scholarName(applicant)}' archived successfully.`,
      applicant: updated,
    };
  }

  async restoreApplicant(adminUserId: number, profileId: number) {
    const applicant = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: { user: true },
    });

    if (!applicant) {
      throw new NotFoundException(
        `Applicant profile with ID ${profileId} not found.`,
      );
    }

    if (!applicant.archived_at) {
      throw new BadRequestException(
        `Applicant '${this.scholarName(applicant)}' is not archived.`,
      );
    }

    await this.prisma.$transaction([
      this.prisma.scholarProfile.update({
        where: { profile_id: profileId },
        data: {
          archived_at: null,
          archived_by_user_id: null,
          archive_reason: null,
          archive_notes: null,
        },
      }),
      this.prisma.application.updateMany({
        where: { scholar_profile_id: profileId },
        data: { archived_at: null },
      }),
      this.prisma.user.update({
        where: { user_id: applicant.user_id },
        data: { is_active: true },
      }),
    ]);

    const restored = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: profileId },
      include: {
        user: {
          select: {
            user_id: true,
            email: true,
            role: true,
            is_active: true,
          },
        },
        applications: true,
      },
    });

    await this.auditService.log(
      adminUserId,
      'APPLICANT_RESTORED',
      `Restored applicant '${this.scholarName(applicant)}' (Profile #${profileId}) from the archive.`,
    );

    await this.cacheService.delPattern('dashboard:');
    this.eventsGateway.emitToStaff('applicant:restored', restored);

    return {
      message: `Applicant '${this.scholarName(applicant)}' restored successfully.`,
      applicant: restored,
    };
  }

  // ==========================================
  // HELPERS
  // ==========================================

  private assertReasonAllowed(
    reason: ArchiveReason,
    allowed: ArchiveReason[],
    entityLabel: string,
  ) {
    if (!allowed.includes(reason)) {
      throw new BadRequestException(
        `Archive reason '${reason}' is not valid for ${entityLabel}. Allowed: ${allowed.join(', ')}.`,
      );
    }
  }

  private scholarName(profile: {
    first_name: string | null;
    last_name: string | null;
  }) {
    return `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Unnamed';
  }
}
