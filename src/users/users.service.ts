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
}
