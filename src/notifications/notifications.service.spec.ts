import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';

const createPrismaMock = () => ({
  notification: {
    findMany: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
  },
  user: {
    findMany: vi.fn(),
  },
});

const createEventsGatewayMock = () => ({
  emitToUser: vi.fn(),
});

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockPrisma: ReturnType<typeof createPrismaMock>;
  let mockEventsGateway: ReturnType<typeof createEventsGatewayMock>;

  beforeEach(async () => {
    mockPrisma = createPrismaMock();
    mockEventsGateway = createEventsGatewayMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return user notifications and unread count', async () => {
    const mockDate = new Date();
    mockPrisma.notification.findMany.mockResolvedValue([
      {
        notification_id: 1,
        user_id: 42,
        title: 'Test Notification',
        message: 'Hello World',
        category: 'system',
        link: '/test',
        is_read: false,
        created_at: mockDate,
      },
    ]);
    mockPrisma.notification.count.mockResolvedValue(1);

    const result = await service.getUserNotifications(42);
    expect(result.unreadCount).toBe(1);
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toEqual({
      id: '1',
      title: 'Test Notification',
      message: 'Hello World',
      timestamp: mockDate.toISOString(),
      read: false,
      category: 'system',
      link: '/test',
    });
  });

  it('should create notification and emit to user room', async () => {
    const mockDate = new Date();
    mockPrisma.notification.create.mockResolvedValue({
      notification_id: 99,
      user_id: 42,
      title: 'New Event',
      message: 'Event description',
      category: 'application',
      link: '/app',
      is_read: false,
      created_at: mockDate,
    });

    const result = await service.createNotification(42, {
      title: 'New Event',
      message: 'Event description',
      category: 'application',
      link: '/app',
    });

    expect(result.id).toBe('99');
    expect(mockEventsGateway.emitToUser).toHaveBeenCalledWith(
      42,
      'notification:new',
      expect.objectContaining({ id: '99', title: 'New Event' }),
    );
  });

  it('should mark notification as read', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.count.mockResolvedValue(0);

    const result = await service.markAsRead(42, 1);
    expect(result.success).toBe(true);
    expect(result.notificationId).toBe('1');
    expect(result.unreadCount).toBe(0);
  });
});
