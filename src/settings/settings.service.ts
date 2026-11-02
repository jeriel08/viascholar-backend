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
import { CreateAcademicProgramDto } from './dto/create-program.dto.js';
import { UpdateAcademicProgramDto } from './dto/update-program.dto.js';
import { CreateSchoolDto } from './dto/create-school.dto.js';
import { UpdateSchoolDto } from './dto/update-school.dto.js';
import { AppCacheService } from '../common/cache/app-cache.service.js';

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
  async getPrograms(onlyActive = false) {
    return this.cacheService.wrap(
      `settings:programs:${onlyActive ? 'active' : 'all'}`,
      async () => {
        return this.prisma.academicProgram.findMany({
          where: onlyActive ? { is_active: true } : undefined,
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

  // 4. Delete an academic program
  async deleteProgram(userId: number, id: number) {
    const existing = await this.prisma.academicProgram.findUnique({
      where: { program_id: id },
    });

    if (!existing) {
      throw new NotFoundException(`Academic program with ID ${id} not found.`);
    }

    await this.prisma.academicProgram.delete({
      where: { program_id: id },
    });

    await this.auditService.log(
      userId,
      'PROGRAM_DELETED',
      `Deleted academic program '${existing.program_name}' (${existing.program_code})`,
    );

    await this.cacheService.delPattern('settings:programs:');
    this.eventsGateway.emitToAll('program:deleted', { program_id: id });

    return {
      message: `Program '${existing.program_name}' deleted successfully.`,
    };
  }

  // ==========================================
  // NORMALIZED SCHOOL INSTITUTIONS MANAGEMENT
  // ==========================================

  // 1. Get all configured schools (institutions)
  async getSchools(onlyActive = false) {
    const cacheKey = `settings:schools_list:${onlyActive ? 'active' : 'all'}`;
    const cached = await this.cacheService.get(cacheKey);
    if (cached) return cached;

    const schools = await this.prisma.school.findMany({
      where: onlyActive ? { is_active: true } : undefined,
      include: {
        grading_system: true,
      },
      orderBy: { school_name: 'asc' },
    });

    await this.cacheService.set(cacheKey, schools, 300);
    return schools;
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

    // Verify grading_system_id if provided
    if (dto.grading_system_id) {
      const existsGrading = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: dto.grading_system_id },
      });
      if (!existsGrading) {
        throw new NotFoundException(
          `Grading system with ID ${dto.grading_system_id} does not exist.`,
        );
      }
    }

    const school = await this.prisma.school.create({
      data: {
        school_name: schoolName,
        school_code: schoolCode || null,
        address: dto.address?.trim() || null,
        contact_email: dto.contact_email?.trim() || null,
        contact_number: dto.contact_number?.trim() || null,
        grading_system_id: dto.grading_system_id || null,
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

    if (dto.grading_system_id !== undefined && dto.grading_system_id !== null) {
      const existsGrading = await this.prisma.schoolGradingSystem.findUnique({
        where: { school_id: dto.grading_system_id },
      });
      if (!existsGrading) {
        throw new NotFoundException(
          `Grading system with ID ${dto.grading_system_id} does not exist.`,
        );
      }
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
        ...(dto.grading_system_id !== undefined
          ? { grading_system_id: dto.grading_system_id }
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

  // 4. Delete a school institution
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

    // If scholars are associated with this school, soft-deactivate instead of hard delete
    if (existing.scholar_profiles.length > 0) {
      const deactivated = await this.prisma.school.update({
        where: { school_id: id },
        data: { is_active: false },
        include: { grading_system: true },
      });

      await this.auditService.log(
        userId,
        'SCHOOL_DEACTIVATED',
        `Deactivated school '${existing.school_name}' because scholars are currently associated with it`,
      );

      await this.cacheService.delPattern('settings:schools_list:');
      this.eventsGateway.emitToAll('school:updated', deactivated);

      return {
        message: `School '${existing.school_name}' is associated with scholars and has been deactivated instead of deleted.`,
        school: deactivated,
      };
    }

    await this.prisma.school.delete({
      where: { school_id: id },
    });

    await this.auditService.log(
      userId,
      'SCHOOL_DELETED',
      `Deleted school '${existing.school_name}'`,
    );

    await this.cacheService.delPattern('settings:schools_list:');
    this.eventsGateway.emitToAll('school:deleted', { school_id: id });

    return {
      message: `School '${existing.school_name}' deleted successfully.`,
    };
  }
}
