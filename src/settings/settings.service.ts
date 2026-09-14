import {
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
import { UpdateSchoolGradingDto } from './dto/update-school-grading.dto.js';

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private eventsGateway: EventsGateway,
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
  async getSettings() {
    let settings = await this.prisma.systemSetting.findFirst();
    if (!settings) {
      settings = await this.prisma.systemSetting.create({
        data: { grade_threshold: 90.0 },
      });
    }
    return settings;
  }

  // 2. Update Global Settings (Admin / Grantor)
  async updateSettings(userId: number, dto: UpdateSettingsDto) {
    const settings = await this.getSettings();

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

    this.eventsGateway.emitToStaff('settings:updated', updated);
    this.eventsGateway.emitToAll('settings:updated', updated);

    return updated;
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
    const isVerified = isStudent ? (dto.is_verified ?? false) : (dto.is_verified ?? true);

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
      isVerified ? 'SCHOOL_GRADING_CREATED' : 'SCHOOL_GRADING_SUBMITTED_BY_STUDENT',
      `${isVerified ? 'Configured' : 'Proposed'} grading system for school: ${dto.school_name}`,
    );

    this.eventsGateway.emitToStaff('school_grading:created', school);

    return school;
  }

  // 4. Get All School Grading Scales (Optional query for verifiedOnly)
  async getSchoolGradings(verifiedOnly?: boolean) {
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
        return { isPassing: false, flag: 'ACADEMIC_FAILURE', statusLabel: upper };
      }
      if (/^(INC|INCOMPLETE|LOA|HOLD)$/i.test(upper)) {
        return { isPassing: false, flag: 'PENDING_REQUIREMENTS', statusLabel: upper };
      }
      return { isPassing: false, flag: 'BELOW_PASSING_MARK', statusLabel: upper || 'UNKNOWN' };
    }

    // 3. Evaluate Numerical Thresholds (Respecting scale direction)
    const highest = Number(schoolConfig?.highest_grade ?? 100);
    const passing = Number(schoolConfig?.passing_grade ?? 75);
    const failing = Number(schoolConfig?.failing_grade ?? 50);

    let isPassing = false;
    if (highest < failing) {
      // 5-point inverted scale (e.g. 1.0 highest, 3.0 passing, 5.0 failing)
      // Lower or equal to passing mark is passing
      isPassing = numGrade <= passing && numGrade >= highest;
    } else {
      // Standard percentage (75 passing, 100 highest) or UM 4.0 scale (2.0 passing, 4.0 highest)
      // Greater or equal to passing mark is passing
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
      // Ascending scale (e.g. UM 4.0: 4.0 highest, 2.0 passing at 75%)
      // 90% translates to: 2.0 + (15 / 25) * 2.0 = 3.20
      const thresholdGwa =
        passing + ((normalizedPercent - 75) / 25) * (highest - passing);
      return gwa >= Number(thresholdGwa.toFixed(2));
    }
  }
}

