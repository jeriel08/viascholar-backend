import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  /**
   * Log an administrative or system action
   * @param userId ID of the user performing the action (or null for system events)
   * @param action Short string key (e.g. "USER_STATUS_UPDATED", "APPLICATION_APPROVED")
   * @param details Additional context or description
   */
  async log(userId: number | null, action: string, details?: string) {
    try {
      return await this.prisma.auditLog.create({
        data: {
          user_id: userId,
          action,
          details,
        },
      });
    } catch (error) {
      console.error('Failed to create audit log entry:', error);
    }
  }

  async getLogs(page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [logs, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          user: {
            select: { user_id: true, email: true, role: true },
          },
        },
      }),
      this.prisma.auditLog.count(),
    ]);

    return { logs, total, page, limit };
  }
}
