import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { QueryUsersDto } from './dto/query-users.dto.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import * as bcrypt from 'bcrypt';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditService: AuditService,
    private eventsGateway: EventsGateway,
  ) {}

  // Get all users (Filtered by Role or Name search)
  async findAll(query: QueryUsersDto) {
    const where: any = {};

    if (query.role) {
      where.role = query.role;
    } else if (query.roles) {
      const roleList = query.roles
        .split(',')
        .map((r) => r.trim() as any)
        .filter(Boolean);
      if (roleList.length > 0) {
        where.role = { in: roleList };
      }
    }

    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        {
          scholar_profile: {
            first_name: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            last_name: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            course_of_study: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          scholar_profile: {
            scholarship_track: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          employee: {
            first_name: { contains: query.search, mode: 'insensitive' },
          },
        },
        {
          employee: {
            last_name: { contains: query.search, mode: 'insensitive' },
          },
        },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      orderBy: { created_at: 'desc' },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        scholar_profile: true,
        employee: true,
      },
    });

    return users;
  }

  // Find single user profile
  async findOne(id: number) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: id },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
        last_login_at: true,
        created_at: true,
        scholar_profile: true,
        employee: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found.`);
    }

    return user;
  }

  // Toggle user active status (Enable / Disable account)
  async updateStatus(
    adminUserId: number,
    targetUserId: number,
    dto: UpdateUserStatusDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: targetUserId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found.`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { user_id: targetUserId },
      data: { is_active: dto.is_active },
      select: {
        user_id: true,
        email: true,
        role: true,
        is_active: true,
      },
    });

    const actionLabel = dto.is_active ? 'USER_ACTIVATED' : 'USER_DEACTIVATED';
    await this.auditService.log(
      adminUserId,
      actionLabel,
      `Admin (ID: ${adminUserId}) updated User status (ID: ${targetUserId}) to ${dto.is_active ? 'ACTIVE' : 'INACTIVE'}`,
    );

    this.eventsGateway.emitToAdmin('user:status_updated', {
      userId: targetUserId,
      isActive: dto.is_active,
      user: updatedUser,
    });
    this.eventsGateway.emitToUser(targetUserId, 'user:status_updated', {
      userId: targetUserId,
      isActive: dto.is_active,
    });

    return updatedUser;
  }

  async resetPassword(
    adminUserId: number,
    targetUserId: number,
    dto: ResetPasswordDto,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: targetUserId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${targetUserId} not found.`);
    }

    const hashedPassword = await bcrypt.hash(dto.new_password, 10);

    await this.prisma.user.update({
      where: { user_id: targetUserId },
      data: { password_hash: hashedPassword },
    });

    // 🚀 Audit log the password reset
    await this.auditService.log(
      adminUserId,
      'USER_PASSWORD_RESET',
      `Admin (ID: ${adminUserId}) reset password for User (ID: ${targetUserId})`,
    );

    this.eventsGateway.emitToAdmin('user:password_reset', {
      userId: targetUserId,
    });
    this.eventsGateway.emitToUser(targetUserId, 'user:password_reset', {
      userId: targetUserId,
    });

    return {
      message: `Password for user ID ${targetUserId} reset successfully.`,
    };
  }

  // Fast aggregated summary endpoint for Admin Dashboard
  async getAdminDashboardSummary() {
    const [
      staffUsers,
      totalStudents,
      activeScholars,
      applicants,
      schools,
      totalSchools,
      verifiedSchools,
      settings,
      recentLogs,
    ] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          employee: { isNot: null },
        },
        include: {
          employee: true,
        },
        orderBy: { user_id: 'desc' },
      }),
      this.prisma.user.count({
        where: {
          role: { in: ['SCHOLAR', 'APPLICANT'] },
        },
      }),
      this.prisma.user.count({
        where: {
          role: 'SCHOLAR',
          is_active: true,
        },
      }),
      this.prisma.user.count({
        where: {
          role: 'APPLICANT',
        },
      }),
      this.prisma.schoolGradingSystem.findMany({
        orderBy: { school_name: 'asc' },
        take: 5,
      }),
      this.prisma.schoolGradingSystem.count(),
      this.prisma.schoolGradingSystem.count({
        where: { is_verified: true },
      }),
      this.prisma.systemSetting.findFirst(),
      this.prisma.auditLog.findMany({
        take: 6,
        orderBy: { created_at: 'desc' },
        include: {
          user: {
            select: {
              user_id: true,
              email: true,
              role: true,
              scholar_profile: {
                select: { first_name: true, last_name: true },
              },
              employee: {
                select: { first_name: true, last_name: true },
              },
            },
          },
        },
      }),
    ]);

    const coordinatorCount = staffUsers.filter(
      (u) => u.role === 'COORDINATOR',
    ).length;
    const grantorCount = staffUsers.filter((u) => u.role === 'GRANTOR').length;
    const adminCount = staffUsers.filter((u) => u.role === 'ADMIN').length;
    const activeStaff = staffUsers.filter((u) => u.is_active).length;

    return {
      metrics: {
        totalStaff: staffUsers.length,
        activeStaff,
        coordinatorCount,
        grantorCount,
        adminCount,
        totalStudents,
        activeScholarsCount: activeScholars,
        applicantCount: applicants,
        totalSchools,
        verifiedSchools,
        gradeThreshold: settings?.grade_threshold
          ? Number(settings.grade_threshold)
          : 85,
      },
      staff: staffUsers.map((u) => ({
        id: u.user_id,
        name:
          `${u.employee?.first_name || ''} ${u.employee?.last_name || ''}`.trim() ||
          u.email,
        initials:
          `${(u.employee?.first_name || '')[0] || ''}${(u.employee?.last_name || '')[0] || ''}`.toUpperCase() ||
          'U',
        email: u.email,
        type:
          u.role === 'COORDINATOR'
            ? 'Coordinator'
            : u.role === 'GRANTOR'
              ? 'Grantor'
              : 'Admin',
        title: u.employee?.title || '',
        department: u.employee?.department || '',
        phone: '',
        active: u.is_active,
        joined: u.created_at
          ? new Date(u.created_at).toISOString().split('T')[0]
          : '',
      })),
      schools: schools.map((s) => ({
        school_id: s.school_id,
        school_name: s.school_name,
        grading_scale: s.grading_scale,
        passing_grade: Number(s.passing_grade),
        highest_grade: Number(s.highest_grade),
        failing_grade: Number(s.failing_grade),
        is_verified: s.is_verified,
        special_codes: (s.special_codes as Record<string, string>) || null,
        notes: s.notes,
        created_at: s.created_at?.toISOString() || '',
        updated_at: s.updated_at?.toISOString() || '',
      })),
      settings: settings
        ? {
            id: settings.setting_id,
            grade_retention_threshold: Number(settings.grade_threshold),
            updated_at: settings.updated_at?.toISOString() || '',
            updated_by_user_id: settings.updated_by_user_id,
          }
        : null,
      recentLogs: recentLogs.map((l) => ({
        log_id: l.log_id,
        user_id: l.user_id,
        action: l.action,
        details: l.details || '',
        created_at: l.created_at?.toISOString() || '',
        user: {
          user_id: l.user?.user_id || 0,
          email: l.user?.email || '',
          role: l.user?.role || 'SYSTEM',
          first_name:
            l.user?.employee?.first_name ||
            l.user?.scholar_profile?.first_name ||
            '',
          last_name:
            l.user?.employee?.last_name ||
            l.user?.scholar_profile?.last_name ||
            '',
        },
      })),
    };
  }
}
