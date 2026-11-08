import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ChatService } from './chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { ChatMessagesService } from './services/chat-messages.service.js';
import { ChatRequestsService } from './services/chat-requests.service.js';
import type { QueryMessagesDto } from './dto/query-messages.dto.js';
import type { RequestGrantorDto } from './dto/request-grantor.dto.js';
import type { RespondRequestDto } from './dto/respond-request.dto.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  user: {
    findUnique: vi.fn(),
  },
  conversation: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
  },
  message: {
    count: vi.fn(),
  },
});

const createEventsMock = () => ({
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
});

const createMessagesServiceMock = () => ({
  getMessages: vi.fn(),
  sendMessage: vi.fn(),
  markAsRead: vi.fn(),
});

const createRequestsServiceMock = () => ({
  getCoordinators: vi.fn(),
  getGrantors: vi.fn(),
  requestGrantorAccess: vi.fn(),
  respondToRequest: vi.fn(),
});

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  user_id: 7,
  email: 'juan@example.com',
  role: 'SCHOLAR',
  is_active: true,
  scholar_profile: {
    profile_id: 11,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
  },
  employee: null,
  ...overrides,
});

const makeEmployeeUser = (overrides: Record<string, unknown> = {}) => ({
  ...makeUser({
    user_id: 2,
    email: 'coordinator@example.com',
    role: 'COORDINATOR',
    scholar_profile: null,
    employee: {
      employee_id: 3,
      first_name: 'Maria',
      last_name: 'Santos',
      title: 'Scholarship Coordinator',
    },
  }),
  ...overrides,
});

const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  conversation_id: 55,
  scholar_user_id: 7,
  coordinator_user_id: 2,
  subject: 'Scholar Support',
  status: 'ACTIVE',
  request_note: null,
  last_message_at: null,
  last_message_preview: null,
  scholar: {
    user_id: 7,
    email: 'juan@example.com',
    role: 'SCHOLAR',
    scholar_profile: {
      first_name: 'Juan',
      last_name: 'Dela Cruz',
      avatar_url: null,
    },
  },
  coordinator: {
    user_id: 2,
    email: 'coordinator@example.com',
    role: 'COORDINATOR',
    employee: {
      first_name: 'Maria',
      last_name: 'Santos',
      title: 'Scholarship Coordinator',
      avatar_url: null,
    },
  },
  ...overrides,
});

describe('ChatService', () => {
  let service: ChatService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let events: ReturnType<typeof createEventsMock>;
  let messagesService: ReturnType<typeof createMessagesServiceMock>;
  let requestsService: ReturnType<typeof createRequestsServiceMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    events = createEventsMock();
    messagesService = createMessagesServiceMock();
    requestsService = createRequestsServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsGateway, useValue: events },
        { provide: ChatMessagesService, useValue: messagesService },
        { provide: ChatRequestsService, useValue: requestsService },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getOrCreateConversation', () => {
    it('rejects a conversation with yourself', async () => {
      await expect(
        service.getOrCreateConversation(7, {
          target_user_id: 7,
        }),
      ).rejects.toThrow(
        new BadRequestException(
          'You cannot create a conversation with yourself.',
        ),
      );
    });

    it('throws NotFoundException when either user does not exist', async () => {
      prisma.user.findUnique.mockResolvedValueOnce(null);

      await expect(
        service.getOrCreateConversation(7, {
          target_user_id: 2,
        }),
      ).rejects.toThrow(new NotFoundException('User not found.'));
    });

    it('creates a new active conversation between a scholar and coordinator', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeEmployeeUser());
      prisma.conversation.findUnique.mockResolvedValue(null);
      const created = makeConversation({ status: 'ACTIVE' });
      prisma.conversation.create.mockResolvedValue(created);

      const result = await service.getOrCreateConversation(7, {
        target_user_id: 2,
      });

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: {
          scholar_user_id: 7,
          coordinator_user_id: 2,
          subject: 'Scholar Support',
          status: 'ACTIVE',
        },
        include: anyArg(Object),
      });
      expect(result).toBe(created);
    });

    it('creates a new pending request when a scholar targets a grantor', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(
          makeEmployeeUser({ role: 'GRANTOR', user_id: 4 }),
        );
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue(
        makeConversation({
          status: 'PENDING_REQUEST',
          subject: 'Scholar Message Request',
        }),
      );

      const result = await service.getOrCreateConversation(7, {
        target_user_id: 4,
      });

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: {
          scholar_user_id: 7,
          coordinator_user_id: 4,
          subject: 'Scholar Message Request',
          status: 'PENDING_REQUEST',
        },
        include: anyArg(Object),
      });
      expect(result.subject).toBe('Scholar Message Request');
    });

    it('reuses the provided subject instead of deriving one', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeEmployeeUser());
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue(
        makeConversation({ subject: 'Custom subject' }),
      );

      await service.getOrCreateConversation(7, {
        target_user_id: 2,
        subject: 'Custom subject',
      });

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: objectMatching({ subject: 'Custom subject' }),
        include: anyArg(Object),
      });
    });

    it('assigns staff as coordinator regardless of argument order', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeEmployeeUser({ role: 'COORDINATOR' }))
        .mockResolvedValueOnce(makeUser());
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue(makeConversation());

      await service.getOrCreateConversation(2, {
        target_user_id: 7,
      });

      expect(prisma.conversation.create).toHaveBeenCalledWith({
        data: objectMatching({
          scholar_user_id: 7,
          coordinator_user_id: 2,
        }),
        include: anyArg(Object),
      });
    });

    it('returns the existing conversation without mutating it', async () => {
      const existing = makeConversation();
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeEmployeeUser());
      prisma.conversation.findUnique.mockResolvedValue(existing);

      const result = await service.getOrCreateConversation(7, {
        target_user_id: 2,
      });

      expect(result).toBe(existing);
      expect(prisma.conversation.create).not.toHaveBeenCalled();
    });

    it('notifies the target when a new conversation is created', async () => {
      prisma.user.findUnique
        .mockResolvedValueOnce(makeUser())
        .mockResolvedValueOnce(makeEmployeeUser());
      prisma.conversation.findUnique.mockResolvedValue(null);
      prisma.conversation.create.mockResolvedValue(
        makeConversation({ subject: 'Scholar Support' }),
      );

      await service.getOrCreateConversation(7, {
        target_user_id: 2,
      });

      expect(events.emitToUser).toHaveBeenCalledWith(
        2,
        'chat:conversation_created',
        objectMatching({
          conversationId: 55,
          partnerUserId: 7,
          subject: 'Scholar Support',
        }),
      );
    });
  });

  describe('getUserConversations', () => {
    it('attaches unread counts and partner info from the scholar perspective', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        makeConversation({ conversation_id: 55 }),
      ]);
      prisma.message.count.mockResolvedValue(3);

      const [conversation] = await service.getUserConversations(7);

      expect(prisma.conversation.findMany).toHaveBeenCalledWith(
        objectMatching({
          where: {
            OR: [{ scholar_user_id: 7 }, { coordinator_user_id: 7 }],
          },
          orderBy: { updated_at: 'desc' },
        }),
      );
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: {
          conversation_id: 55,
          sender_user_id: { not: 7 },
          is_read: false,
        },
      });
      expect(conversation).toEqual({
        conversation_id: 55,
        subject: 'Scholar Support',
        status: 'ACTIVE',
        request_note: null,
        last_message_at: null,
        last_message_preview: null,
        unread_count: 3,
        partner: {
          user_id: 2,
          email: 'coordinator@example.com',
          role: 'COORDINATOR',
          first_name: 'Maria',
          last_name: 'Santos',
          avatar_url: null,
        },
      });
    });

    it('attaches the partner info from the coordinator perspective', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        makeConversation({ conversation_id: 55 }),
      ]);
      prisma.message.count.mockResolvedValue(1);

      const [conversation] = await service.getUserConversations(2);

      expect(conversation).toEqual(
        objectMatching({
          partner: objectMatching({
            user_id: 7,
            first_name: 'Juan',
            last_name: 'Dela Cruz',
          }),
        }),
      );
      expect(prisma.message.count).toHaveBeenCalledWith({
        where: {
          conversation_id: 55,
          sender_user_id: { not: 2 },
          is_read: false,
        },
      });
    });

    it('falls back to empty partner name fields when profile info is missing', async () => {
      prisma.conversation.findMany.mockResolvedValue([
        makeConversation({
          coordinator: {
            user_id: 2,
            email: 'coordinator@example.com',
            role: 'COORDINATOR',
            employee: null,
          },
        }),
      ]);
      prisma.message.count.mockResolvedValue(0);

      const [conversation] = await service.getUserConversations(7);

      expect(conversation.partner.first_name).toBe('');
      expect(conversation.partner.avatar_url).toBeNull();
    });

    it('returns an empty list when the user has no conversations', async () => {
      prisma.conversation.findMany.mockResolvedValue([]);

      await expect(service.getUserConversations(7)).resolves.toEqual([]);
    });
  });

  describe('delegates to the message and request services', () => {
    it('delegates getMessages to the messages service', async () => {
      const query = { page: 2, limit: 10 } as QueryMessagesDto;
      const expected = { messages: [] };
      messagesService.getMessages.mockReturnValue(expected);

      const result = await service.getMessages(7, 55, query);

      expect(messagesService.getMessages).toHaveBeenCalledWith(7, 55, query);
      expect(result).toBe(expected);
    });

    it('delegates sendMessage to the messages service', async () => {
      const dto = { message_text: 'Hello' };
      const expected = { message_id: 1 };
      messagesService.sendMessage.mockReturnValue(expected);

      const result = await service.sendMessage(7, 55, dto);

      expect(messagesService.sendMessage).toHaveBeenCalledWith(7, 55, dto);
      expect(result).toBe(expected);
    });

    it('delegates markAsRead to the messages service', async () => {
      const expected = { success: true };
      messagesService.markAsRead.mockReturnValue(expected);

      const result = await service.markAsRead(7, 55);

      expect(messagesService.markAsRead).toHaveBeenCalledWith(7, 55);
      expect(result).toBe(expected);
    });

    it('delegates getCoordinators to the requests service', () => {
      const expected = [{ user_id: 2 }];
      requestsService.getCoordinators.mockReturnValue(expected);

      const result = service.getCoordinators(7);

      expect(requestsService.getCoordinators).toHaveBeenCalledWith(7);
      expect(result).toBe(expected);
    });

    it('delegates getGrantors to the requests service', () => {
      const expected = [{ user_id: 4 }];
      requestsService.getGrantors.mockReturnValue(expected);

      const result = service.getGrantors(7);

      expect(requestsService.getGrantors).toHaveBeenCalledWith(7);
      expect(result).toBe(expected);
    });

    it('delegates requestGrantorAccess to the requests service', () => {
      const dto = { grantor_user_id: 4, reason: 'r' } as RequestGrantorDto;
      const expected = { conversation_id: 60 };
      requestsService.requestGrantorAccess.mockReturnValue(expected);

      const result = service.requestGrantorAccess(7, dto);

      expect(requestsService.requestGrantorAccess).toHaveBeenCalledWith(7, dto);
      expect(result).toBe(expected);
    });

    it('delegates respondToRequest to the requests service', () => {
      const dto = { action: 'ACCEPT' } as RespondRequestDto;
      const expected = { status: 'ACTIVE' };
      requestsService.respondToRequest.mockReturnValue(expected);

      const result = service.respondToRequest(2, 55, dto);

      expect(requestsService.respondToRequest).toHaveBeenCalledWith(2, 55, dto);
      expect(result).toBe(expected);
    });
  });
});
