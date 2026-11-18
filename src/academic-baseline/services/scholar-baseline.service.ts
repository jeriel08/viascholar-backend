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
import { AppCacheService } from '../../common/cache/app-cache.service.js';
import {
  findLatestApprovedShift,
  pruneStalePreShiftSubjects,
} from '../utils/shift-prospectus.util.js';

@Injectable()
export class ScholarBaselineService {
  private readonly logger = new Logger(ScholarBaselineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly settingsService: SettingsService,
    private readonly eventsGateway: EventsGateway,
    private readonly cacheService: AppCacheService,
  ) {}

  // 1. Get complete baseline onboarding state for current scholar
  async getScholarBaselineState(userId: number, forceRefresh = false) {
    const cacheKey = `baseline:scholar:${userId}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const scholar = await this.prisma.scholarProfile.findUnique({
          where: { user_id: userId },
          include: {
            school_grading_system: true,
            prospectus: {
              include: {
                subjects: {
                  orderBy: [
                    { year_level: 'asc' },
                    { semester: 'asc' },
                    { subject_code: 'asc' },
                  ],
                },
                document: true,
                frozen_by_employee: {
                  select: {
                    employee_id: true,
                    first_name: true,
                    last_name: true,
                    title: true,
                  },
                },
              },
            },
            documents: {
              where: {
                document_type: {
                  in: ['PROSPECTUS', 'HISTORICAL_CCG', 'TOR', 'GRADE_SLIP'],
                },
              },
              orderBy: { uploaded_at: 'desc' },
            },
          },
        });

        if (!scholar) {
          throw new NotFoundException('Scholar profile not found.');
        }

        const needsShiftCheck =
          Boolean(scholar.prospectus) ||
          [
            'PENDING_SCHOOL_SELECTION',
            'PENDING_PROSPECTUS',
            'PENDING_HISTORICAL_CCG',
            'PENDING_COORDINATOR_REVIEW',
            'PENDING_SHIFT_PROSPECTUS',
          ].includes(scholar.academic_baseline_status);

        const latestApprovedShift = needsShiftCheck
          ? await findLatestApprovedShift(this.prisma, scholar.profile_id)
          : null;
        const shiftReviewedAt = latestApprovedShift?.reviewed_at
          ? new Date(latestApprovedShift.reviewed_at).getTime()
          : 0;

        // Recover legacy pre-fix shifted accounts OR accidentally submitted old prospectuses
        if (
          latestApprovedShift &&
          [
            'PENDING_SCHOOL_SELECTION',
            'PENDING_PROSPECTUS',
            'PENDING_HISTORICAL_CCG',
            'PENDING_COORDINATOR_REVIEW',
          ].includes(scholar.academic_baseline_status)
        ) {
          const staleProspectus = scholar.prospectus;
          const prospectusDocAt = staleProspectus?.document?.uploaded_at
            ? new Date(staleProspectus.document.uploaded_at).getTime()
            : staleProspectus?.created_at
              ? new Date(staleProspectus.created_at).getTime()
              : 0;
          const hasStaleProspectus = Boolean(
            staleProspectus &&
              shiftReviewedAt > 0 &&
              prospectusDocAt > 0 &&
              prospectusDocAt <= shiftReviewedAt,
          );

          if (scholar.academic_baseline_status === 'PENDING_COORDINATOR_REVIEW') {
            if (hasStaleProspectus && staleProspectus) {
              await this.prisma.scholarProfile.update({
                where: { profile_id: scholar.profile_id },
                data: { academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS' },
              });
              scholar.academic_baseline_status = 'PENDING_SHIFT_PROSPECTUS';
              await this.prisma.scholarProspectus.update({
                where: { prospectus_id: staleProspectus.prospectus_id },
                data: { status: 'DRAFT' },
              });
              staleProspectus.status = 'DRAFT';
            }
          } else {
            await this.prisma.scholarProfile.update({
              where: { profile_id: scholar.profile_id },
              data: { academic_baseline_status: 'PENDING_SHIFT_PROSPECTUS' },
            });
            scholar.academic_baseline_status = 'PENDING_SHIFT_PROSPECTUS';

            if (
              staleProspectus &&
              latestApprovedShift.reviewed_at &&
              new Date(staleProspectus.updated_at).getTime() <=
                new Date(latestApprovedShift.reviewed_at).getTime()
            ) {
              if (
                typeof (this.prisma as any).scholarProspectus?.deleteMany ===
                'function'
              ) {
                await (this.prisma as any).scholarProspectus.deleteMany({
                  where: { scholar_profile_id: scholar.profile_id },
                });
              }
              scholar.prospectus = null;
            }
          }
        }

        const prunedPreShift = await pruneStalePreShiftSubjects(
          this.prisma,
          scholar.prospectus,
          shiftReviewedAt,
        );
        if (prunedPreShift) {
          await this.cacheService.del(`baseline:review:${scholar.profile_id}`);
          await this.cacheService.del(`dashboard:scholar:${userId}`);
        }

        const subjects = scholar.prospectus?.subjects || [];

        if (
          subjects.length > 0 &&
          typeof (this.prisma as any).termEnrollment?.findMany === 'function'
        ) {
          const enrollments =
            (await (this.prisma as any).termEnrollment.findMany({
              where: {
                scholar_profile_id: scholar.profile_id,
                status: { in: ['PENDING_REVIEW', 'APPROVED', 'COMPLETED'] },
              },
              orderBy: { created_at: 'desc' },
            })) || [];

          const normalizeCode = (code: string) =>
            (code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const getBaseCode = (code: string) =>
            normalizeCode(code).replace(/(LAB|LEC|L)$/, '');
          const normalizeTitle = (title: string) =>
            (title || '')
              .toLowerCase()
              .replace(/\b(lab|laboratory|lec|lecture)\b/g, '')
              .replace(/[^a-z0-9]/g, '')
              .trim();

          for (const enr of enrollments) {
            const enrCreatedMs = enr.created_at
              ? new Date(enr.created_at).getTime()
              : 0;
            if (
              shiftReviewedAt > 0 &&
              enrCreatedMs > 0 &&
              enrCreatedMs <= shiftReviewedAt
            ) {
              continue;
            }

            if (
              enr.status === 'COMPLETED' &&
              enr.reviewed_by_employee_id === null &&
              enr.disbursement_id === null &&
              typeof enr.coordinator_notes === 'string' &&
              enr.coordinator_notes.includes(
                'Term concluded with CCG submission.',
              ) &&
              typeof (this.prisma as any).termEnrollment?.update === 'function'
            ) {
              await (this.prisma as any).termEnrollment.update({
                where: { enrollment_id: enr.enrollment_id },
                data: { status: 'PENDING_REVIEW', coordinator_notes: null },
              });
              enr.status = 'PENDING_REVIEW';
              enr.coordinator_notes = null;
            }

            if (enr.status === 'PENDING_REVIEW' || enr.status === 'APPROVED') {
              const enrolledSubs = (enr.enrolled_subjects as any[]) || [];
              for (const sub of enrolledSubs) {
                let matchingSubject = sub.curriculum_subject_id
                  ? subjects.find(
                      (ps: any) =>
                        ps.subject_id === Number(sub.curriculum_subject_id),
                    )
                  : undefined;

                if (!matchingSubject && sub.subject_code) {
                  const normCode = normalizeCode(sub.subject_code);
                  matchingSubject = subjects.find(
                    (ps: any) => normalizeCode(ps.subject_code) === normCode,
                  );
                }

                if (!matchingSubject && sub.subject_code) {
                  const baseCode = getBaseCode(sub.subject_code);
                  if (baseCode) {
                    matchingSubject =
                      subjects.find(
                        (ps: any) =>
                          getBaseCode(ps.subject_code) === baseCode &&
                          ps.status === 'UNTAKEN',
                      ) ||
                      subjects.find(
                        (ps: any) => getBaseCode(ps.subject_code) === baseCode,
                      );
                  }
                }

                if (!matchingSubject && sub.descriptive_title) {
                  const normTitle = normalizeTitle(sub.descriptive_title);
                  if (normTitle.length > 3) {
                    matchingSubject =
                      subjects.find(
                        (ps: any) =>
                          ps.descriptive_title &&
                          normalizeTitle(ps.descriptive_title) === normTitle &&
                          ps.status === 'UNTAKEN',
                      ) ||
                      subjects.find(
                        (ps: any) =>
                          ps.descriptive_title &&
                          normalizeTitle(ps.descriptive_title) === normTitle,
                      );
                  }
                }

                if (matchingSubject && matchingSubject.status === 'UNTAKEN') {
                  const remark = `Enrolled in ${enr.academic_year} ${enr.semester}`;
                  if (
                    typeof (this.prisma as any).prospectusSubject?.update ===
                    'function'
                  ) {
                    await (this.prisma as any).prospectusSubject.update({
                      where: { subject_id: matchingSubject.subject_id },
                      data: {
                        status: 'ENROLLED',
                        remarks: remark,
                      },
                    });
                  }
                  matchingSubject.status = 'ENROLLED';
                  matchingSubject.remarks = remark;
                }
              }
            }
          }
        }

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
      },
      60 * 60 * 1000, // 1 hour TTL
      forceRefresh,
    );
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
        throw new NotFoundException(
          `School grading ID ${dto.school_id} not found.`,
        );
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
          s.school_name.toLowerCase() ===
            dto.new_school_name!.trim().toLowerCase() ||
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
      throw new BadRequestException(
        'Either school_id or new_school_name must be provided.',
      );
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

    await this.cacheService.del(`baseline:scholar:${userId}`);
    await this.cacheService.del(`baseline:review:${scholar.profile_id}`);
    await this.cacheService.del(`dashboard:scholar:${userId}`);

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
      throw new BadRequestException(
        'Staff should use coordinatorUpdateSubjects endpoint.',
      );
    } else {
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { user_id: userId },
        include: { prospectus: true },
      });
      if (!scholar) throw new NotFoundException('Scholar profile not found.');
      if (scholar.prospectus?.is_frozen) {
        throw new ForbiddenException(
          'Your academic baseline is frozen and cannot be modified.',
        );
      }
      scholarProfileId = scholar.profile_id;
    }

    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
    });

    if (!prospectus) {
      throw new NotFoundException(
        'Scholar prospectus record not found. Please upload a prospectus first.',
      );
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
          orderBy: [
            { year_level: 'asc' },
            { semester: 'asc' },
            { subject_code: 'asc' },
          ],
        },
      },
    });

    await this.auditService.log(
      userId,
      'BASELINE_SUBJECTS_UPDATED',
      `Updated ${dto.subjects.length} subjects on prospectus ID ${prospectus.prospectus_id}.`,
    );

    await this.cacheService.del(`baseline:scholar:${userId}`);
    await this.cacheService.del(`baseline:review:${scholarProfileId}`);
    await this.cacheService.del(`dashboard:scholar:${userId}`);

    return {
      message: 'Prospectus subjects saved successfully.',
      prospectus: updated,
    };
  }

  // 4. Scholar submits baseline for coordinator freeze review
  async submitForReview(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        prospectus: {
          include: {
            subjects: true,
            document: true,
          },
        },
      },
    });

    if (!scholar) throw new NotFoundException('Scholar profile not found.');
    if (!scholar.prospectus) {
      throw new BadRequestException(
        'Please upload your prospectus before submitting for review.',
      );
    }
    if (scholar.prospectus.is_frozen) {
      throw new ForbiddenException(
        'Your academic baseline is already frozen.',
      );
    }
    if (scholar.academic_baseline_status === 'PENDING_COORDINATOR_REVIEW') {
      throw new BadRequestException(
        'Your prospectus has already been submitted and is currently under Coordinator review.',
      );
    }
    if (scholar.prospectus.subjects.length === 0) {
      throw new BadRequestException(
        'No subjects found on prospectus checklist.',
      );
    }

    if (
      typeof (this.prisma as any).academicChangeRequest?.findFirst ===
      'function'
    ) {
      const latestApprovedShift = await (
        this.prisma as any
      ).academicChangeRequest.findFirst({
        where: { scholar_profile_id: scholar.profile_id, status: 'APPROVED' },
        orderBy: { reviewed_at: 'desc' },
      });

      if (
        latestApprovedShift &&
        (scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS' ||
          !scholar.prospectus.is_frozen)
      ) {
        const shiftReviewedMs = latestApprovedShift.reviewed_at
          ? new Date(latestApprovedShift.reviewed_at).getTime()
          : 0;
        const docUploadedMs = scholar.prospectus.document?.uploaded_at
          ? new Date(scholar.prospectus.document.uploaded_at).getTime()
          : scholar.prospectus.created_at
            ? new Date(scholar.prospectus.created_at).getTime()
            : 0;

        if (
          (scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS' &&
            !scholar.prospectus.document) ||
          (shiftReviewedMs > 0 &&
            docUploadedMs > 0 &&
            docUploadedMs <= shiftReviewedMs)
        ) {
          throw new BadRequestException(
            'You have not uploaded a new prospectus yet after your approved program shift/transfer. Please upload your new prospectus (with credited grades) before submitting for review.',
          );
        }
      }
    } else if (scholar.academic_baseline_status === 'PENDING_SHIFT_PROSPECTUS' && !scholar.prospectus.document) {
      throw new BadRequestException(
        'Please upload your new prospectus before submitting for review.',
      );
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
    this.eventsGateway.emitToUser(
      userId,
      'baseline:submitted_for_review',
      payload,
    );

    await this.cacheService.del(`baseline:scholar:${userId}`);
    await this.cacheService.del(`baseline:review:${scholar.profile_id}`);
    await this.cacheService.del(`dashboard:scholar:${userId}`);
    await this.cacheService.delPattern('dashboard:coordinator:');
    await this.cacheService.delPattern('dashboard:grantor:');

    return {
      message: 'Academic baseline submitted for coordinator review.',
      academic_baseline_status: updated.academic_baseline_status,
    };
  }

  // 5. Get Scholar's Prospectus & Program History (archived snapshots + legacy fallback)
  async getScholarProspectusHistory(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      select: { profile_id: true },
    });
    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }
    return this.getProspectusHistoryByProfileId(scholar.profile_id);
  }

  async getProspectusHistoryByProfileId(scholarProfileId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { profile_id: scholarProfileId },
      select: {
        profile_id: true,
        course_of_study: true,
        school_name: true,
        academic_baseline_status: true,
      },
    });
    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    let savedRows: Array<any> = [];
    if (
      typeof (this.prisma as any).scholarProspectusHistory?.findMany ===
      'function'
    ) {
      try {
        savedRows = await (
          this.prisma as any
        ).scholarProspectusHistory.findMany({
          where: { scholar_profile_id: scholarProfileId },
          include: {
            document: {
              select: {
                document_id: true,
                file_name: true,
                file_url: true,
                file_type: true,
                uploaded_at: true,
              },
            },
            academic_change_request: {
              select: {
                request_id: true,
                change_type: true,
                requested_course_of_study: true,
                requested_school_name: true,
                effective_academic_year: true,
                effective_semester: true,
                reviewed_at: true,
              },
            },
          },
          orderBy: { archived_at: 'desc' },
        });
      } catch (err: any) {
        if (err?.code !== 'P2021') {
          throw err;
        }
      }
    }

    const mappedSaved: Array<{
      history_id: number;
      source: 'ARCHIVED_SNAPSHOT' | 'RECONSTRUCTED_PRE_SHIFT';
      course_code: string | null;
      course_name: string;
      school_name: string | null;
      curriculum_year: string;
      total_units: number;
      credited_units: number;
      status: string;
      archive_reason: string;
      is_frozen: boolean;
      frozen_at: Date | string | null;
      archived_at: Date | string;
      academic_change_request: {
        request_id: number;
        change_type: string;
        requested_course_of_study: string | null;
        requested_school_name: string | null;
        effective_academic_year: string | null;
        effective_semester: string | null;
        reviewed_at: Date | string | null;
      } | null;
      document: {
        document_id: number;
        file_name: string | null;
        file_url: string;
        file_type: string;
        uploaded_at: Date | string;
      } | null;
      subjects: Array<any>;
    }> = savedRows.map((row) => {
      const subjects = Array.isArray(row.subjects_snapshot)
        ? row.subjects_snapshot
        : [];
      return {
        history_id: row.history_id,
        source: 'ARCHIVED_SNAPSHOT' as const,
        course_code: row.course_code ?? null,
        course_name: row.course_name,
        school_name: row.school_name ?? null,
        curriculum_year: row.curriculum_year,
        total_units: Number(row.total_units ?? 0),
        credited_units: Number(row.credited_units ?? 0),
        status: row.status,
        archive_reason: row.archive_reason,
        is_frozen: Boolean(row.is_frozen),
        frozen_at: row.frozen_at ?? null,
        archived_at: row.archived_at,
        academic_change_request: row.academic_change_request ?? null,
        document: row.document ?? null,
        subjects,
      };
    });

    const coveredChangeRequestIds = new Set(
      savedRows
        .map((r) => r.academic_change_request_id)
        .filter((id): id is number => typeof id === 'number'),
    );
    const coveredDocIds = new Set(
      savedRows
        .map((r) => r.document_id)
        .filter((id): id is number => typeof id === 'number'),
    );

    const reconstructed: typeof mappedSaved = [];
    if (
      typeof (this.prisma as any).academicChangeRequest?.findMany ===
      'function'
    ) {
      const approvedChanges =
        (await (this.prisma as any).academicChangeRequest.findMany({
          where: {
            scholar_profile_id: scholarProfileId,
            status: 'APPROVED',
          },
          orderBy: { reviewed_at: 'desc' },
        })) || [];

      const unarchivedChanges = approvedChanges.filter(
        (c: any) => !coveredChangeRequestIds.has(c.request_id),
      );

      if (unarchivedChanges.length > 0) {
        const [prospectusDocs, gradeReports] = await Promise.all([
          typeof (this.prisma as any).scholarDocument?.findMany === 'function'
            ? this.prisma.scholarDocument.findMany({
                where: {
                  scholar_profile_id: scholarProfileId,
                  document_type: 'PROSPECTUS',
                },
                orderBy: { uploaded_at: 'desc' },
              })
            : Promise.resolve([]),
          typeof (this.prisma as any).gradeReport?.findMany === 'function'
            ? this.prisma.gradeReport.findMany({
                where: { scholar_profile_id: scholarProfileId },
                include: { grade_items: true },
                orderBy: { submitted_at: 'desc' },
              })
            : Promise.resolve([]),
        ]);

        const normCode = (code?: string | null) =>
          (code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

        for (const change of unarchivedChanges) {
          const reviewedMs = change.reviewed_at
            ? new Date(change.reviewed_at).getTime()
            : Number.MAX_SAFE_INTEGER;

          const matchedDoc = prospectusDocs.find((d: any) => {
            if (coveredDocIds.has(d.document_id)) return false;
            const upMs = d.uploaded_at ? new Date(d.uploaded_at).getTime() : 0;
            return upMs <= reviewedMs;
          });
          if (matchedDoc) {
            coveredDocIds.add(matchedDoc.document_id);
          }

          const preShiftReports = gradeReports.filter((gr: any) => {
            const subMs = gr.submitted_at
              ? new Date(gr.submitted_at).getTime()
              : 0;
            return subMs > 0 && subMs <= reviewedMs;
          });

          const gradeByCode = new Map<
            string,
            { grade: number; term: string; raw_status?: string | null }
          >();
          for (const gr of preShiftReports) {
            for (const item of gr.grade_items || []) {
              const key = normCode(item.subject_code);
              if (key && !gradeByCode.has(key)) {
                gradeByCode.set(key, {
                  grade: Number(item.grade),
                  term: `${gr.academic_year} ${gr.semester}`,
                  raw_status: item.raw_status,
                });
              }
            }
          }

          const ext = (matchedDoc?.extracted_data || null) as {
            curriculum_year?: string;
            course_code?: string;
            course_name?: string;
            total_units?: number;
            subjects?: Array<Record<string, any>>;
          } | null;

          const rawSubjects = Array.isArray(ext?.subjects) ? ext.subjects : [];
          const mergedSubjects = rawSubjects.map((s) => {
            const matchedGrade = gradeByCode.get(normCode(s.subject_code));
            const status = matchedGrade
              ? matchedGrade.raw_status === 'FAILED'
                ? 'FAILED'
                : 'PASSED'
              : String(s.status || 'UNTAKEN');
            const grade =
              matchedGrade?.grade ??
              (s.grade != null ? Number(s.grade) : null);

            return {
              subject_code: String(s.subject_code || ''),
              descriptive_title: String(s.descriptive_title || ''),
              units: Number(s.units) || 0,
              year_level: Number(s.year_level) || 1,
              semester: String(s.semester || '1st Semester'),
              status,
              grade,
              credited_term:
                matchedGrade?.term ||
                (s.credited_term ? String(s.credited_term) : null),
              remarks: s.remarks ? String(s.remarks) : null,
              prerequisites: Array.isArray(s.prerequisites)
                ? s.prerequisites.map(String)
                : null,
            };
          });

          const totalUnits =
            ext?.total_units && Number(ext.total_units) > 0
              ? Number(ext.total_units)
              : mergedSubjects.reduce((sum, s) => sum + s.units, 0);
          const creditedUnits = mergedSubjects
            .filter((s) => s.status === 'PASSED' || s.status === 'CREDITED')
            .reduce((sum, s) => sum + s.units, 0);

          reconstructed.push({
            history_id: -change.request_id,
            source: 'RECONSTRUCTED_PRE_SHIFT',
            course_code: ext?.course_code ?? null,
            course_name:
              change.current_course_of_study ||
              ext?.course_name ||
              'Previous Program',
            school_name: change.current_school_name ?? null,
            curriculum_year: ext?.curriculum_year || 'Pre-Shift Curriculum',
            total_units: Number(totalUnits.toFixed(1)),
            credited_units: Number(creditedUnits.toFixed(1)),
            status: 'ARCHIVED',
            archive_reason: change.change_type || 'PROGRAM_SHIFT',
            is_frozen: false,
            frozen_at: null,
            archived_at: change.reviewed_at || change.created_at,
            academic_change_request: {
              request_id: change.request_id,
              change_type: change.change_type,
              requested_course_of_study: change.requested_course_of_study,
              requested_school_name: change.requested_school_name,
              effective_academic_year: change.effective_academic_year,
              effective_semester: change.effective_semester,
              reviewed_at: change.reviewed_at,
            },
            document: matchedDoc
              ? {
                  document_id: matchedDoc.document_id,
                  file_name: matchedDoc.file_name,
                  file_url: matchedDoc.file_url,
                  file_type: matchedDoc.file_type,
                  uploaded_at: matchedDoc.uploaded_at,
                }
              : null,
            subjects: mergedSubjects,
          });
        }
      }
    }

    const history = [...mappedSaved, ...reconstructed].sort(
      (a, b) =>
        new Date(b.archived_at).getTime() - new Date(a.archived_at).getTime(),
    );

    return {
      current_program: {
        course_of_study: scholar.course_of_study,
        school_name: scholar.school_name,
        academic_baseline_status: scholar.academic_baseline_status,
      },
      history,
    };
  }

  // Fast aggregated summary endpoint for Scholar Dashboard
  async getScholarDashboardSummary(userId: number, forceRefresh = false) {
    const cacheKey = `dashboard:scholar:${userId}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const scholar = await this.prisma.scholarProfile.findUnique({
          where: { user_id: userId },
          include: {
            user: {
              select: {
                user_id: true,
                email: true,
                role: true,
                is_active: true,
              },
            },
            school_grading_system: true,
            prospectus: {
              include: {
                subjects: {
                  orderBy: [
                    { year_level: 'asc' },
                    { semester: 'asc' },
                    { subject_code: 'asc' },
                  ],
                },
                frozen_by_employee: {
                  select: {
                    first_name: true,
                    last_name: true,
                    title: true,
                  },
                },
              },
            },
            grade_reports: {
              orderBy: { submitted_at: 'desc' },
              take: 5,
              include: {
                grade_items: true,
              },
            },
            enrollments: {
              orderBy: { created_at: 'desc' },
              take: 3,
            },
            disbursements: {
              orderBy: { disbursement_id: 'desc' },
              take: 5,
            },
            documents: {
              orderBy: { uploaded_at: 'desc' },
              take: 5,
            },
            meetings: {
              where: {
                meeting_date: {
                  gte: new Date(new Date().setHours(0, 0, 0, 0)),
                },
              },
              orderBy: { meeting_date: 'asc' },
              take: 3,
              include: {
                employee: {
                  select: {
                    first_name: true,
                    last_name: true,
                    title: true,
                  },
                },
              },
            },
          },
        });

        if (!scholar) {
          throw new NotFoundException('Scholar profile not found.');
        }

        // Settings for grade threshold
        const systemSettings = await this.prisma.systemSetting.findFirst();
        const threshold = systemSettings?.grade_threshold
          ? Number(systemSettings.grade_threshold)
          : 90.0;

        // 1. Prospectus & Curriculum Metrics
        const subjects = scholar.prospectus?.subjects || [];
        let totalUnits = Number(scholar.prospectus?.total_units) || 0;
        if (totalUnits === 0 && subjects.length > 0) {
          totalUnits = subjects.reduce(
            (acc, s) => acc + (Number(s.units) || 0),
            0,
          );
        }
        const passedSubjects = subjects.filter(
          (s) => s.status === 'PASSED' || s.status === 'CREDITED',
        );
        const passedUnits = passedSubjects.reduce(
          (acc, s) => acc + (Number(s.units) || 0),
          0,
        );
        const curriculumPercentage =
          totalUnits > 0
            ? Math.min(100, Math.round((passedUnits / totalUnits) * 100))
            : 0;

        // 2. GWA Calculation
        let currentGwa = 0;
        const latestGradeReport = scholar.grade_reports[0] || null;
        if (latestGradeReport) {
          currentGwa = Number(latestGradeReport.gpa);
        } else if (passedSubjects.length > 0) {
          const graded = passedSubjects.filter(
            (s) => s.grade != null && !isNaN(Number(s.grade)),
          );
          if (graded.length > 0) {
            const totalWeighted = graded.reduce(
              (acc, s) => acc + Number(s.grade) * (Number(s.units) || 3),
              0,
            );
            const gradedUnits = graded.reduce(
              (acc, s) => acc + (Number(s.units) || 3),
              0,
            );
            currentGwa =
              gradedUnits > 0
                ? Number((totalWeighted / gradedUnits).toFixed(2))
                : Number(graded[0].grade);
          } else {
            currentGwa = threshold;
          }
        } else {
          currentGwa = threshold;
        }

        // 3. Academic Standing Alert & Flag (with self-heal for exhausted 2nd-chance probation)
        const priorResolvedAppeal = latestGradeReport
          ? scholar.grade_reports.some(
              (gr) =>
                gr.report_id !== latestGradeReport.report_id &&
                (gr.appeal_status === 'APPROVED' ||
                  gr.appeal_status === 'DENIED'),
            )
          : scholar.grade_reports.some(
              (gr) =>
                gr.appeal_status === 'APPROVED' ||
                gr.appeal_status === 'DENIED',
            );

        if (
          latestGradeReport &&
          latestGradeReport.status === 'FLAGGED' &&
          (latestGradeReport.appeal_status === 'NONE' ||
            !latestGradeReport.appeal_status) &&
          priorResolvedAppeal
        ) {
          const archivedAt = (scholar as any).archived_at ?? new Date();
          const archiveReason =
            (scholar as any).archive_reason ?? 'FAILED_SECOND_CHANCE';
          const archiveNotes =
            (scholar as any).archive_notes ??
            `Failed 2nd-chance probation during ${latestGradeReport.academic_year} (${latestGradeReport.semester}) with GWA ${Number(latestGradeReport.gpa).toFixed(2)}.`;
          const decisionNotes =
            'Second Chance probation exhausted. Automatic archival triggered due to subsequent academic retention deficiency.';

          if (typeof (this.prisma as any).gradeReport?.update === 'function') {
            await (this.prisma as any).gradeReport.update({
              where: { report_id: latestGradeReport.report_id },
              data: {
                appeal_status: 'DENIED',
                appeal_reviewed_at: archivedAt,
                appeal_decision_notes: decisionNotes,
              },
            });
          }
          if (
            typeof (this.prisma as any).scholarProfile?.update === 'function'
          ) {
            await (this.prisma as any).scholarProfile.update({
              where: { profile_id: scholar.profile_id },
              data: {
                academic_baseline_status: 'DISCONTINUED',
                archived_at: archivedAt,
                archive_reason: archiveReason,
                archive_notes: archiveNotes,
              },
            });
          }
          if (typeof (this.prisma as any).contract?.updateMany === 'function') {
            await (this.prisma as any).contract.updateMany({
              where: {
                scholar_profile_id: scholar.profile_id,
                status: { in: ['SIGNED', 'PENDING'] },
              },
              data: { status: 'TERMINATED' },
            });
          }
          if (
            typeof (this.prisma as any).disbursement?.updateMany === 'function'
          ) {
            await (this.prisma as any).disbursement.updateMany({
              where: {
                scholar_profile_id: scholar.profile_id,
                status: { in: ['PENDING', 'AUTHORIZED'] },
              },
              data: {
                status: 'CANCELLED',
                remarks: `Scholarship archived: Failed 2nd-chance probation for ${latestGradeReport.academic_year} ${latestGradeReport.semester}.`,
              },
            });
          }

          latestGradeReport.appeal_status = 'DENIED';
          latestGradeReport.appeal_decision_notes = decisionNotes;
          (scholar as any).academic_baseline_status = 'DISCONTINUED';
          (scholar as any).archived_at = archivedAt;
          (scholar as any).archive_reason = archiveReason;
          (scholar as any).archive_notes = archiveNotes;
        }

        const isDiscontinued =
          scholar.academic_baseline_status === 'DISCONTINUED' ||
          Boolean((scholar as any).archived_at) ||
          latestGradeReport?.appeal_status === 'DENIED';
        const isOnProbation =
          !isDiscontinued &&
          (scholar.academic_baseline_status === 'ON_PROBATION' ||
            scholar.grade_reports.some(
              (gr) => gr.appeal_status === 'APPROVED',
            ));
        const hasPendingAppeal =
          latestGradeReport?.appeal_status === 'PENDING_GRANTOR';
        const isAppealDenied = latestGradeReport?.appeal_status === 'DENIED';
        const isFlagged =
          latestGradeReport &&
          (!latestGradeReport.is_eligible ||
            latestGradeReport.status === 'FLAGGED');

        let standingType:
          | 'GOOD_STANDING'
          | 'PROBATION'
          | 'ACTION_REQUIRED'
          | 'PENDING_REVIEW'
          | 'DISCONTINUED' = 'GOOD_STANDING';
        if (isDiscontinued) {
          standingType = 'DISCONTINUED';
        } else if (isOnProbation) {
          standingType = 'PROBATION';
        } else if (hasPendingAppeal) {
          standingType = 'PENDING_REVIEW';
        } else if (isFlagged || isAppealDenied) {
          standingType = 'ACTION_REQUIRED';
        }

        const [grantorUser, coordinatorUser] =
          typeof (this.prisma as any).user?.findFirst === 'function'
            ? await Promise.all([
                (this.prisma as any).user.findFirst({
                  where: { role: 'GRANTOR', is_active: true },
                  orderBy: { user_id: 'asc' },
                  select: { email: true },
                }),
                (this.prisma as any).user.findFirst({
                  where: { role: 'COORDINATOR', is_active: true },
                  orderBy: { user_id: 'asc' },
                  select: { email: true },
                }),
              ])
            : [null, null];

        // 4. Term Enrollment
        const latestEnrollment = scholar.enrollments[0] || null;

        // 5. Disbursements
        const totalDisbursedAmount = scholar.disbursements
          .filter(
            (d) =>
              d.status === 'CLAIMED' ||
              d.status === 'SETTLED' ||
              d.status === 'RELEASED',
          )
          .reduce((acc, d) => acc + Number(d.amount), 0);
        const pendingOrCount = scholar.disbursements.filter(
          (d) =>
            (d.status === 'CLAIMED' || d.status === 'RELEASED') &&
            !d.or_document_id,
        ).length;

        // 6. Unread Messages & Active Conversation
        const conversation = await this.prisma.conversation.findFirst({
          where: { scholar_user_id: userId },
          include: {
            coordinator: {
              include: {
                employee: {
                  select: {
                    first_name: true,
                    last_name: true,
                    title: true,
                  },
                },
              },
            },
            messages: {
              orderBy: { sent_at: 'desc' },
              take: 5,
            },
          },
        });

        const unreadMessagesCount = conversation
          ? await this.prisma.message.count({
              where: {
                conversation_id: conversation.conversation_id,
                sender_user_id: { not: userId },
                is_read: false,
              },
            })
          : 0;

        // 7. Pinned Forum Announcements
        const announcements = await this.prisma.forumPost.findMany({
          where: {
            OR: [{ is_pinned: true }, { category: 'ANNOUNCEMENT' }],
          },
          orderBy: { created_at: 'desc' },
          take: 3,
          include: {
            author: {
              select: {
                email: true,
                role: true,
                employee: {
                  select: {
                    first_name: true,
                    last_name: true,
                    title: true,
                  },
                },
              },
            },
          },
        });

        return {
          profile: {
            profile_id: scholar.profile_id,
            user_id: scholar.user_id,
            first_name: scholar.first_name,
            last_name: scholar.last_name,
            email: scholar.user.email,
            phone_number: scholar.phone_number,
            student_number: scholar.student_number,
            school_name:
              scholar.school_name || scholar.school_grading_system?.school_name,
            course_of_study: scholar.course_of_study,
            current_year_level: scholar.current_year_level || 1,
            academic_baseline_status: scholar.academic_baseline_status,
            archived_at: (scholar as any).archived_at ?? null,
            archive_reason: (scholar as any).archive_reason ?? null,
            archive_notes: (scholar as any).archive_notes ?? null,
            avatar_url: scholar.avatar_url,
            banner_url: scholar.banner_url,
          },
          school_grading_system: scholar.school_grading_system,
          academic_standing: {
            standing_type: standingType,
            gwa: Number(currentGwa.toFixed(2)),
            threshold: Number(threshold.toFixed(2)),
            is_on_probation: isOnProbation,
            is_discontinued: isDiscontinued,
            second_chance_exhausted:
              Boolean(priorResolvedAppeal) ||
              (scholar as any).archive_reason === 'FAILED_SECOND_CHANCE',
            is_flagged: Boolean(isFlagged),
            has_pending_appeal: Boolean(hasPendingAppeal),
            grantor_email: grantorUser?.email || 'grantor@viascholar.com',
            coordinator_email:
              coordinatorUser?.email || 'coordinator@viascholar.com',
            latest_report: latestGradeReport
              ? {
                  report_id: latestGradeReport.report_id,
                  academic_year: latestGradeReport.academic_year,
                  semester: latestGradeReport.semester,
                  gpa: Number(latestGradeReport.gpa),
                  status: latestGradeReport.status,
                  evaluation_flag: latestGradeReport.evaluation_flag,
                  appeal_status: latestGradeReport.appeal_status,
                  appeal_notes: latestGradeReport.appeal_notes,
                  appeal_decision_notes:
                    latestGradeReport.appeal_decision_notes,
                }
              : null,
          },
          curriculum: {
            total_units: Number(totalUnits.toFixed(1)),
            passed_units: Number(passedUnits.toFixed(1)),
            percentage: curriculumPercentage,
            total_subjects: subjects.length,
            passed_subjects_count: passedSubjects.length,
            is_frozen: scholar.prospectus?.is_frozen || false,
            prospectus_status: scholar.prospectus?.status || 'DRAFT',
          },
          latest_enrollment: latestEnrollment
            ? {
                enrollment_id: latestEnrollment.enrollment_id,
                academic_year: latestEnrollment.academic_year,
                semester: latestEnrollment.semester,
                year_level: latestEnrollment.year_level,
                status: latestEnrollment.status,
                total_units: Number(latestEnrollment.total_units),
                total_assessment: Number(latestEnrollment.total_assessment),
                enrolled_subjects: latestEnrollment.enrolled_subjects,
                audit_flags: latestEnrollment.audit_flags,
                cor_document_id: latestEnrollment.cor_document_id,
                soa_document_id: latestEnrollment.soa_document_id,
                coordinator_notes: latestEnrollment.coordinator_notes,
                created_at: latestEnrollment.created_at,
              }
            : null,
          disbursements: {
            latest: scholar.disbursements[0]
              ? {
                  disbursement_id: scholar.disbursements[0].disbursement_id,
                  academic_year: scholar.disbursements[0].academic_year,
                  semester: scholar.disbursements[0].semester,
                  amount: Number(scholar.disbursements[0].amount),
                  status: scholar.disbursements[0].status,
                  date_issued: scholar.disbursements[0].date_issued,
                  date_claimed: scholar.disbursements[0].date_claimed,
                  voucher_number: scholar.disbursements[0].voucher_number,
                  check_number: scholar.disbursements[0].check_number,
                  or_number: scholar.disbursements[0].or_number,
                  or_document_id: scholar.disbursements[0].or_document_id,
                }
              : null,
            history: scholar.disbursements.map((d) => ({
              disbursement_id: d.disbursement_id,
              academic_year: d.academic_year,
              semester: d.semester,
              amount: Number(d.amount),
              status: d.status,
              date_claimed: d.date_claimed,
              date_issued: d.date_issued,
              or_document_id: d.or_document_id,
            })),
            total_disbursed_amount: totalDisbursedAmount,
            pending_or_count: pendingOrCount,
          },
          communication: {
            unread_messages_count: unreadMessagesCount,
            coordinator: conversation?.coordinator?.employee
              ? {
                  name: `${conversation.coordinator.employee.first_name} ${conversation.coordinator.employee.last_name}`.trim(),
                  title:
                    conversation.coordinator.employee.title ||
                    'Scholarship Coordinator',
                }
              : null,
            recent_messages: (conversation?.messages || []).map((m) => ({
              message_id: m.message_id,
              sender_user_id: m.sender_user_id,
              message_text: m.message_text,
              message_type: m.message_type,
              sent_at: m.sent_at,
              is_read: m.is_read,
            })),
          },
          upcoming_meetings: scholar.meetings.map((m) => ({
            meeting_id: m.meeting_id,
            title: m.title,
            meeting_date: m.meeting_date,
            meeting_time: m.meeting_time,
            meeting_link: m.meeting_link,
            status: m.status,
            coordinator_name: m.employee
              ? `${m.employee.first_name} ${m.employee.last_name}`
              : 'Coordinator',
          })),
          announcements: announcements.map((a) => ({
            post_id: a.post_id,
            title: a.title,
            content: a.content,
            category: a.category,
            is_pinned: a.is_pinned,
            created_at: a.created_at,
            author_name: a.author.employee
              ? `${a.author.employee.first_name} ${a.author.employee.last_name}`
              : 'ViaScholar Staff',
          })),
        };
      },
      60 * 1000,
      forceRefresh,
    );
  }
}
