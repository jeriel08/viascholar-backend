import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppCacheService } from '../../common/cache/app-cache.service.js';

@Injectable()
export class AdminDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: AppCacheService,
  ) {}

  /**
   * Fast aggregated summary endpoint for Admin Dashboard.
   * Cached for 60 seconds unless forceRefresh is true.
   */
  async getAdminDashboardSummary(forceRefresh = false) {
    const cacheKey = 'dashboard:admin';

    return this.cacheService.wrap(
      cacheKey,
      async () => {
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
        const grantorCount = staffUsers.filter(
          (u) => u.role === 'GRANTOR',
        ).length;
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
      },
      60 * 1000,
      forceRefresh,
    );
  }
}
