import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import type { CreateConversationDto } from './dto/create-conversation.dto.js';
import type { QueryMessagesDto } from './dto/query-messages.dto.js';
import type { RequestGrantorDto } from './dto/request-grantor.dto.js';
import type { RespondRequestDto } from './dto/respond-request.dto.js';

const makeRequest = (userId = 7, role = 'SCHOLAR') => ({
  user: { user_id: userId, role },
});

describe('ChatController', () => {
  let controller: ChatController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      getOrCreateConversation: vi.fn(),
      getUserConversations: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      markAsRead: vi.fn(),
      getCoordinators: vi.fn(),
      getGrantors: vi.fn(),
      requestGrantorAccess: vi.fn(),
      respondToRequest: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [
        {
          provide: ChatService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<ChatController>(ChatController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates createConversation with the authenticated user', () => {
    const request = makeRequest();
    const dto = { target_user_id: 2 } as CreateConversationDto;
    serviceMock.getOrCreateConversation.mockReturnValue({
      conversation_id: 55,
    });

    const result = controller.createConversation(request, dto);

    expect(serviceMock.getOrCreateConversation).toHaveBeenCalledWith(7, dto);
    expect(result).toEqual({ conversation_id: 55 });
  });

  it('delegates getUserConversations with the authenticated user', () => {
    serviceMock.getUserConversations.mockReturnValue([]);

    void controller.getUserConversations(makeRequest());

    expect(serviceMock.getUserConversations).toHaveBeenCalledWith(7);
  });

  it('delegates getMessages with the parsed id and query', () => {
    const query = { page: 2, limit: 25 } as QueryMessagesDto;
    serviceMock.getMessages.mockReturnValue({ messages: [] });

    void controller.getMessages(makeRequest(), 55, query);

    expect(serviceMock.getMessages).toHaveBeenCalledWith(7, 55, query);
  });

  it('delegates sendMessage with the parsed id, sender, and DTO', () => {
    const dto = { message_text: 'Hello' };
    void controller.sendMessage(makeRequest(), 55, dto);

    expect(serviceMock.sendMessage).toHaveBeenCalledWith(7, 55, dto);
  });

  it('delegates markAsRead with the parsed id and authenticated user', () => {
    void controller.markAsRead(makeRequest(), 55);

    expect(serviceMock.markAsRead).toHaveBeenCalledWith(7, 55);
  });

  it('delegates getCoordinators with the authenticated user', () => {
    void controller.getCoordinators(makeRequest());

    expect(serviceMock.getCoordinators).toHaveBeenCalledWith(7);
  });

  it('delegates getGrantors with the authenticated user', () => {
    void controller.getGrantors(makeRequest());

    expect(serviceMock.getGrantors).toHaveBeenCalledWith(7);
  });

  it('delegates requestGrantorAccess with the authenticated user and DTO', () => {
    const dto = {
      grantor_user_id: 4,
      reason: 'Need updates on my application',
    } as RequestGrantorDto;
    void controller.requestGrantorAccess(makeRequest(), dto);

    expect(serviceMock.requestGrantorAccess).toHaveBeenCalledWith(7, dto);
  });

  it('delegates respondToRequest with the parsed id, user, and DTO', () => {
    const dto = { action: 'ACCEPT' } as RespondRequestDto;
    void controller.respondToRequest(makeRequest(4, 'GRANTOR'), 55, dto);

    expect(serviceMock.respondToRequest).toHaveBeenCalledWith(4, 55, dto);
  });
});
