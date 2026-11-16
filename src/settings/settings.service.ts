import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { CreateSchoolGradingDto } from './dto/create-school-grading.dto.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { UpdateAcademicTermDto } from './dto/update-academic-term.dto.js';
import { UpdateSchoolGradingDto } from './dto/update-school-grading.dto.js';
import { CreateAcademicProgramDto } from './dto/create-program.dto.js';
import { UpdateAcademicProgramDto } from './dto/update-program.dto.js';
import { CreateSchoolDto } from './dto/create-school.dto.js';
import { UpdateSchoolDto } from './dto/update-school.dto.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';
import {
  academicYearsMatchForTerm,
  normalizeAcademicYear,
  normalizeSemester,
} from '../documents/utils/academic-term.util.js';

export interface ResolvedAcademicTermStatus {
  ay_rollover_month: number;
  strict_active_term_policy: boolean;
  manual_academic_year: string | null;
  manual_semester: string | null;
  manual_override_expires_at: string | null;
  is_manual_override_active: boolean;
  is_manual_override_expired: boolean;
  effective_academic_year: string;
  effective_semester: string;
  auto_academic_year: string;
  auto_semester: string;
  valid_academic_years: string[];
  in_transition_window: boolean;
  updated_at?: string;
}

export function resolveActiveAcademicTerm(
  settings?: {
    ay_rollover_month?: number | null;
    strict_active_term_policy?: boolean | null;
    manual_academic_year?: string | null;
    manual_semester?: string | null;
    manual_override_expires_at?: Date | string | null;
    updated_at?: Date | string | null;
  } | null,
  now: Date = new Date(),
): ResolvedAcademicTermStatus {
  const rawRollover = Number(settings?.ay_rollover_month ?? 7);
  const rolloverMonth =
    Number.isFinite(rawRollover) && rawRollover >= 1 && rawRollover <= 12
      ? Math.floor(rawRollover)
      : 7;
  const strictPolicy = settings?.strict_active_term_policy ?? true;

  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const autoStartYear = month >= rolloverMonth ? year : year - 1;
  const autoAcademicYear = `${autoStartYear}-${autoStartYear + 1}`;

  let autoSemester = '2nd Semester';
  if (month >= rolloverMonth) {
    autoSemester = '1st Semester';
  } else if (
    (rolloverMonth > 6 && month >= 6) ||
    (rolloverMonth <= 6 && month === rolloverMonth - 1)
  ) {
    autoSemester = 'Summer';
  }

  const manualAyRaw = settings?.manual_academic_year?.trim() || null;
  const manualAy = manualAyRaw
    ? normalizeAcademicYear(manualAyRaw) || manualAyRaw
    : null;
  const manualSem = settings?.manual_semester?.trim()
    ? normalizeSemester(settings.manual_semester)
    : null;

  const expiryDate = settings?.manual_override_expires_at
    ? new Date(settings.manual_override_expires_at)
    : null;
  const hasValidExpiry = Boolean(
    expiryDate && !Number.isNaN(expiryDate.getTime()),
  );
  const todayUtcMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const expiryUtcMs =
    hasValidExpiry && expiryDate
      ? Date.UTC(
          expiryDate.getUTCFullYear(),
          expiryDate.getUTCMonth(),
          expiryDate.getUTCDate(),
        )
      : null;

  const isManualOverrideExpired = Boolean(
    manualAy && expiryUtcMs !== null && todayUtcMs > expiryUtcMs,
  );
  const isManualOverrideActive = Boolean(manualAy && !isManualOverrideExpired);

  const effectiveAcademicYear = isManualOverrideActive
    ? (manualAy as string)
    : autoAcademicYear;
  const effectiveSemester =
    isManualOverrideActive && manualSem ? manualSem : autoSemester;

  // Transition window: 1-2 months before rollover (e.g. May-Jun for July rollover)
  // allows early next-AY registration at early-calendar universities without falsely allowing past AYs.
  const monthsBeforeRollover = month < rolloverMonth ? rolloverMonth - month : 99;
  const inTransitionWindow =
    !isManualOverrideActive && monthsBeforeRollover >= 1 && monthsBeforeRollover <= 2;

  const validYears = [effectiveAcademicYear];
  if (inTransitionWindow) {
    validYears.push(`${autoStartYear + 1}-${autoStartYear + 2}`);
  }

  return {
    ay_rollover_month: rolloverMonth,
    strict_active_term_policy: strictPolicy,
    manual_academic_year: manualAy,
    manual_semester: manualSem,
    manual_override_expires_at:
      hasValidExpiry && expiryDate
        ? expiryDate.toISOString().slice(0, 10)
        : null,
    is_manual_override_active: isManualOverrideActive,
    is_manual_override_expired: isManualOverrideExpired,
    effective_academic_year: effectiveAcademicYear,
    effective_semester: effectiveSemester,
    auto_academic_year: autoAcademicYear,
    auto_semester: autoSemester,
    valid_academic_years: validYears,
    in_transition_window: inTransitionWindow,
    ...(settings?.updated_at
      ? {
          updated_at:
            settings.updated_at instanceof Date
              ? settings.updated_at.toISOString()
              : String(settings.updated_at),
        }
      : {}),
  };
}

export function validateEnrollmentTermAgainstPolicy(
  docAcademicYear: string | null | undefined,
  docSemester: string | null | undefined,
  resolved: ResolvedAcademicTermStatus,
): { allowed: true } | { allowed: false; reason: string } {
  if (!resolved.strict_active_term_policy) {
    return { allowed: true };
  }

  const rawAy = docAcademicYear?.trim();
  if (!rawAy) {
    return { allowed: true };
  }

  const normDocAy = normalizeAcademicYear(rawAy) || rawAy;
  const normDocSem = docSemester ? normalizeSemester(docSemester) : '';

  const matchesValidWindow = resolved.valid_academic_years.some((validAy) => {
    if (normDocAy === validAy) return true;
    return academicYearsMatchForTerm(
      normDocAy,
      validAy,
      normDocSem || resolved.effective_semester,
    );
  });

  if (matchesValidWindow) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Outdated or off-cycle enrollment document: This document is for AY ${normDocAy}, while the current active academic year is AY ${resolved.effective_academic_year} (${resolved.effective_semester}). Please upload your current-term document or ask a Coordinator/Grantor if multi-year testing mode should be enabled.`,
  };
}

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private eventsGateway: EventsGateway,
    private cacheService: AppCacheService,
  ) {}

  // Automatically initialize default settings (90.00 threshold) on startup
  async onModuleInit() {
    const existing = await this.prisma.systemSetting.findFirst();
    if (!existing) {
      await this.prisma.systemSetting.create({
        data: { grade_threshold: 90.0 },
      });
      console.log('⚡ Initialized default Global Grade Threshold to 90.00%');
    }
  }

  // 1. Get Global Settings
  async getSettings(forceRefresh = false) {
    return this.cacheService.wrap(
      'settings:global',
      async () => {
        let settings = await this.prisma.systemSetting.findFirst();
        if (!settings) {
          settings = await this.prisma.systemSetting.create({
            data: { grade_threshold: 90.0 },
          });
        }
        return settings;
      },
      5 * 60 * 1000,
      forceRefresh,
    );
  }

  // 2. Update Global Settings (Admin / Grantor)
  async updateSettings(userId: number, dto: UpdateSettingsDto) {
    const settings = await this.getSettings(true);

    const updated = await this.prisma.systemSetting.update({
      where: { setting_id: settings.setting_id },
      data: {
        grade_threshold: dto.grade_threshold,
        updated_by_user_id: userId,
      },
    });

    await this.auditService.log(
      userId,
      'SETTINGS_UPDATED',
      `Updated global grade retention threshold to ${dto.grade_threshold}%`,
    );

    // Invalidate cached global settings and dependent dashboards
    await this.cacheService.del('settings:global');
    await this.cacheService.delPattern('dashboard:');

    this.eventsGateway.emitToStaff('settings:updated', updated);
    this.eventsGateway.emitToAll('settings:updated', updated);

    return updated;
  }

  // 2b. Resolve automatic active academic term & policy status
  async getAcademicTermStatus(
    forceRefresh = false,
    now: Date = new Date(),
  ): Promise<ResolvedAcademicTermStatus> {
    const settings = await this.getSettings(forceRefresh);
    return resolveActiveAcademicTerm(settings, now);
  }

  // 2c. Update academic term calendar & strict policy (Admin, Grantor, or Coordinator)
  async updateAcademicTermSettings(userId: number, dto: UpdateAcademicTermDto) {
    if (dto.manual_academic_year) {
      const parts = dto.manual_academic_year.split('-').map(Number);
      if (parts.length !== 2 || parts[1] !== parts[0] + 1) {
        throw new BadRequestException(
          'manual_academic_year end year must immediately follow start year (e.g. 2026-2027).',
        );
      }
    }

    const settings = await this.getSettings(true);
    const updateData: Record<string, any> = {
      updated_by_user_id: userId,
    };

    if (dto.ay_rollover_month !== undefined) {
      updateData.ay_rollover_month = dto.ay_rollover_month;
    }
    if (dto.strict_active_term_policy !== undefined) {
      updateData.strict_active_term_policy = dto.strict_active_term_policy;
    }
    if (dto.manual_academic_year !== undefined) {
      updateData.manual_academic_year = dto.manual_academic_year?.trim() || null;
      if (!updateData.manual_academic_year) {
        updateData.manual_semester = null;
        updateData.manual_override_expires_at = null;
      }
    }
    if (dto.manual_semester !== undefined && updateData.manual_academic_year !== null) {
      updateData.manual_semester = dto.manual_semester?.trim() || null;
    }
    if (
      dto.manual_override_expires_at !== undefined &&
      updateData.manual_academic_year !== null
    ) {
      updateData.manual_override_expires_at = dto.manual_override_expires_at?.trim()
        ? new Date(dto.manual_override_expires_at.trim())
        : null;
    }

    const updated = await this.prisma.systemSetting.update({
      where: { setting_id: settings.setting_id },
      data: updateData,
    });

    const resolved = resolveActiveAcademicTerm(updated);

    await this.auditService.log(
      userId,
      'ACADEMIC_TERM_SETTINGS_UPDATED',
      `Updated academic term policy: Active=${resolved.effective_academic_year} (${resolved.effective_semester}), Rollover Month=${resolved.ay_rollover_month}, Strict Policy=${resolved.strict_active_term_policy ? 'ON' : 'OFF'}`,
    );

    await this.cacheService.del('settings:global');
    await this.cacheService.delPattern('dashboard:');

    this.eventsGateway.emitToStaff('settings:updated', updated);
    this.eventsGateway.emitToAll('settings:academic_term_updated', resolved);

    return resolved;
  }

  // 3. Create School Grading Scale (Staff creates verified, Scholar creates unverified pending coordinator review)
  async createSchoolGrading(
    userId: number,
    dto: CreateSchoolGradingDto,
    userRole?: string,
  ) {
    const existing = await this.prisma.schoolGradingSystem.findUnique({
      where: { school_name: dto.school_name },
    });

    if (existing) {
      throw new ConflictException(
        `School '${dto.school_name}' already exists.`,
      );
    }

    const isStudent = userRole === 'APPLICANT' || userRole === 'SCHOLAR';
    const isVerified = isStudent
      ? (dto.is_verified ?? false)
      : (dto.is_verified ?? true);

    let verifiedByEmployeeId: number | undefined = undefined;
    if (!isStudent) {
      const emp = await this.prisma.employee.findUnique({
        where: { user_id: userId },
      });
      if (emp) {
        verifiedByEmployeeId = emp.employee_id;
      }
    }

    const school = await this.prisma.schoolGradingSystem.create({
      data: {
        school_name: dto.school_name,
        grading_scale: dto.grading_scale,
        passing_grade: dto.passing_grade,
        highest_grade: dto.highest_grade,
        failing_grade: dto.failing_grade,
        min_grade: dto.min_grade,
        max_grade: dto.max_grade,
        special_codes: dto.special_codes,
        notes: dto.notes,
        is_verified: isVerified,
        submitted_by_user_id: userId,
        verified_by_employee_id: verifiedByEmployeeId,
      },
    });

    await this.auditService.log(
      userId,
      isVerified
        ? 'SCHOOL_GRADING_CREATED'
        : 'SCHOOL_GRADING_SUBMITTED_BY_STUDENT',
      `${isVerified ? 'Configured' : 'Proposed'} grading system for school: ${dto.school_name}`,
    );

    this.eventsGateway.emitToStaff('school_grading:created', school);

    await this.cacheService.delPattern('settings:schools:');
    await this.cacheService.delPattern('dashboard:');

    return school;
  }

  // 4. Get All School Grading Scales (Optional query for verifiedOnly)
  async getSchoolGradings(verifiedOnly?: boolean, forceRefresh = false) {
    const cacheKey = `settings:schools:${verifiedOnly ? 'verified' : 'all'}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        return this.prisma.schoolGradingSystem.findMany({
          where: verifiedOnly ? { is_verified: true } : undefined,
          orderBy: { school_name: 'asc' },
          include: {
            submitted_by_user: {
              select: { user_id: true, email: true, role: true },
            },
            verified_by_employee: {
              select: { employee_id: true, first_name: true, last_name: true },
            },
          },
        });
      },
      5 * 60 * 1000,
      forceRefresh,
    );
  }

  // 4b. Coordinator / Staff Verifies School Grading Scale
  async verifySchoolGrading(userId: number, schoolId: number) {
    const school = await this.prisma.schoolGradingSystem.findUnique({
      where: { school_id: schoolId },
    });

    if (!school) {
      throw new NotFoundException(`School with ID ${schoolId} not found.`);
    }

    const employee = await this.prisma.employee.findUnique({
      where: { user_id: userId },
    });

    const updated = await this.prisma.schoolGradingSystem.update({
      where: { school_id: schoolId },
      data: {
        is_verified: true,
        verified_by_employee_id: employee?.employee_id,
      },
      include: {
        verified_by_employee: true,
      },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_GRADING_VERIFIED',
      `Coordinator verified grading scale for school: ${school.school_name}`,
    );

    await this.cacheService.delPattern('settings:schools:');
    await this.cacheService.delPattern('dashboard:');

    this.eventsGateway.emitToStaff('school_grading:verified', updated);
    this.eventsGateway.emitToAll('school_grading:verified', updated);

    return updated;
  }

  // 5. Delete School Grading Configuration
  async deleteSchoolGrading(userId: number, schoolId: number) {
    const school = await this.prisma.schoolGradingSystem.findUnique({
      where: { school_id: schoolId },
    });

    if (!school) {
      throw new NotFoundException(`School with ID ${schoolId} not found.`);
    }

    await this.prisma.schoolGradingSystem.delete({
      where: { school_id: schoolId },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_GRADING_DELETED',
      `Deleted grading system for school: ${school.school_name}`,
    );

    await this.cacheService.delPattern('settings:schools:');
    await this.cacheService.delPattern('dashboard:');

    this.eventsGateway.emitToStaff('school_grading:deleted', {
      school_id: schoolId,
      schoolId,
      schoolName: school.school_name,
    });

    return {
      message: `School grading system '${school.school_name}' removed.`,
    };
  }

  // 6. Update School Grading Configuration
  async updateSchoolGrading(
    userId: number,
    schoolId: number,
    dto: UpdateSchoolGradingDto,
  ) {
    const school = await this.prisma.schoolGradingSystem.findUnique({
      where: { school_id: schoolId },
    });

    if (!school) {
      throw new NotFoundException(
        `School grading configuration with ID ${schoolId} not found.`,
      );
    }

    const updated = await this.prisma.schoolGradingSystem.update({
      where: { school_id: schoolId },
      data: { ...dto },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_GRADING_UPDATED',
      `Updated grading system for school: ${school.school_name}`,
    );

    await this.cacheService.delPattern('settings:schools:');
    await this.cacheService.delPattern('dashboard:');

    this.eventsGateway.emitToStaff('school_grading:updated', updated);

    return updated;
  }

  /**
   * Reusable utility to evaluate student grades against school configurations.
   * Handles numeric grades, UM decimal codes (e.g. 9.0, 7.1, 7.2), and alphanumeric marks (PSD, TWE, INC, DRP).
   */
  evaluateStudentGrade(grade: number | string, schoolConfig: any) {
    const rawGradeStr = String(grade ?? '').trim();
    const specialCodes =
      (schoolConfig?.special_codes as Record<string, string>) || {};

    // 1. Evaluate Special Status Codes first (checking exact match, case-insensitive, or fixed float)
    const numGrade = Number(grade);
    const isNum = !isNaN(numGrade) && rawGradeStr !== '';
    const gradeKeyFormatted = isNum ? numGrade.toFixed(1) : rawGradeStr;

    // Search for code match in special_codes (e.g. "9.0", "9", "7.1", "PSD", "TWE", "INC")
    let matchedStatus: string | undefined = undefined;
    for (const [codeKey, statusVal] of Object.entries(specialCodes)) {
      const cleanKey = String(codeKey).trim().toUpperCase();
      if (
        cleanKey === rawGradeStr.toUpperCase() ||
        (isNum && cleanKey === gradeKeyFormatted) ||
        (isNum && cleanKey === String(numGrade))
      ) {
        matchedStatus = String(statusVal).trim().toUpperCase();
        break;
      }
    }

    if (matchedStatus) {
      // Administrative Hold / Requirements Hold (check first before failure words)
      const pendingKeywords = [
        'LACKING_REQUIREMENTS',
        'LACKING_PAYMENT',
        'NOT_FULLY_PAID',
        'INCOMPLETE',
        'INC',
        'LEAVE_OF_ABSENCE',
        'LOA',
        'ON_HOLD',
        'PENDING',
        'LACKING PAYMENT',
        'LACKING REQUIREMENTS',
      ];
      if (
        pendingKeywords.includes(matchedStatus) ||
        matchedStatus.includes('LACKING') ||
        matchedStatus.includes('INCOMPLETE') ||
        matchedStatus.includes('PAYMENT') ||
        matchedStatus.includes('REQUIREMENT') ||
        matchedStatus.includes('HOLD')
      ) {
        return {
          isPassing: false,
          flag: 'PENDING_REQUIREMENTS',
          statusLabel: matchedStatus,
        };
      }

      // Non-numerical Passing / Credited
      const passedKeywords = [
        'PASSED',
        'PASS',
        'PSD',
        'P',
        'CREDITED',
        'SATISFACTORY',
        'S',
      ];
      if (
        passedKeywords.includes(matchedStatus) ||
        matchedStatus.startsWith('PASS') ||
        matchedStatus === 'P' ||
        matchedStatus === 'PSD'
      ) {
        return {
          isPassing: true,
          flag: 'CLEARED',
          statusLabel: matchedStatus,
        };
      }

      // Academic Failure / Terminal Marks (disqualifies applicant/scholar)
      const failureKeywords = [
        'DROPPED',
        'FAILED',
        'FAIL',
        'FAILURE_DUE_TO_ABSENCES',
        'FA',
        'TOTAL_WITHDRAWAL',
        'TWE',
        'DISQUALIFIED',
        'UNSATISFACTORY',
        'U',
      ];
      if (
        failureKeywords.includes(matchedStatus) ||
        matchedStatus.includes('DROP') ||
        matchedStatus.includes('FAIL') ||
        matchedStatus.includes('WITHDRAW') ||
        matchedStatus.includes('DISQUALIF')
      ) {
        return {
          isPassing: false,
          flag: 'ACADEMIC_FAILURE',
          statusLabel: matchedStatus,
        };
      }

      return {
        isPassing: false,
        flag: 'ACADEMIC_FAILURE',
        statusLabel: matchedStatus,
      };
    }

    // 2. Non-numeric marks not in special_codes (common fallback keywords)
    if (!isNum) {
      const upper = rawGradeStr.toUpperCase();
      if (/^(PASSED|PASS|PSD|P|CREDITED|SATISFACTORY|S)$/i.test(upper)) {
        return { isPassing: true, flag: 'CLEARED', statusLabel: 'PASSED' };
      }
      if (/^(DROPPED|DROP|DRP|FAILED|FAIL|TWE|FA)$/i.test(upper)) {
        return {
          isPassing: false,
          flag: 'ACADEMIC_FAILURE',
          statusLabel: upper,
        };
      }
      if (/^(INC|INCOMPLETE|LOA|HOLD)$/i.test(upper)) {
        return {
          isPassing: false,
          flag: 'PENDING_REQUIREMENTS',
          statusLabel: upper,
        };
      }
      return {
        isPassing: false,
        flag: 'BELOW_PASSING_MARK',
        statusLabel: upper || 'UNKNOWN',
      };
    }

    // 3. Evaluate Numerical Thresholds (Respecting scale direction)
    let highest = Number(schoolConfig?.highest_grade);
    let passing = Number(schoolConfig?.passing_grade);
    let failing = Number(schoolConfig?.failing_grade);

    if (!schoolConfig || isNaN(highest) || isNaN(passing)) {
      if (numGrade <= 5.0 && numGrade >= 1.0) {
        // Decimal scale (e.g. UP/USEP/standard 5.0 where 1.0 is highest and 3.0 is passing)
        highest = 1.0;
        passing = 3.0;
        failing = 5.0;
      } else {
        // Standard percentage scale (75 passing, 100 highest)
        highest = 100;
        passing = 75;
        failing = 50;
      }
    }

    let isPassing = false;
    if (highest < failing) {
      // 5-point inverted scale (e.g. 1.0 highest, 3.0 passing, 5.0 failing)
      isPassing = numGrade <= passing && numGrade >= highest;
    } else {
      // Standard percentage (75 passing, 100 highest) or UM 4.0 scale (2.0 passing, 4.0 highest)
      isPassing = numGrade >= passing && numGrade <= highest;
    }

    return {
      isPassing,
      flag: isPassing ? 'CLEARED' : 'BELOW_PASSING_MARK',
      statusLabel: isPassing ? 'PASSED' : 'FAILED',
    };
  }

  /**
   * Evaluates if computed GWA meets retention threshold across different grading scales.
   * e.g., A 90% threshold translates to:
   * - 90.00 on a 100% percentage scale
   * - ~3.20 - 3.50 on UM's 4.0 scale (where 2.0 = 75%, 4.0 = 100%)
   * - ~1.80 on USEP / UP 5.0 scale (where 3.0 = 75%, 1.0 = 100%)
   */
  evaluateGwaThreshold(
    gwa: number,
    globalThresholdPercent: number,
    schoolConfig?: any,
  ): boolean {
    if (!schoolConfig || schoolConfig.grading_scale === 'PERCENTAGE_100') {
      return gwa >= globalThresholdPercent;
    }

    const highest = Number(schoolConfig.highest_grade ?? 1.0);
    const passing = Number(schoolConfig.passing_grade ?? 3.0);
    const failing = Number(schoolConfig.failing_grade ?? 5.0);

    const normalizedPercent = Math.max(
      75,
      Math.min(100, globalThresholdPercent),
    );

    if (highest < failing) {
      // Inverted 5-point scale (e.g. 1.0 highest, 3.0 passing at 75%)
      // 90% translates to: 3.0 - (15 / 25) * 2.0 = 1.80
      const thresholdGwa =
        passing - ((normalizedPercent - 75) / 25) * (passing - highest);
      return gwa <= Number(thresholdGwa.toFixed(2));
    } else {
      // Ascending scale (e.g. UM 4.0: 4.0 highest, 2.0 passing at 75%, 3.50 retention at 90-95%)
      const thresholdGwa =
        normalizedPercent <= 90
          ? passing + ((normalizedPercent - 75) / 15) * 1.5
          : 3.5 + ((normalizedPercent - 90) / 10) * (highest - 3.5);
      return gwa >= Number(thresholdGwa.toFixed(2));
    }
  }

  // ==========================================
  // ACADEMIC PROGRAMS CRUD
  // ==========================================

  // 1. Get all academic programs (optionally filter by active status)
  async getPrograms(onlyActive = false, includeArchived = false) {
    return this.cacheService.wrap(
      `settings:programs:${onlyActive ? 'active' : 'all'}:${includeArchived ? 'archived' : 'live'}`,
      async () => {
        return this.prisma.academicProgram.findMany({
          where: {
            ...(onlyActive ? { is_active: true } : {}),
            ...(includeArchived ? {} : { archived_at: null }),
          },
          orderBy: [{ category: 'asc' }, { program_name: 'asc' }],
        });
      },
      5 * 60 * 1000,
    );
  }

  // 2. Create new academic program
  async createProgram(userId: number, dto: CreateAcademicProgramDto) {
    const code = dto.program_code.trim().toUpperCase();
    const name = dto.program_name.trim();

    const existing = await this.prisma.academicProgram.findFirst({
      where: {
        OR: [{ program_code: code }, { program_name: name }],
      },
    });

    if (existing) {
      if (existing.program_code === code) {
        throw new ConflictException(
          `Program code '${code}' is already registered.`,
        );
      }
      throw new ConflictException(
        `Program name '${name}' is already registered.`,
      );
    }

    const program = await this.prisma.academicProgram.create({
      data: {
        program_code: code,
        program_name: name,
        category: dto.category?.trim() || 'College',
        description: dto.description?.trim(),
        is_active: dto.is_active ?? true,
      },
    });

    await this.auditService.log(
      userId,
      'PROGRAM_CREATED',
      `Registered new academic program '${program.program_name}' (${program.program_code})`,
    );

    await this.cacheService.delPattern('settings:programs:');
    this.eventsGateway.emitToAll('program:created', program);

    return program;
  }

  // 3. Update an existing academic program
  async updateProgram(
    userId: number,
    id: number,
    dto: UpdateAcademicProgramDto,
  ) {
    const existing = await this.prisma.academicProgram.findUnique({
      where: { program_id: id },
    });

    if (!existing) {
      throw new NotFoundException(`Academic program with ID ${id} not found.`);
    }

    if (existing.archived_at) {
      throw new BadRequestException(
        `Program '${existing.program_name}' is archived. Restore it before making changes.`,
      );
    }

    const code = dto.program_code?.trim().toUpperCase();
    const name = dto.program_name?.trim();

    if (code && code !== existing.program_code) {
      const duplicateCode = await this.prisma.academicProgram.findUnique({
        where: { program_code: code },
      });
      if (duplicateCode) {
        throw new ConflictException(`Program code '${code}' is already taken.`);
      }
    }

    if (name && name !== existing.program_name) {
      const duplicateName = await this.prisma.academicProgram.findUnique({
        where: { program_name: name },
      });
      if (duplicateName) {
        throw new ConflictException(`Program name '${name}' is already taken.`);
      }
    }

    const updated = await this.prisma.academicProgram.update({
      where: { program_id: id },
      data: {
        ...(code ? { program_code: code } : {}),
        ...(name ? { program_name: name } : {}),
        ...(dto.category !== undefined ? { category: dto.category.trim() } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description?.trim() }
          : {}),
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
      },
    });

    await this.auditService.log(
      userId,
      'PROGRAM_UPDATED',
      `Updated academic program '${updated.program_name}' (${updated.program_code})`,
    );

    await this.cacheService.delPattern('settings:programs:');
    this.eventsGateway.emitToAll('program:updated', updated);

    return updated;
  }

  // 4. Archive an academic program (replaces hard delete to preserve records)
  async deleteProgram(userId: number, id: number) {
    const existing = await this.prisma.academicProgram.findUnique({
      where: { program_id: id },
    });

    if (!existing) {
      throw new NotFoundException(`Academic program with ID ${id} not found.`);
    }

    if (existing.archived_at) {
      return {
        message: `Program '${existing.program_name}' is already archived.`,
        program: existing,
      };
    }

    const archived = await this.prisma.academicProgram.update({
      where: { program_id: id },
      data: {
        archived_at: new Date(),
        archived_by_user_id: userId,
        archive_reason: 'PROGRAM_REMOVED',
        is_active: false,
      },
    });

    await this.auditService.log(
      userId,
      'PROGRAM_ARCHIVED',
      `Archived academic program '${existing.program_name}' (${existing.program_code})`,
    );

    await this.cacheService.delPattern('settings:programs:');
    this.eventsGateway.emitToAll('program:deleted', { program_id: id });

    return {
      message: `Program '${existing.program_name}' archived successfully.`,
      program: archived,
    };
  }

  // ==========================================
  // NORMALIZED SCHOOL INSTITUTIONS MANAGEMENT
  // ==========================================

  // 1. Get all configured schools (institutions)
  async getSchools(onlyActive = false, includeArchived = false) {
    const cacheKey = `settings:schools_list:${onlyActive ? 'active' : 'all'}:${includeArchived ? 'archived' : 'live'}`;
    const cached = await this.cacheService.get(cacheKey);
    if (cached) return cached;

    const schools = await this.prisma.school.findMany({
      where: {
        ...(onlyActive ? { is_active: true } : {}),
        ...(includeArchived ? {} : { archived_at: null }),
      },
      include: {
        grading_system: true,
      },
      orderBy: { school_name: 'asc' },
    });

    await this.cacheService.set(cacheKey, schools, 300);
    return schools;
  }

  private async resolveOrCreateGradingSystem(
    schoolName: string,
    gradingScale?: string,
    explicitGradingSystemId?: number,
    specialCodes?: Record<string, string>,
  ): Promise<number | null> {
    if (explicitGradingSystemId && !specialCodes && !gradingScale) {
      const exists = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: explicitGradingSystemId },
      });
      if (exists) return exists.school_id;
    }

    if (!gradingScale || gradingScale === 'NONE') {
      return explicitGradingSystemId || null;
    }

    let highest = 1.0;
    let passing = 3.0;
    let failing = 5.0;
    let minGrade = 1.0;
    let maxGrade = 5.0;
    let defaultSpecialCodes: Record<string, string> = {
      INC: 'Incomplete',
      DRP: 'Dropped',
      FA: 'Failure due to Absences',
    };

    if (gradingScale === 'NUMERIC_4_POINT') {
      highest = 4.0;
      passing = 2.0;
      failing = 1.0;
      minGrade = 1.0;
      maxGrade = 4.0;
      defaultSpecialCodes = {
        '7.1': 'Unpaid Tuition',
        '7.2': 'Incomplete',
        '9.0': 'Dropped',
      };
    } else if (gradingScale === 'PERCENTAGE_100') {
      highest = 100.0;
      passing = 75.0;
      failing = 50.0;
      minGrade = 50.0;
      maxGrade = 100.0;
      defaultSpecialCodes = {
        INC: 'Incomplete',
        DRP: 'Dropped',
      };
    } else {
      gradingScale = 'NUMERIC_5_POINT';
      highest = 1.0;
      passing = 3.0;
      failing = 5.0;
      minGrade = 1.0;
      maxGrade = 5.0;
      defaultSpecialCodes = {
        INC: 'Incomplete',
        DRP: 'Dropped',
        FA: 'Failure due to Absences',
      };
    }

    const finalSpecialCodes = specialCodes ?? defaultSpecialCodes;

    const existing = explicitGradingSystemId
      ? await this.prisma.schoolGradingSystem.findUnique({
          where: { school_id: explicitGradingSystemId },
        })
      : await this.prisma.schoolGradingSystem.findUnique({
          where: { school_name: schoolName },
        });

    if (existing) {
      const updated = await this.prisma.schoolGradingSystem.update({
        where: { school_id: existing.school_id },
        data: {
          grading_scale: gradingScale,
          highest_grade: highest,
          passing_grade: passing,
          failing_grade: failing,
          min_grade: minGrade,
          max_grade: maxGrade,
          ...(specialCodes !== undefined ? { special_codes: specialCodes } : {}),
          is_verified: true,
        },
      });
      return updated.school_id;
    }

    const created = await this.prisma.schoolGradingSystem.create({
      data: {
        school_name: schoolName,
        grading_scale: gradingScale,
        highest_grade: highest,
        passing_grade: passing,
        failing_grade: failing,
        min_grade: minGrade,
        max_grade: maxGrade,
        special_codes: finalSpecialCodes,
        is_verified: true,
        notes: `Standard ${gradingScale} scale configured during school registration.`,
      },
    });

    return created.school_id;
  }

  // 2. Add a new school institution
  async createSchool(userId: number, dto: CreateSchoolDto) {
    const schoolName = dto.school_name.trim();
    const schoolCode = dto.school_code?.trim().toUpperCase();

    // Check duplicate school_name
    const existingName = await this.prisma.school.findUnique({
      where: { school_name: schoolName },
    });
    if (existingName) {
      throw new ConflictException(
        `School with name '${schoolName}' already exists.`,
      );
    }

    if (schoolCode) {
      const existingCode = await this.prisma.school.findUnique({
        where: { school_code: schoolCode },
      });
      if (existingCode) {
        throw new ConflictException(
          `School code '${schoolCode}' is already in use by '${existingCode.school_name}'.`,
        );
      }
    }

    const gradingSystemId = await this.resolveOrCreateGradingSystem(
      schoolName,
      dto.grading_scale,
      dto.grading_system_id,
      dto.special_codes,
    );

    const school = await this.prisma.school.create({
      data: {
        school_name: schoolName,
        school_code: schoolCode || null,
        address: dto.address?.trim() || null,
        contact_email: dto.contact_email?.trim() || null,
        contact_number: dto.contact_number?.trim() || null,
        grading_system_id: gradingSystemId,
        is_active: dto.is_active ?? true,
      },
      include: {
        grading_system: true,
      },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_CREATED',
      `Registered new academic institution '${school.school_name}' (${school.school_code || 'N/A'})`,
    );

    await this.cacheService.delPattern('settings:schools_list:');
    this.eventsGateway.emitToAll('school:created', school);

    return school;
  }

  // 3. Update an existing school institution
  async updateSchool(userId: number, id: number, dto: UpdateSchoolDto) {
    const existing = await this.prisma.school.findUnique({
      where: { school_id: id },
    });
    if (!existing) {
      throw new NotFoundException(`School with ID ${id} not found.`);
    }

    if (existing.archived_at) {
      throw new BadRequestException(
        `School '${existing.school_name}' is archived. Restore it before making changes.`,
      );
    }

    const schoolName = dto.school_name?.trim();
    const schoolCode = dto.school_code?.trim().toUpperCase();

    if (schoolName && schoolName !== existing.school_name) {
      const duplicate = await this.prisma.school.findUnique({
        where: { school_name: schoolName },
      });
      if (duplicate) {
        throw new ConflictException(
          `School name '${schoolName}' is already taken.`,
        );
      }
    }

    if (schoolCode && schoolCode !== existing.school_code) {
      const duplicateCode = await this.prisma.school.findUnique({
        where: { school_code: schoolCode },
      });
      if (duplicateCode) {
        throw new ConflictException(
          `School code '${schoolCode}' is already taken.`,
        );
      }
    }

    const targetSchoolName = schoolName || existing.school_name;
    let resolvedGradingSystemId: number | null | undefined = undefined;

    if (
      dto.grading_scale !== undefined ||
      dto.grading_system_id !== undefined ||
      dto.special_codes !== undefined
    ) {
      resolvedGradingSystemId = await this.resolveOrCreateGradingSystem(
        targetSchoolName,
        dto.grading_scale,
        dto.grading_system_id,
        dto.special_codes,
      );
    }

    const updated = await this.prisma.school.update({
      where: { school_id: id },
      data: {
        ...(schoolName ? { school_name: schoolName } : {}),
        ...(schoolCode !== undefined
          ? { school_code: schoolCode || null }
          : {}),
        ...(dto.address !== undefined
          ? { address: dto.address?.trim() || null }
          : {}),
        ...(dto.contact_email !== undefined
          ? { contact_email: dto.contact_email?.trim() || null }
          : {}),
        ...(dto.contact_number !== undefined
          ? { contact_number: dto.contact_number?.trim() || null }
          : {}),
        ...(resolvedGradingSystemId !== undefined
          ? { grading_system_id: resolvedGradingSystemId }
          : {}),
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
      },
      include: {
        grading_system: true,
      },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_UPDATED',
      `Updated academic institution '${updated.school_name}' (${updated.school_code || 'N/A'})`,
    );

    await this.cacheService.delPattern('settings:schools_list:');
    this.eventsGateway.emitToAll('school:updated', updated);

    return updated;
  }

  // 4. Archive a school institution (replaces hard delete to preserve records)
  async deleteSchool(userId: number, id: number) {
    const existing = await this.prisma.school.findUnique({
      where: { school_id: id },
      include: {
        scholar_profiles: { select: { profile_id: true }, take: 1 },
      },
    });

    if (!existing) {
      throw new NotFoundException(`School with ID ${id} not found.`);
    }

    if (existing.archived_at) {
      return {
        message: `School '${existing.school_name}' is already archived.`,
        school: existing,
      };
    }

    // Always archive instead of hard deleting so scholar/grade records
    // referencing this school remain intact.
    const archived = await this.prisma.school.update({
      where: { school_id: id },
      data: {
        archived_at: new Date(),
        archived_by_user_id: userId,
        archive_reason: 'SCHOOL_CLOSED',
        is_active: false,
      },
      include: { grading_system: true },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_ARCHIVED',
      `Archived school '${existing.school_name}' (${existing.school_code || 'N/A'}). Scholars linked: ${existing.scholar_profiles.length > 0 ? 'yes' : 'none'}.`,
    );

    await this.cacheService.delPattern('settings:schools_list:');
    this.eventsGateway.emitToAll('school:deleted', { school_id: id });

    return {
      message: `School '${existing.school_name}' has been archived.`,
      school: archived,
    };
  }
}
