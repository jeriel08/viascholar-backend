import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ChatRequestsService } from './chat-requests.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import type { RequestGrantorDto } from '../dto/request-grantor.dto.js';
import type { RespondRequestDto } from '../dto/respond-request.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  user: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  conversation: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
});

const createEventsMock = () => ({
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
});

const createNotificationsMock = () => ({
  notifyUser: vi.fn(),
});

const makeEmployeeUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 2,
  email: 'coordinator@example.com',
  role: 'COORDINATOR',
  is_active: true,
  employee: {
    employee_id: 3,
    first_name: 'Maria',
    last_name: 'Santos',
    title: 'Scholarship Coordinator',
    department: 'Scholarship Office',
    avatar_url: null,
  },
  ...overrides,
});

const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  conversation_id: 55,
  scholar_user_id: 7,
  coordinator_user_id: 4,
  subject: 'Scholar Message Request',
  status: 'PENDING_REQUEST',
  request_note: 'Need help',
  scholar: {
    scholar_profile: { first_name: 'Juan', last_name: 'Dela Cruz' },
  },
  coordinator: {
    employee: {
      first_name: 'Petra',
      last_name: 'Grantor',
      title: 'Scholarship Grantor',
      department: 'Partner Organization',
      avatar_url: null,
    },
  },
  ...overrides,
});

const makeGrantor = (overrides: Record<string, unknown> = {}) =>
  makeEmployeeUser({
    user_id: 4,
    email: 'grantor@example.com',
    role: 'GRANTOR',
    employee: {
      employee_id: 4,
      first_name: 'Petra',
      last_name: 'Grantor',
      title: 'Scholarship Grantor',
      department: 'Partner Organization',
      avatar_url: null,
    },
    ...overrides,
  });

describe('ChatRequestsService', () => {
  let service: ChatRequestsService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let events: ReturnType<typeof createEventsMock>;
  let notifications: ReturnType<typeof createNotificationsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    events = createEventsMock();
    notifications = createNotificationsMock();

    prisma.user.findMany.mockResolvedValue([makeEmployeeUser()]);
    prisma.user.findUnique.mockResolvedValue(makeEmployeeUser());
    prisma.conversation.findMany.mockResolvedValue([]);
    prisma.conversation.findUnique.mockResolvedValue(makeConversation());
    prisma.conversation.create.mockResolvedValue(makeConversation());
    prisma.conversation.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...makeConversation(), ...data }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatRequestsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsGateway, useValue: events },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = module.get<ChatRequestsService>(ChatRequestsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getCoordinators', () => {
    it('returns active coordinators with employee details', async () => {
      const result = await service.getCoordinators(7);

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { role: 'COORDINATOR', is_active: true },
        include: { employee: true },
        orderBy: { employee: { first_name: 'asc' } },
      });
      expect(result[0]).toEqual({
        user_id: 2,
        email: 'coordinator@example.com',
        role: 'COORDINATOR',
        first_name: 'Maria',
        last_name: 'Santos',
        title: 'Scholarship Coordinator',
        department: 'Scholarship Office',
        avatar_url: null,
        conversation_id: null,
        status: 'ACTIVE',
      });
    });

    it('attaches an existing conversation to the matched coordinator', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        { conversation_id: 55, coordinator_user_id: 2, status: 'ACTIVE' },
      ]);

      const result = await service.getCoordinators(7);

      expect(result[0]).toEqual(
        objectMatching({
          conversation_id: 55,
          status: 'ACTIVE',
        }),
      );
    });

    it('falls back to safe defaults when the coordinator has no employee record', async () => {
      prisma.user.findMany.mockResolvedValue([
        makeEmployeeUser({ employee: null }),
      ]);

      const result = await service.getCoordinators(7);

      expect(result[0]).toEqual(
        objectMatching({
          first_name: '',
          last_name: '',
          title: 'Scholarship Coordinator',
          department: 'Scholarship Office',
          avatar_url: null,
        }),
      );
    });
  });

  describe('getGrantors', () => {
    it('returns grantors with a NONE request status when no conversation exists', async () => {
      prisma.user.findMany.mockResolvedValue([makeGrantor()]);

      const result = await service.getGrantors(7);

      expect(result[0]).toEqual(
        objectMatching({
          user_id: 4,
          title: 'Scholarship Grantor',
          department: 'Partner Organization',
          conversation_id: null,
          status: 'NONE',
          request_note: null,
        }),
      );
    });

    it('shows the request status and note when a request exists', async () => {
      prisma.user.findMany.mockResolvedValue([makeGrantor()]);
      prisma.conversation.findMany.mockResolvedValue([
        {
          conversation_id: 60,
          coordinator_user_id: 4,
          status: 'PENDING_REQUEST',
          request_note: 'Need updates',
        },
      ]);

      const result = await service.getGrantors(7);

      expect(result[0]).toEqual(
        objectMatching({
          conversation_id: 60,
          status: 'PENDING_REQUEST',
          request_note: 'Need updates',
        }),
      );
    });

    it('falls back to safe defaults when the grantor has no employee record', async () => {
      prisma.user.findMany.mockResolvedValue([makeGrantor({ employee: null })]);

      const result = await service.getGrantors(7);

      expect(result[0]).toEqual(
        objectMatching({
          first_name: '',
          last_name: '',
          title: 'Scholarship Grantor',
          department: 'Partner Organization',
        }),
      );
    });
  });

  describe('requestGrantorAccess', () => {
    const requestDto = {
      grantor_user_id: 4,
      reason: 'Inquiry regarding guidelines',
      subject: 'Project Inquiry',
    } as RequestGrantorDto;

    it('rejects a request targeting yourself', async () => {
      await expect(service.requestGrantorAccess(4, requestDto)).rejects.toThrow(
        new BadRequestException('Invalid target user.'),
      );
    });

    it('throws NotFoundException when the user is not an active grantor', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.requestGrantorAccess(7, requestDto)).rejects.toThrow(
        new NotFoundException('Grantor not found.'),
      );
    });

    it('throws NotFoundException when the user is not a grantor', async () => {
      prisma.user.findUnique.mockResolvedValue(makeEmployeeUser());

      await expect(service.requestGrantorAccess(7, requestDto)).rejects.toThrow(
        new NotFoundException('Grantor not found.'),
      );
    });

    it('returns an already-active conversation unchanged', async () => {
      prisma.user.findUnique.mockResolvedValue(makeGrantor());
      prisma.conversation.findUnique.mockResolvedValue(
        makeConversation({ status: 'ACTIVE' }),
      );

      const result = await service.requestGrantorAccess(7, requestDto);

      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(result.status).toBe('ACTIVE');
    });

    it('creates a new pending request conversation', async () => {
      prisma.user.findUnique.mockResolvedValue(makeGrantor());
      prisma.conversation.findUnique.mockResolvedValue(null);

      const result = await service.requestGrantorAccess(7, requestDto);

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: {
          scholar_user_id: 7,
          coordinator_user_id: 4,
          status: 'PENDING_REQUEST',
          request_note: 'Inquiry regarding guidelines',
          subject: 'Project Inquiry',
        },
        include: anyArg(Object),
      });
      expect(result.status).toBe('PENDING_REQUEST');
    });

    it('returns the default subject when none is provided', async () => {
      prisma.user.findUnique.mockResolvedValue(makeGrantor());
      prisma.conversation.findUnique.mockResolvedValue(null);

      await service.requestGrantorAccess(7, {
        grantor_user_id: 4,
        reason: 'Need to ask about the defense schedule',
      });

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: objectMatching({
          subject: 'Scholar Message Request',
        }),
        include: anyArg(Object),
      });
    });

    it('reopens a previously rejected conversation as pending', async () => {
      prisma.user.findUnique.mockResolvedValue(makeGrantor());
      prisma.conversation.findUnique.mockResolvedValue(
        makeConversation({ status: 'REJECTED' }),
      );

      const result = await service.requestGrantorAccess(7, requestDto);

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { conversation_id: 55 },
        data: {
          status: 'PENDING_REQUEST',
          request_note: 'Inquiry regarding guidelines',
          subject: 'Project Inquiry',
        },
        include: anyArg(Object),
      });
      expect(result.status).toBe('PENDING_REQUEST');
    });

    it('notifies the grantor via websocket and in-app notification', async () => {
      prisma.user.findUnique.mockResolvedValue(makeGrantor());
      prisma.conversation.findUnique.mockResolvedValue(null);

      await service.requestGrantorAccess(7, requestDto);

      expect(events.emitToUser).toHaveBeenCalledWith(
        4,
        'chat:message_request',
        objectMatching({
          conversationId: 55,
          scholarUserId: 7,
          scholarName: 'Juan Dela Cruz',
          subject: 'Scholar Message Request',
          reason: 'Inquiry regarding guidelines',
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        4,
        objectMatching({
          title: 'Message Access Request',
          category: 'chat',
        }),
      );
    });
  });

  describe('respondToRequest', () => {
    const acceptDto = { action: 'ACCEPT' } as RespondRequestDto;
    const rejectDto = { action: 'REJECT' } as RespondRequestDto;

    it('throws NotFoundException when the conversation is missing', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(service.respondToRequest(4, 999, acceptDto)).rejects.toThrow(
        new NotFoundException('Conversation ID 999 not found.'),
      );
    });

    it('throws ForbiddenException when a non-recipient scholar tries to respond', async () => {
      prisma.user.findUnique.mockResolvedValue({
        user_id: 8,
        role: 'SCHOLAR',
      });

      await expect(service.respondToRequest(8, 55, acceptDto)).rejects.toThrow(
        new ForbiddenException(
          'Only the recipient grantor or staff can respond to this request.',
        ),
      );
    });

    it('allows an admin or coordinator to respond even if they are not the recipient', async () => {
      prisma.user.findUnique.mockResolvedValue({
        user_id: 2,
        role: 'COORDINATOR',
      });

      const result = await service.respondToRequest(2, 55, acceptDto);

      expect(result.status).toBe('ACTIVE');
    });

    it('throws ForbiddenException when the user lookup has no staff role', async () => {
      prisma.user.findUnique.mockResolvedValue({
        user_id: 2,
        role: 'APPLICANT',
      });

      await expect(service.respondToRequest(2, 55, acceptDto)).rejects.toThrow(
        new ForbiddenException(
          'Only the recipient grantor or staff can respond to this request.',
        ),
      );
    });

    it('accepts a pending request and marks it ACTIVE', async () => {
      await service.respondToRequest(4, 55, acceptDto);

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { conversation_id: 55 },
        data: { status: 'ACTIVE' },
        include: anyArg(Object),
      });
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'chat:request_responded',
        objectMatching({
          conversationId: 55,
          status: 'ACTIVE',
          respondedByUserId: 4,
        }),
      );
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({
          title: 'Message Request Update',
          message: expect.stringContaining('accepted'),
        }),
      );
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_55',
        'chat:request_responded',
        anyArg(Object),
      );
    });

    it('declines a pending request and marks it REJECTED', async () => {
      await service.respondToRequest(4, 55, rejectDto);

      expect(prisma.conversation.update).toHaveBeenCalledWith({
        where: { conversation_id: 55 },
        data: { status: 'REJECTED' },
        include: anyArg(Object),
      });
      expect(notifications.notifyUser).toHaveBeenCalledWith(
        7,
        objectMatching({
          message: expect.stringContaining('declined'),
        }),
      );
    });

    it('allows the recipient grantor to respond without further lookups', async () => {
      await service.respondToRequest(4, 55, acceptDto);

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });
  });
});
