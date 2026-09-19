import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { SendMessageDto } from '../dto/send-message.dto.js';
import { QueryMessagesDto } from '../dto/query-messages.dto.js';

@Injectable()
export class ChatMessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // Retrieve paginated messages for a conversation and mark incoming unread as read
  async getMessages(
    userId: number,
    conversationId: number,
    query: QueryMessagesDto,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { conversation_id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(
        `Conversation ID ${conversationId} not found.`,
      );
    }

    if (
      conversation.scholar_user_id !== userId &&
      conversation.coordinator_user_id !== userId
    ) {
      throw new ForbiddenException(
        'You are not a participant in this conversation.',
      );
    }

    const page = query.page || 1;
    const limit = query.limit || 50;
    const skip = (page - 1) * limit;

    const [total, messages] = await Promise.all([
      this.prisma.message.count({
        where: { conversation_id: conversationId },
      }),
      this.prisma.message.findMany({
        where: { conversation_id: conversationId },
        orderBy: { sent_at: 'asc' },
        skip,
        take: limit,
        include: {
          sender_user: {
            include: { scholar_profile: true, employee: true },
          },
        },
      }),
    ]);

    // Automatically mark incoming unread messages as read
    const unreadUpdated = await this.prisma.message.updateMany({
      where: {
        conversation_id: conversationId,
        sender_user_id: { not: userId },
        is_read: false,
      },
      data: {
        is_read: true,
        read_at: new Date(),
      },
    });

    if (unreadUpdated.count > 0) {
      const partnerUserId =
        conversation.scholar_user_id === userId
          ? conversation.coordinator_user_id
          : conversation.scholar_user_id;

      this.eventsGateway.emitToUser(partnerUserId, 'chat:messages_read', {
        conversationId,
        readByUserId: userId,
        readAt: new Date().toISOString(),
      });
      this.eventsGateway.emitToRoom(
        `conversation_${conversationId}`,
        'chat:messages_read',
        {
          conversationId,
          readByUserId: userId,
          readAt: new Date().toISOString(),
        },
      );
    }

    const formattedMessages = messages.map((m) => {
      const profile = m.sender_user.scholar_profile || m.sender_user.employee;
      return {
        message_id: m.message_id,
        conversation_id: m.conversation_id,
        sender_user_id: m.sender_user_id,
        sender_name:
          `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim() ||
          'User',
        sender_role: m.sender_user.role,
        message_text: m.message_text,
        is_read: m.is_read,
        sent_at: m.sent_at,
        read_at: m.read_at,
      };
    });

    return {
      conversation_id: conversationId,
      total,
      page,
      limit,
      messages: formattedMessages,
    };
  }

  // Send a new message in an active conversation
  async sendMessage(
    senderUserId: number,
    conversationId: number,
    dto: SendMessageDto,
  ) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { conversation_id: conversationId },
      include: {
        scholar: { include: { scholar_profile: true } },
        coordinator: { include: { employee: true } },
      },
    });

    if (!conversation) {
      throw new NotFoundException(
        `Conversation ID ${conversationId} not found.`,
      );
    }

    if (
      conversation.scholar_user_id !== senderUserId &&
      conversation.coordinator_user_id !== senderUserId
    ) {
      throw new ForbiddenException(
        'You are not a participant in this conversation.',
      );
    }

    if (conversation.status === 'PENDING_REQUEST') {
      throw new ForbiddenException(
        'This conversation is pending approval. You cannot send messages until the request is accepted.',
      );
    }

    if (conversation.status === 'REJECTED') {
      throw new ForbiddenException('This message request was declined.');
    }

    const partnerUserId =
      conversation.scholar_user_id === senderUserId
        ? conversation.coordinator_user_id
        : conversation.scholar_user_id;

    const isScholar = conversation.scholar_user_id === senderUserId;
    const senderRole = isScholar
      ? conversation.scholar.role
      : conversation.coordinator.role;
    const senderProfile = isScholar
      ? conversation.scholar.scholar_profile
      : conversation.coordinator.employee;
    const senderName =
      `${senderProfile?.first_name || ''} ${senderProfile?.last_name || ''}`.trim() ||
      'User';

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversation_id: conversationId,
          sender_user_id: senderUserId,
          message_text: dto.message_text,
          is_read: false,
        },
      }),
      this.prisma.conversation.update({
        where: { conversation_id: conversationId },
        data: {
          last_message_at: new Date(),
          last_message_preview: dto.message_text.slice(0, 150),
          updated_at: new Date(),
        },
      }),
    ]);

    const messagePayload = {
      message_id: message.message_id,
      conversation_id: conversationId,
      sender_user_id: senderUserId,
      sender_name: senderName,
      sender_role: senderRole,
      message_text: message.message_text,
      is_read: false,
      sent_at: message.sent_at,
    };

    // Broadcast to the conversation room and directly to the recipient's personal room
    this.eventsGateway.emitToRoom(
      `conversation_${conversationId}`,
      'chat:new_message',
      messagePayload,
    );
    this.eventsGateway.emitToUser(
      partnerUserId,
      'chat:new_message',
      messagePayload,
    );

    return messagePayload;
  }

  // Mark messages in a conversation as read
  async markAsRead(userId: number, conversationId: number) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { conversation_id: conversationId },
    });

    if (!conversation) {
      throw new NotFoundException(
        `Conversation ID ${conversationId} not found.`,
      );
    }

    if (
      conversation.scholar_user_id !== userId &&
      conversation.coordinator_user_id !== userId
    ) {
      throw new ForbiddenException(
        'You are not a participant in this conversation.',
      );
    }

    const updated = await this.prisma.message.updateMany({
      where: {
        conversation_id: conversationId,
        sender_user_id: { not: userId },
        is_read: false,
      },
      data: {
        is_read: true,
        read_at: new Date(),
      },
    });

    if (updated.count > 0) {
      const partnerUserId =
        conversation.scholar_user_id === userId
          ? conversation.coordinator_user_id
          : conversation.scholar_user_id;

      this.eventsGateway.emitToUser(partnerUserId, 'chat:messages_read', {
        conversationId,
        readByUserId: userId,
        readAt: new Date().toISOString(),
      });
      this.eventsGateway.emitToRoom(
        `conversation_${conversationId}`,
        'chat:messages_read',
        {
          conversationId,
          readByUserId: userId,
          readAt: new Date().toISOString(),
        },
      );
    }

    return { success: true, count: updated.count };
  }
}
