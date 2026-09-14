import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { BatchUpdateSubjectsDto } from '../dto/batch-update-subjects.dto.js';
import { FreezeBaselineDto } from '../dto/freeze-baseline.dto.js';

@Injectable()
export class CoordinatorBaselineService {
  private readonly logger = new Logger(CoordinatorBaselineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Coordinator: Get all scholars awaiting baseline review / frozen status
  async getCoordinatorPendingBaselines() {
    return this.prisma.scholarProfile.findMany({
      where: {
        academic_baseline_status: {
          in: [
            'PENDING_COORDINATOR_REVIEW',
            'PENDING_PROSPECTUS',
            'PENDING_HISTORICAL_CCG',
            'BASELINE_FROZEN',
          ],
        },
      },
      include: {
        user: { select: { email: true, role: true } },
        school_grading_system: true,
        prospectus: {
          include: {
            document: true,
            frozen_by_employee: {
              select: { first_name: true, last_name: true },
            },
          },
        },
      },
      orderBy: { profile_id: 'desc' },
    });
  }

  // 2. Coordinator: Get full side-by-side audit bundle for a scholar
  async getCoordinatorBaselineReview(scholarProfileId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: scholarProfileId },
      include: {
        user: { select: { email: true, created_at: true } },
        school_grading_system: true,
        prospectus: {
          include: {
            document: true,
            subjects: {
              orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
            },
            frozen_by_employee: true,
          },
        },
        documents: {
          where: {
            document_type: { in: ['PROSPECTUS', 'HISTORICAL_CCG', 'TOR', 'GRADE_SLIP'] },
          },
          orderBy: { uploaded_at: 'desc' },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException(`Scholar profile ID ${scholarProfileId} not found.`);
    }

    const subjects = scholar.prospectus?.subjects || [];
    let totalUnits = 0;
    let creditedUnits = 0;
    let untakenUnits = 0;

    for (const sub of subjects) {
      const u = Number(sub.units) || 0;
      totalUnits += u;
      if (sub.status === 'CREDITED' || sub.status === 'PASSED') {
        creditedUnits += u;
      } else {
        untakenUnits += u;
      }
    }

    return {
      scholar_profile: {
        profile_id: scholar.profile_id,
        student_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
        student_number: scholar.student_number,
        course_of_study: scholar.course_of_study,
        school_name: scholar.school_name,
        current_year_level: scholar.current_year_level,
        email: scholar.user.email,
        academic_baseline_status: scholar.academic_baseline_status,
      },
      school_grading_system: scholar.school_grading_system,
      prospectus: scholar.prospectus,
      documents: scholar.documents,
      metrics: {
        total_subjects: subjects.length,
        total_units: Number(totalUnits.toFixed(1)),
        credited_units: Number(creditedUnits.toFixed(1)),
        remaining_units: Number(untakenUnits.toFixed(1)),
        is_frozen: scholar.prospectus?.is_frozen ?? false,
      },
    };
  }

  // 3. Coordinator updates / adds / adjusts subjects on a prospectus
  async coordinatorUpdateSubjects(
    employeeUserId: number,
    prospectusId: number,
    dto: BatchUpdateSubjectsDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
    });
    if (!prospectus) throw new NotFoundException(`Prospectus ID ${prospectusId} not found.`);

    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectusId },
      data: {
        course_name: dto.course_name || undefined,
        course_code: dto.course_code || undefined,
        curriculum_year: dto.curriculum_year || undefined,
      },
    });

    for (const sub of dto.subjects) {
      if (sub.subject_id) {
        await this.prisma.prospectusSubject.update({
          where: { subject_id: sub.subject_id },
          data: {
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || undefined,
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      } else {
        await this.prisma.prospectusSubject.create({
          data: {
            prospectus_id: prospectusId,
            subject_code: sub.subject_code.trim().toUpperCase(),
            descriptive_title: sub.descriptive_title.trim(),
            units: sub.units,
            year_level: sub.year_level,
            semester: sub.semester,
            prerequisites: sub.prerequisites || [],
            status: sub.status || 'UNTAKEN',
            grade: sub.grade !== undefined ? sub.grade : undefined,
            credited_term: sub.credited_term || undefined,
            remarks: sub.remarks || undefined,
          },
        });
      }
    }

    const updated = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
      include: {
        subjects: {
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
      },
    });

    await this.auditService.log(
      employeeUserId,
      'COORDINATOR_UPDATED_BASELINE_SUBJECTS',
      `Coordinator updated ${dto.subjects.length} subjects on prospectus ID ${prospectusId}.`,
    );

    return {
      message: 'Prospectus subjects updated by coordinator.',
      prospectus: updated,
    };
  }

  // 4. Coordinator: Freeze Baseline (Locks curriculum from further changes)
  async freezeBaseline(
    employeeUserId: number,
    prospectusId: number,
    dto: FreezeBaselineDto,
  ) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
      include: {
        scholar_profile: { include: { user: true } },
        subjects: true,
      },
    });

    if (!prospectus) {
      throw new NotFoundException(`Prospectus ID ${prospectusId} not found.`);
    }

    if (prospectus.is_frozen) {
      throw new BadRequestException('This academic baseline is already frozen.');
    }

    const frozenAt = new Date();

    const updatedProspectus = await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectusId },
      data: {
        is_frozen: true,
        frozen_at: frozenAt,
        frozen_by_employee_id: employee.employee_id,
        status: 'FROZEN',
      },
      include: {
        subjects: {
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
        frozen_by_employee: {
          select: { first_name: true, last_name: true, title: true },
        },
      },
    });

    await this.prisma.scholarProfile.update({
      where: { profile_id: prospectus.scholar_profile_id },
      data: { academic_baseline_status: 'BASELINE_FROZEN' },
    });

    const studentName =
      `${prospectus.scholar_profile.first_name} ${prospectus.scholar_profile.last_name}`.trim();

    await this.auditService.log(
      employeeUserId,
      'BASELINE_FROZEN',
      `Coordinator ${employee.first_name} ${employee.last_name} froze academic baseline for scholar ${studentName} (Prospectus ID: ${prospectusId}). Remarks: ${dto?.remarks || 'None'}`,
    );

    const payload = {
      prospectusId,
      scholarProfileId: prospectus.scholar_profile_id,
      studentName,
      isFrozen: true,
      frozenAt: frozenAt.toISOString(),
      frozenBy: `${employee.first_name} ${employee.last_name}`.trim(),
      academic_baseline_status: 'BASELINE_FROZEN',
    };

    this.eventsGateway.emitToStaff('baseline:frozen', payload);
    if (prospectus.scholar_profile.user_id) {
      this.eventsGateway.emitToUser(
        prospectus.scholar_profile.user_id,
        'baseline:frozen',
        payload,
      );
    }

    return {
      message: `Academic baseline for ${studentName} has been frozen and locked successfully.`,
      prospectus: updatedProspectus,
      academic_baseline_status: 'BASELINE_FROZEN',
    };
  }

  // 5. Coordinator: Unfreeze Baseline (Unlocks if manual revision needed)
  async unfreezeBaseline(employeeUserId: number, prospectusId: number) {
    const employee = await this.prisma.employee.findUnique({
      where: { user_id: employeeUserId },
    });
    if (!employee) throw new NotFoundException('Employee profile not found.');

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { prospectus_id: prospectusId },
      include: { scholar_profile: true },
    });

    if (!prospectus) {
      throw new NotFoundException(`Prospectus ID ${prospectusId} not found.`);
    }

    const updated = await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectusId },
      data: {
        is_frozen: false,
        status: 'PENDING_REVIEW',
      },
    });

    await this.prisma.scholarProfile.update({
      where: { profile_id: prospectus.scholar_profile_id },
      data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
    });

    await this.auditService.log(
      employeeUserId,
      'BASELINE_UNFROZEN',
      `Coordinator ${employee.first_name} ${employee.last_name} unlocked academic baseline for prospectus ID ${prospectusId}.`,
    );

    this.eventsGateway.emitToStaff('baseline:unfrozen', {
      prospectusId,
      scholarProfileId: prospectus.scholar_profile_id,
    });

    return {
      message: 'Academic baseline unlocked for edits.',
      prospectus: updated,
      academic_baseline_status: 'PENDING_COORDINATOR_REVIEW',
    };
  }
}
