import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

const makeRequest = (userId = 42, role = 'SCHOLAR') => ({
  user: { user_id: userId, email: 'scholar@example.com', role },
});

describe('NotificationsController', () => {
  let controller: NotificationsController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      getUserNotifications: vi.fn(),
      getUnreadCount: vi.fn(),
      markAsRead: vi.fn(),
      markAllAsRead: vi.fn(),
      deleteNotification: vi.fn(),
      clearAll: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [
        {
          provide: NotificationsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<NotificationsController>(NotificationsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates getUserNotifications with user id and query', async () => {
    const req = makeRequest();
    const query = { limit: 10 };
    serviceMock.getUserNotifications.mockResolvedValue({
      notifications: [],
      unreadCount: 0,
    });

    const result = await controller.getUserNotifications(req, query);

    expect(serviceMock.getUserNotifications).toHaveBeenCalledWith(42, query);
    expect(result).toEqual({ notifications: [], unreadCount: 0 });
  });

  it('delegates getUnreadCount and wraps the result', async () => {
    const req = makeRequest();
    serviceMock.getUnreadCount.mockResolvedValue(3);

    const result = await controller.getUnreadCount(req);

    expect(serviceMock.getUnreadCount).toHaveBeenCalledWith(42);
    expect(result).toEqual({ unreadCount: 3 });
  });

  it('delegates markAllAsRead to the service', async () => {
    serviceMock.markAllAsRead.mockResolvedValue({
      success: true,
      unreadCount: 0,
    });

    await controller.markAllAsRead(makeRequest());

    expect(serviceMock.markAllAsRead).toHaveBeenCalledWith(42);
  });

  it('delegates markAsRead with id and user', async () => {
    serviceMock.markAsRead.mockResolvedValue({
      success: true,
      notificationId: '7',
      unreadCount: 1,
    });

    await controller.markAsRead(makeRequest(), 7);

    expect(serviceMock.markAsRead).toHaveBeenCalledWith(42, 7);
  });

  it('delegates deleteNotification with id and user', async () => {
    serviceMock.deleteNotification.mockResolvedValue({
      success: true,
      unreadCount: 0,
    });

    await controller.deleteNotification(makeRequest(), 7);

    expect(serviceMock.deleteNotification).toHaveBeenCalledWith(42, 7);
  });

  it('delegates clearAll to the service', async () => {
    serviceMock.clearAll.mockResolvedValue({ success: true, unreadCount: 0 });

    await controller.clearAll(makeRequest());

    expect(serviceMock.clearAll).toHaveBeenCalledWith(42);
  });
});
