import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { Role } from '../generated/prisma/enums.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';
import { QueryNotificationsDto } from './dto/query-notifications.dto.js';

export interface FormattedNotification {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  category: string;
  link?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  private formatNotification(n: {
    notification_id: number;
    title: string;
    message: string;
    category: string;
    link: string | null;
    is_read: boolean;
    created_at: Date;
  }): FormattedNotification {
    return {
      id: String(n.notification_id),
      title: n.title,
      message: n.message,
      timestamp: n.created_at.toISOString(),
      read: n.is_read,
      category: n.category,
      link: n.link || undefined,
    };
  }

  async getUserNotifications(
    userId: number,
    query: QueryNotificationsDto = {},
  ): Promise<{ notifications: FormattedNotification[]; unreadCount: number }> {
    const limit = query.limit || 50;
    const whereClause: { user_id: number; is_read?: boolean } = {
      user_id: userId,
    };

    if (query.unreadOnly) {
      whereClause.is_read = false;
    }

    const [items, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        take: limit,
      }),
      this.prisma.notification.count({
        where: { user_id: userId, is_read: false },
      }),
    ]);

    return {
      notifications: items.map((item) => this.formatNotification(item)),
      unreadCount,
    };
  }

  async getUnreadCount(userId: number): Promise<number> {
    return this.prisma.notification.count({
      where: { user_id: userId, is_read: false },
    });
  }

  async markAsRead(
    userId: number,
    notificationId: number,
  ): Promise<{
    success: boolean;
    notificationId: string;
    unreadCount: number;
  }> {
    await this.prisma.notification.updateMany({
      where: { notification_id: notificationId, user_id: userId },
      data: { is_read: true },
    });

    const unreadCount = await this.getUnreadCount(userId);
    return {
      success: true,
      notificationId: String(notificationId),
      unreadCount,
    };
  }

  async markAllAsRead(
    userId: number,
  ): Promise<{ success: boolean; unreadCount: number }> {
    await this.prisma.notification.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });

    return {
      success: true,
      unreadCount: 0,
    };
  }

  async deleteNotification(
    userId: number,
    notificationId: number,
  ): Promise<{ success: boolean; unreadCount: number }> {
    await this.prisma.notification.deleteMany({
      where: { notification_id: notificationId, user_id: userId },
    });

    const unreadCount = await this.getUnreadCount(userId);
    return {
      success: true,
      unreadCount,
    };
  }

  async clearAll(
    userId: number,
  ): Promise<{ success: boolean; unreadCount: number }> {
    await this.prisma.notification.deleteMany({
      where: { user_id: userId },
    });

    return {
      success: true,
      unreadCount: 0,
    };
  }

  async createNotification(
    userId: number,
    dto: CreateNotificationDto,
  ): Promise<FormattedNotification> {
    const created = await this.prisma.notification.create({
      data: {
        user_id: userId,
        title: dto.title,
        message: dto.message,
        category: dto.category || 'system',
        link: dto.link,
        is_read: false,
      },
    });

    const formatted = this.formatNotification(created);

    // Emit in real-time targeted strictly to the recipient's room
    try {
      this.eventsGateway.emitToUser(userId, 'notification:new', formatted);
    } catch (err) {
      this.logger.warn(
        `Failed to emit socket notification to user_${userId}:`,
        err,
      );
    }

    return formatted;
  }

  async createForRoles(
    roles: Role[],
    dto: CreateNotificationDto,
  ): Promise<FormattedNotification[]> {
    const targetUsers = await this.prisma.user.findMany({
      where: { role: { in: roles }, is_active: true },
      select: { user_id: true },
    });

    if (targetUsers.length === 0) return [];

    const createdList = await Promise.all(
      targetUsers.map((u) =>
        this.prisma.notification.create({
          data: {
            user_id: u.user_id,
            title: dto.title,
            message: dto.message,
            category: dto.category || 'system',
            link: dto.link,
            is_read: false,
          },
        }),
      ),
    );

    const formattedList = createdList.map((item) =>
      this.formatNotification(item),
    );

    for (const notif of formattedList) {
      try {
        const targetUserId = createdList.find(
          (c) => String(c.notification_id) === notif.id,
        )?.user_id;
        if (targetUserId) {
          this.eventsGateway.emitToUser(
            targetUserId,
            'notification:new',
            notif,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Failed to emit socket notification to staff member:`,
          err,
        );
      }
    }

    return formattedList;
  }

  async notifyUser(
    userId: number,
    data: { title: string; message: string; category?: string; link?: string },
  ): Promise<FormattedNotification> {
    return this.createNotification(userId, data);
  }

  async notifyStaff(data: {
    title: string;
    message: string;
    category?: string;
    link?: string;
  }): Promise<FormattedNotification[]> {
    return this.createForRoles(
      [Role.ADMIN, Role.COORDINATOR, Role.GRANTOR],
      data,
    );
  }

  async notifyCoordinators(data: {
    title: string;
    message: string;
    category?: string;
    link?: string;
  }): Promise<FormattedNotification[]> {
    return this.createForRoles([Role.ADMIN, Role.COORDINATOR], data);
  }
}
