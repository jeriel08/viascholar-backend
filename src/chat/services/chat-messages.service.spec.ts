import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ChatMessagesService } from './chat-messages.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsGateway } from '../../events/events.gateway.js';

// Asymmetric matchers are untyped; cast once so nested properties satisfy the linter.
const anyArg = (ctor: unknown) => expect.any(ctor) as unknown;
const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  conversation: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  message: {
    count: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  $transaction: vi.fn(),
});

const createEventsMock = () => ({
  emitToUser: vi.fn(),
  emitToRoom: vi.fn(),
});

const makeConversation = (overrides: Record<string, unknown> = {}) => ({
  conversation_id: 55,
  scholar_user_id: 7,
  coordinator_user_id: 2,
  subject: 'Scholar Support',
  status: 'ACTIVE',
  scholar: {
    user_id: 7,
    email: 'juan@example.com',
    role: 'SCHOLAR',
    scholar_profile: { first_name: 'Juan', last_name: 'Dela Cruz' },
  },
  coordinator: {
    user_id: 2,
    email: 'coordinator@example.com',
    role: 'COORDINATOR',
    employee: { first_name: 'Maria', last_name: 'Santos' },
  },
  ...overrides,
});

const makeMessage = (overrides: Record<string, unknown> = {}) => ({
  message_id: 100,
  conversation_id: 55,
  sender_user_id: 7,
  message_text: 'Hello',
  message_type: 'TEXT',
  metadata: null,
  is_read: false,
  sent_at: new Date('2026-08-01T00:00:00.000Z'),
  read_at: null,
  sender_user: {
    user_id: 7,
    role: 'SCHOLAR',
    scholar_profile: { first_name: 'Juan', last_name: 'Dela Cruz' },
    employee: null,
  },
  ...overrides,
});

describe('ChatMessagesService', () => {
  let service: ChatMessagesService;
  let prisma: ReturnType<typeof createPrismaMock>;
  let events: ReturnType<typeof createEventsMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    events = createEventsMock();

    prisma.conversation.findUnique.mockResolvedValue(makeConversation());
    prisma.conversation.update.mockResolvedValue(makeConversation());
    prisma.message.count.mockResolvedValue(2);
    prisma.message.findMany.mockResolvedValue([makeMessage()]);
    prisma.message.updateMany.mockResolvedValue({ count: 1 });
    prisma.message.create.mockResolvedValue(makeMessage());
    prisma.$transaction.mockImplementation(
      async (promises: Promise<unknown>[]) => Promise.all(promises),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatMessagesService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventsGateway, useValue: events },
      ],
    }).compile();

    service = module.get<ChatMessagesService>(ChatMessagesService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  describe('getMessages', () => {
    it('throws NotFoundException when the conversation is missing', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(service.getMessages(7, 999, {})).rejects.toThrow(
        new NotFoundException('Conversation ID 999 not found.'),
      );
    });

    it('throws ForbiddenException for non participants', async () => {
      await expect(service.getMessages(99, 55, {})).rejects.toThrow(
        new ForbiddenException(
          'You are not a participant in this conversation.',
        ),
      );
    });

    it('allows the coordinator participant to read messages', async () => {
      const result = await service.getMessages(2, 55, {});

      expect(result.messages).toHaveLength(1);
    });

    it('returns paginated messages with pagination metadata', async () => {
      prisma.message.count.mockResolvedValue(120);
      prisma.message.findMany.mockResolvedValue([makeMessage()]);

      const result = await service.getMessages(7, 55, {
        page: 2,
        limit: 25,
      });

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        objectMatching({ skip: 25, take: 25 }),
      );
      expect(result.total).toBe(120);
      expect(result.page).toBe(2);
      expect(result.limit).toBe(25);
    });

    it('marks incoming unread messages as read and notifies the partner', async () => {
      await service.getMessages(7, 55, {});

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        objectMatching({
          where: objectMatching({
            sender_user_id: { not: 7 },
            is_read: false,
          }),
          data: objectMatching({ is_read: true }),
        }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        2,
        'chat:messages_read',
        objectMatching({ conversationId: 55, readByUserId: 7 }),
      );
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_55',
        'chat:messages_read',
        anyArg(Object),
      );
    });

    it('does not notify when there were no unread messages', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      await service.getMessages(7, 55, {});

      expect(events.emitToUser).not.toHaveBeenCalled();
      expect(events.emitToRoom).not.toHaveBeenCalled();
    });

    it('maps a scholar sender to their profile name and role', async () => {
      const result = await service.getMessages(7, 55, {});

      expect(result.messages[0]).toEqual(
        objectMatching({
          message_id: 100,
          sender_name: 'Juan Dela Cruz',
          sender_role: 'SCHOLAR',
          message_text: 'Hello',
          message_type: 'TEXT',
        }),
      );
    });

    it('maps an employee sender to their employee profile when no scholar profile exists', async () => {
      prisma.message.findMany.mockResolvedValue([
        makeMessage({
          sender_user: {
            user_id: 2,
            role: 'COORDINATOR',
            scholar_profile: null,
            employee: { first_name: 'Maria', last_name: 'Santos' },
          },
        }),
      ]);
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.getMessages(2, 55, {});

      expect(result.messages[0].sender_name).toBe('Maria Santos');
      expect(result.messages[0].sender_role).toBe('COORDINATOR');
    });
  });

  describe('sendMessage', () => {
    it('throws NotFoundException when the conversation is missing', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(
        service.sendMessage(7, 999, { message_text: 'Hi' }),
      ).rejects.toThrow(
        new NotFoundException('Conversation ID 999 not found.'),
      );
    });

    it('throws ForbiddenException for non participants', async () => {
      await expect(
        service.sendMessage(99, 55, { message_text: 'Hi' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'You are not a participant in this conversation.',
        ),
      );
    });

    it('blocks messages while a request is pending approval', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        makeConversation({ status: 'PENDING_REQUEST' }),
      );

      await expect(
        service.sendMessage(7, 55, { message_text: 'Hi' }),
      ).rejects.toThrow(
        new ForbiddenException(
          'This conversation is pending approval. You cannot send messages until the request is accepted.',
        ),
      );
    });

    it('blocks messages in a rejected request', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        makeConversation({ status: 'REJECTED' }),
      );

      await expect(
        service.sendMessage(7, 55, { message_text: 'Hi' }),
      ).rejects.toThrow(
        new ForbiddenException('This message request was declined.'),
      );
    });

    it('creates the message and updates the conversation preview transactionally', async () => {
      await service.sendMessage(7, 55, {
        message_text: 'Hello',
      });

      expect(prisma.$transaction).toHaveBeenCalledWith([
        anyArg(Promise),
        anyArg(Promise),
      ]);
      expect(prisma.message.create).toHaveBeenCalledWith({
        data: {
          conversation_id: 55,
          sender_user_id: 7,
          message_text: 'Hello',
          is_read: false,
        },
      });
      expect(prisma.conversation.update).toHaveBeenCalledWith(
        objectMatching({
          data: objectMatching({
            last_message_preview: 'Hello',
          }),
        }),
      );
    });

    it('broadcasts the new message to the room and the recipient', async () => {
      prisma.message.create.mockImplementation(
        ({ data }: { data: { message_text: string } }) =>
          Promise.resolve({
            ...makeMessage(),
            message_text: data.message_text,
          }),
      );

      const result = await service.sendMessage(7, 55, {
        message_text: 'Hi there',
      });

      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_55',
        'chat:new_message',
        objectMatching({ message_text: 'Hi there' }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        2,
        'chat:new_message',
        objectMatching({ message_text: 'Hi there' }),
      );
      expect(result).toEqual(
        objectMatching({
          conversation_id: 55,
          sender_user_id: 7,
          sender_name: 'Juan Dela Cruz',
          message_text: 'Hi there',
        }),
      );
    });

    it('resolves the employee sender role and profile for a coordinator', async () => {
      prisma.conversation.findUnique.mockResolvedValue(
        makeConversation({
          scholar: {
            user_id: 7,
            role: 'SCHOLAR',
            scholar_profile: { first_name: 'Juan', last_name: 'Dela Cruz' },
          },
          coordinator: {
            user_id: 2,
            role: 'COORDINATOR',
            employee: { first_name: 'Maria', last_name: 'Santos' },
          },
        }),
      );

      const result = await service.sendMessage(2, 55, {
        message_text: 'Hello',
      });

      expect(result).toEqual(
        objectMatching({
          sender_user_id: 2,
          sender_role: 'COORDINATOR',
          sender_name: 'Maria Santos',
        }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        7,
        'chat:new_message',
        anyArg(Object),
      );
    });
  });

  describe('markAsRead', () => {
    it('throws NotFoundException when the conversation is missing', async () => {
      prisma.conversation.findUnique.mockResolvedValue(null);

      await expect(service.markAsRead(7, 999)).rejects.toThrow(
        new NotFoundException('Conversation ID 999 not found.'),
      );
    });

    it('throws ForbiddenException for non participants', async () => {
      await expect(service.markAsRead(99, 55)).rejects.toThrow(
        new ForbiddenException(
          'You are not a participant in this conversation.',
        ),
      );
    });

    it('marks incoming messages as read and notifies the partner', async () => {
      const result = await service.markAsRead(7, 55);

      expect(prisma.message.updateMany).toHaveBeenCalledWith(
        objectMatching({
          where: objectMatching({
            sender_user_id: { not: 7 },
            is_read: false,
          }),
          data: objectMatching({ is_read: true }),
        }),
      );
      expect(events.emitToUser).toHaveBeenCalledWith(
        2,
        'chat:messages_read',
        objectMatching({ conversationId: 55 }),
      );
      expect(events.emitToRoom).toHaveBeenCalledWith(
        'conversation_55',
        'chat:messages_read',
        anyArg(Object),
      );
      expect(result).toEqual({ success: true, count: 1 });
    });

    it('does not emit notifications when nothing was updated', async () => {
      prisma.message.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.markAsRead(7, 55);

      expect(events.emitToUser).not.toHaveBeenCalled();
      expect(events.emitToRoom).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, count: 0 });
    });
  });
});
