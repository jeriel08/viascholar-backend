import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { SelectSchoolDto } from '../dto/select-school.dto.js';
import { BatchUpdateSubjectsDto } from '../dto/batch-update-subjects.dto.js';

@Injectable()
export class ScholarBaselineService {
  private readonly logger = new Logger(ScholarBaselineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly settingsService: SettingsService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Get complete baseline onboarding state for current scholar
  async getScholarBaselineState(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        school_grading_system: true,
        prospectus: {
          include: {
            subjects: {
              orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
            },
            document: true,
            frozen_by_employee: {
              select: { employee_id: true, first_name: true, last_name: true, title: true },
            },
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
      throw new NotFoundException('Scholar profile not found.');
    }

    const subjects = scholar.prospectus?.subjects || [];
    let totalUnits = 0;
    let creditedUnits = 0;
    let untakenUnits = 0;
    let creditedCount = 0;
    let untakenCount = 0;

    for (const sub of subjects) {
      const u = Number(sub.units) || 0;
      totalUnits += u;
      if (sub.status === 'CREDITED' || sub.status === 'PASSED') {
        creditedUnits += u;
        creditedCount++;
      } else {
        untakenUnits += u;
        untakenCount++;
      }
    }

    return {
      profile_id: scholar.profile_id,
      student_name: `${scholar.first_name} ${scholar.last_name}`.trim(),
      student_number: scholar.student_number,
      course_of_study: scholar.course_of_study,
      current_year_level: scholar.current_year_level,
      academic_baseline_status: scholar.academic_baseline_status,
      school_grading_system: scholar.school_grading_system,
      prospectus: scholar.prospectus,
      documents: scholar.documents,
      metrics: {
        total_subjects: subjects.length,
        total_units: Number(totalUnits.toFixed(1)),
        credited_subjects: creditedCount,
        credited_units: Number(creditedUnits.toFixed(1)),
        untaken_subjects: untakenCount,
        remaining_units: Number(untakenUnits.toFixed(1)),
        is_baseline_frozen: scholar.prospectus?.is_frozen ?? false,
      },
    };
  }

  // 2. Scholar selects or proposes school grading system
  async selectOrProposeSchool(userId: number, dto: SelectSchoolDto) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    let targetSchoolId: number;

    if (dto.school_id) {
      const existingSchool = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: dto.school_id },
      });
      if (!existingSchool) {
        throw new NotFoundException(`School grading ID ${dto.school_id} not found.`);
      }
      targetSchoolId = existingSchool.school_id;
    } else if (dto.new_school_name) {
      const allSchools = await this.prisma.schoolGradingSystem.findMany();
      const normalize = (s: string) =>
        s
          .toLowerCase()
          .replace(/\([^)]*\)/g, '')
          .replace(/[^a-z0-9]/g, '')
          .trim();
      const targetNormalized = normalize(dto.new_school_name);

      const existing = allSchools.find(
        (s) =>
          s.school_name.toLowerCase() === dto.new_school_name!.trim().toLowerCase() ||
          normalize(s.school_name) === targetNormalized,
      );

      if (existing) {
        targetSchoolId = existing.school_id;
      } else {
        const newSchool = await this.settingsService.createSchoolGrading(
          userId,
          {
            school_name: dto.new_school_name.trim(),
            grading_scale: dto.grading_scale || 'NUMERIC_4_POINT',
            passing_grade: dto.passing_grade ?? 2.0,
            highest_grade: dto.highest_grade ?? 4.0,
            failing_grade: dto.failing_grade ?? 1.0,
            min_grade: dto.min_grade ?? 1.0,
            max_grade: dto.max_grade ?? 4.0,
            special_codes: dto.special_codes,
            notes: dto.notes,
            is_verified: false,
          },
          'SCHOLAR',
        );
        targetSchoolId = newSchool.school_id;
      }
    } else {
      throw new BadRequestException('Either school_id or new_school_name must be provided.');
    }

    const nextStatus =
      scholar.academic_baseline_status === 'PENDING_SCHOOL_SELECTION'
        ? 'PENDING_PROSPECTUS'
        : scholar.academic_baseline_status;

    const updated = await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: {
        school_id: targetSchoolId,
        academic_baseline_status: nextStatus,
      },
      include: {
        school_grading_system: true,
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SCHOOL_SELECTED',
      `Scholar selected school grading system '${updated.school_grading_system?.school_name}' (ID: ${targetSchoolId}).`,
    );

    this.eventsGateway.emitToUser(userId, 'baseline:school_selected', {
      school_id: targetSchoolId,
      school_name: updated.school_grading_system?.school_name,
      academic_baseline_status: updated.academic_baseline_status,
    });

    return {
      message: 'Institution grading configuration confirmed.',
      scholar_profile: updated,
    };
  }

  // 3. Scholar / Staff updates prospectus subjects before freezing
  async updateProspectusSubjects(
    userId: number,
    dto: BatchUpdateSubjectsDto,
    isStaff = false,
  ) {
    let scholarProfileId: number;

    if (isStaff) {
      throw new BadRequestException('Staff should use coordinatorUpdateSubjects endpoint.');
    } else {
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { user_id: userId },
        include: { prospectus: true },
      });
      if (!scholar) throw new NotFoundException('Scholar profile not found.');
      if (scholar.prospectus?.is_frozen) {
        throw new ForbiddenException('Your academic baseline is frozen and cannot be modified.');
      }
      scholarProfileId = scholar.profile_id;
    }

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
    });

    if (!prospectus) {
      throw new NotFoundException('Scholar prospectus record not found. Please upload a prospectus first.');
    }

    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: prospectus.prospectus_id },
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
            prospectus_id: prospectus.prospectus_id,
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
      where: { prospectus_id: prospectus.prospectus_id },
      include: {
        subjects: {
          orderBy: [{ year_level: 'asc' }, { semester: 'asc' }, { subject_code: 'asc' }],
        },
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBJECTS_UPDATED',
      `Updated ${dto.subjects.length} subjects on prospectus ID ${prospectus.prospectus_id}.`,
    );

    return {
      message: 'Prospectus subjects saved successfully.',
      prospectus: updated,
    };
  }

  // 4. Scholar submits baseline for coordinator freeze review
  async submitForReview(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: { prospectus: { include: { subjects: true } } },
    });

    if (!scholar) throw new NotFoundException('Scholar profile not found.');
    if (!scholar.prospectus) {
      throw new BadRequestException('Please upload your prospectus before submitting for review.');
    }
    if (scholar.prospectus.subjects.length === 0) {
      throw new BadRequestException('No subjects found on prospectus checklist.');
    }

    const updated = await this.prisma.scholarProfile.update({
      where: { profile_id: scholar.profile_id },
      data: { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' },
    });

    await this.prisma.scholarProspectus.update({
      where: { prospectus_id: scholar.prospectus.prospectus_id },
      data: { status: 'PENDING_REVIEW' },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBMITTED_FOR_REVIEW',
      `Scholar ${scholar.first_name} ${scholar.last_name} submitted academic baseline for coordinator freeze review.`,
    );

    const payload = {
      scholarProfileId: scholar.profile_id,
      studentName: `${scholar.first_name} ${scholar.last_name}`.trim(),
      courseOfStudy: scholar.course_of_study,
      schoolName: scholar.school_name,
      subjectsCount: scholar.prospectus.subjects.length,
      submittedAt: new Date().toISOString(),
    };

    this.eventsGateway.emitToStaff('baseline:submitted_for_review', payload);
    this.eventsGateway.emitToUser(userId, 'baseline:submitted_for_review', payload);

    return {
      message: 'Academic baseline submitted for coordinator review.',
      academic_baseline_status: updated.academic_baseline_status,
    };
  }
}
