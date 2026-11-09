import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { Role } from '../generated/prisma/enums.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

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

const makeNotification = (overrides: Record<string, unknown> = {}) => ({
  notification_id: 1,
  user_id: 42,
  title: 'Test Notification',
  message: 'Hello World',
  category: 'system',
  link: '/test',
  is_read: false,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  ...overrides,
});

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockPrisma: ReturnType<typeof createPrismaMock>;
  let mockEventsGateway: ReturnType<typeof createEventsGatewayMock>;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    mockPrisma = createPrismaMock();
    mockEventsGateway = createEventsGatewayMock();

    mockPrisma.notification.findMany.mockResolvedValue([makeNotification()]);
    mockPrisma.notification.count.mockResolvedValue(3);
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.notification.create.mockResolvedValue(makeNotification());
    mockPrisma.user.findMany.mockResolvedValue([
      { user_id: 42 },
      { user_id: 99 },
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEventsGateway },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getUserNotifications', () => {
    it('returns the mapped notifications and unread count', async () => {
      const result = await service.getUserNotifications(42);

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        where: { user_id: 42 },
        orderBy: { created_at: 'desc' },
        take: 50,
      });
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { user_id: 42, is_read: false },
      });
      expect(result).toEqual({
        notifications: [
          {
            id: '1',
            title: 'Test Notification',
            message: 'Hello World',
            timestamp: new Date('2026-08-01T00:00:00.000Z').toISOString(),
            read: false,
            category: 'system',
            link: '/test',
          },
        ],
        unreadCount: 3,
      });
    });

    it('limits to unread notifications when unreadOnly is set', async () => {
      await service.getUserNotifications(42, {
        unreadOnly: true,
      });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        where: { user_id: 42, is_read: false },
        orderBy: { created_at: 'desc' },
        take: 50,
      });
    });

    it('respects a custom limit from the query', async () => {
      await service.getUserNotifications(42, {
        limit: 5,
      });

      expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
        where: { user_id: 42 },
        orderBy: { created_at: 'desc' },
        take: 5,
      });
    });

    it('drops the link when the stored value is empty', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([
        makeNotification({ link: '' }),
      ]);

      const result = await service.getUserNotifications(42);

      expect(result.notifications[0].link).toBeUndefined();
    });
  });

  describe('getUnreadCount', () => {
    it('counts only unread notifications for the user', async () => {
      mockPrisma.notification.count.mockResolvedValue(7);

      await expect(service.getUnreadCount(42)).resolves.toBe(7);
      expect(mockPrisma.notification.count).toHaveBeenCalledWith({
        where: { user_id: 42, is_read: false },
      });
    });
  });

  describe('markAsRead', () => {
    it('marks the user-owned notification as read and returns the refreshed count', async () => {
      mockPrisma.notification.count.mockResolvedValue(2);

      const result = await service.markAsRead(42, 10);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { notification_id: 10, user_id: 42 },
        data: { is_read: true },
      });
      expect(result).toEqual({
        success: true,
        notificationId: '10',
        unreadCount: 2,
      });
    });
  });

  describe('markAllAsRead', () => {
    it('marks every unread notification as read for the user', async () => {
      const result = await service.markAllAsRead(42);

      expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
        where: { user_id: 42, is_read: false },
        data: { is_read: true },
      });
      expect(result).toEqual({ success: true, unreadCount: 0 });
    });
  });

  describe('deleteNotification', () => {
    it('deletes the user-owned notification and returns the refreshed count', async () => {
      mockPrisma.notification.count.mockResolvedValue(4);

      const result = await service.deleteNotification(42, 10);

      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { notification_id: 10, user_id: 42 },
      });
      expect(result).toEqual({ success: true, unreadCount: 4 });
    });
  });

  describe('clearAll', () => {
    it('deletes every notification for the user', async () => {
      const result = await service.clearAll(42);

      expect(mockPrisma.notification.deleteMany).toHaveBeenCalledWith({
        where: { user_id: 42 },
      });
      expect(result).toEqual({ success: true, unreadCount: 0 });
    });
  });

  describe('createNotification', () => {
    it('persists the notification and emits it to the recipient', async () => {
      const result = await service.createNotification(42, {
        title: 'New Application',
        message: 'An application was submitted',
        category: 'application',
        link: '/apps/1',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: 42,
          title: 'New Application',
          message: 'An application was submitted',
          category: 'application',
          link: '/apps/1',
          is_read: false,
        },
      });
      expect(mockEventsGateway.emitToUser).toHaveBeenCalledWith(
        42,
        'notification:new',
        result,
      );
      expect(result).toEqual({
        id: '1',
        title: 'Test Notification',
        message: 'Hello World',
        timestamp: new Date('2026-08-01T00:00:00.000Z').toISOString(),
        read: false,
        category: 'system',
        link: '/test',
      });
    });

    it('defaults the category to system when omitted', async () => {
      await service.createNotification(42, {
        title: 'T',
        message: 'M',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: objectMatching({ category: 'system' }),
      });
    });

    it('still returns when the socket emit fails', async () => {
      mockEventsGateway.emitToUser.mockImplementation(() => {
        throw new Error('socket down');
      });

      const result = await service.createNotification(42, {
        title: 'T',
        message: 'M',
      });

      expect(result.id).toBe('1');
    });
  });

  describe('createForRoles', () => {
    it('creates one notification per active user in the given roles', async () => {
      let id = 100;
      mockPrisma.notification.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...makeNotification({ notification_id: id++ }),
            ...data,
          }),
      );

      const result = await service.createForRoles(
        [Role.ADMIN, Role.COORDINATOR],
        {
          title: 'System Maintenance',
          message: 'Servers tonight',
          category: 'system',
        },
      );

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: {
          role: { in: [Role.ADMIN, Role.COORDINATOR] },
          is_active: true,
        },
        select: { user_id: true },
      });
      expect(mockPrisma.notification.create).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);
      expect(mockEventsGateway.emitToUser).toHaveBeenCalledTimes(2);
    });

    it('returns an empty list without creating anything when no staff exist', async () => {
      mockPrisma.user.findMany.mockResolvedValue([]);

      const result = await service.createForRoles([Role.ADMIN], {
        title: 'T',
        message: 'M',
      });

      expect(result).toEqual([]);
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockEventsGateway.emitToUser).not.toHaveBeenCalled();
    });

    it('continues emitting to other users when one socket emit throws', async () => {
      let id = 100;
      mockPrisma.notification.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...makeNotification({ notification_id: id++ }),
            ...data,
          }),
      );
      mockEventsGateway.emitToUser.mockImplementation(() => {
        throw new Error('socket down');
      });

      const result = await service.createForRoles([Role.ADMIN, Role.GRANTOR], {
        title: 'T',
        message: 'M',
      });

      expect(result).toHaveLength(2);
    });

    it('defaults the category to system when omitted', async () => {
      let id = 100;
      mockPrisma.notification.create.mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            ...makeNotification({ notification_id: id++ }),
            ...data,
          }),
      );

      await service.createForRoles([Role.ADMIN], {
        title: 'T',
        message: 'M',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: objectMatching({ category: 'system' }),
      });
    });
  });

  describe('staff broadcasts', () => {
    it('notifies admins, coordinators, and grantors via notifyStaff', async () => {
      await service.notifyStaff({ title: 'T', message: 'M' });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: {
          role: { in: [Role.ADMIN, Role.COORDINATOR, Role.GRANTOR] },
          is_active: true,
        },
        select: { user_id: true },
      });
    });

    it('notifies admins and coordinators via notifyCoordinators', async () => {
      await service.notifyCoordinators({ title: 'T', message: 'M' });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
        where: {
          role: { in: [Role.ADMIN, Role.COORDINATOR] },
          is_active: true,
        },
        select: { user_id: true },
      });
    });

    it('notifies a single user via notifyUser', async () => {
      await service.notifyUser(7, {
        title: 'T',
        message: 'M',
        category: 'chat',
        link: '/chat/1',
      });

      expect(mockPrisma.notification.create).toHaveBeenCalledWith({
        data: {
          user_id: 7,
          title: 'T',
          message: 'M',
          category: 'chat',
          link: '/chat/1',
          is_read: false,
        },
      });
    });
  });
});
