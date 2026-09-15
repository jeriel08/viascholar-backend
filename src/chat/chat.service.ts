import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { QueryMessagesDto } from './dto/query-messages.dto.js';
import { RequestGrantorDto } from './dto/request-grantor.dto.js';
import { RespondRequestDto } from './dto/respond-request.dto.js';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // 1. Get or initiate a 1-on-1 direct conversation between a Scholar and a Coordinator
  async getOrCreateConversation(
    currentUserId: number,
    dto: CreateConversationDto,
  ) {
    if (currentUserId === dto.target_user_id) {
      throw new BadRequestException(
        'You cannot create a conversation with yourself.',
      );
    }

    const [currentUser, targetUser] = await Promise.all([
      this.prisma.user.findUnique({
        where: { user_id: currentUserId },
        include: { scholar_profile: true, employee: true },
      }),
      this.prisma.user.findUnique({
        where: { user_id: dto.target_user_id },
        include: { scholar_profile: true, employee: true },
      }),
    ]);

    if (!currentUser || !targetUser) {
      throw new NotFoundException('User not found.');
    }

    // Determine who is scholar and who is coordinator
    const staffRoles = ['COORDINATOR', 'ADMIN', 'GRANTOR'];
    let scholarUserId: number;
    let coordinatorUserId: number;

    if (staffRoles.includes(currentUser.role)) {
      coordinatorUserId = currentUser.user_id;
      scholarUserId = targetUser.user_id;
    } else {
      scholarUserId = currentUser.user_id;
      coordinatorUserId = targetUser.user_id;
    }

    // Search for existing conversation
    let conversation = await this.prisma.conversation.findUnique({
      where: {
        scholar_user_id_coordinator_user_id: {
          scholar_user_id: scholarUserId,
          coordinator_user_id: coordinatorUserId,
        },
      },
      include: {
        scholar: {
          include: { scholar_profile: true },
        },
        coordinator: {
          include: { employee: true },
        },
      },
    });

    if (!conversation) {
      const isTargetGrantor = targetUser.role === 'GRANTOR';
      const isCurrentScholar = currentUser.role === 'SCHOLAR';
      const initialStatus =
        isCurrentScholar && isTargetGrantor ? 'PENDING_REQUEST' : 'ACTIVE';

      conversation = await this.prisma.conversation.create({
        data: {
          scholar_user_id: scholarUserId,
          coordinator_user_id: coordinatorUserId,
          subject:
            dto.subject ||
            (isTargetGrantor ? 'Scholar Message Request' : 'Scholar Support'),
          status: initialStatus,
        },
        include: {
          scholar: {
            include: { scholar_profile: true },
          },
          coordinator: {
            include: { employee: true },
          },
        },
      });

      // Notify the target user of a new conversation
      this.eventsGateway.emitToUser(
        dto.target_user_id,
        'chat:conversation_created',
        {
          conversationId: conversation.conversation_id,
          partnerUserId: currentUserId,
          subject: conversation.subject,
        },
      );
    }

    return conversation;
  }

  // 2. List all conversations for the authenticated user with unread counts and partner info
  async getUserConversations(userId: number) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        OR: [{ scholar_user_id: userId }, { coordinator_user_id: userId }],
      },
      orderBy: {
        updated_at: 'desc',
      },
      include: {
        scholar: {
          include: { scholar_profile: true },
        },
        coordinator: {
          include: { employee: true },
        },
        messages: {
          orderBy: { sent_at: 'desc' },
          take: 1,
        },
      },
    });

    // Compute unread count for each conversation
    const result = await Promise.all(
      conversations.map(async (conv) => {
        const unreadCount = await this.prisma.message.count({
          where: {
            conversation_id: conv.conversation_id,
            sender_user_id: { not: userId },
            is_read: false,
          },
        });

        const isScholar = conv.scholar_user_id === userId;
        const partnerUser = isScholar ? conv.coordinator : conv.scholar;
        const partnerProfile = isScholar
          ? conv.coordinator.employee
          : conv.scholar.scholar_profile;

        return {
          conversation_id: conv.conversation_id,
          subject: conv.subject,
          status: conv.status,
          request_note: conv.request_note,
          last_message_at: conv.last_message_at,
          last_message_preview: conv.last_message_preview,
          unread_count: unreadCount,
          partner: {
            user_id: partnerUser.user_id,
            email: partnerUser.email,
            role: partnerUser.role,
            first_name: partnerProfile?.first_name || '',
            last_name: partnerProfile?.last_name || '',
            avatar_url: partnerProfile?.avatar_url || null,
          },
        };
      }),
    );

    return result;
  }

  // 3. Retrieve paginated messages for a conversation
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

  // 4. Send a new message in an active conversation
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

  // 5. Mark messages in a conversation as read
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

  // 6. Get all available coordinators for scholar directory
  async getCoordinators(currentUserId: number) {
    const coordinators = await this.prisma.user.findMany({
      where: {
        role: 'COORDINATOR',
        is_active: true,
      },
      include: { employee: true },
      orderBy: { employee: { first_name: 'asc' } },
    });

    const existingConvos = await this.prisma.conversation.findMany({
      where: {
        scholar_user_id: currentUserId,
        coordinator_user_id: { in: coordinators.map((c) => c.user_id) },
      },
    });

    const convMap = new Map(
      existingConvos.map((c) => [c.coordinator_user_id, c]),
    );

    return coordinators.map((c) => {
      const conv = convMap.get(c.user_id);
      return {
        user_id: c.user_id,
        email: c.email,
        role: c.role,
        first_name: c.employee?.first_name || '',
        last_name: c.employee?.last_name || '',
        title: c.employee?.title || 'Scholarship Coordinator',
        department: c.employee?.department || 'Scholarship Office',
        avatar_url: c.employee?.avatar_url || null,
        conversation_id: conv?.conversation_id || null,
        status: conv?.status || 'ACTIVE',
      };
    });
  }

  // 7. Get all available grantors with scholar request status
  async getGrantors(currentUserId: number) {
    const grantors = await this.prisma.user.findMany({
      where: {
        role: 'GRANTOR',
        is_active: true,
      },
      include: { employee: true },
      orderBy: { employee: { first_name: 'asc' } },
    });

    const existingConvos = await this.prisma.conversation.findMany({
      where: {
        scholar_user_id: currentUserId,
        coordinator_user_id: { in: grantors.map((g) => g.user_id) },
      },
    });

    const convMap = new Map(
      existingConvos.map((c) => [c.coordinator_user_id, c]),
    );

    return grantors.map((g) => {
      const conv = convMap.get(g.user_id);
      return {
        user_id: g.user_id,
        email: g.email,
        role: g.role,
        first_name: g.employee?.first_name || '',
        last_name: g.employee?.last_name || '',
        title: g.employee?.title || 'Scholarship Grantor',
        department: g.employee?.department || 'Partner Organization',
        avatar_url: g.employee?.avatar_url || null,
        conversation_id: conv?.conversation_id || null,
        status: conv ? conv.status : 'NONE', // 'NONE', 'PENDING_REQUEST', 'ACTIVE', 'REJECTED'
        request_note: conv?.request_note || null,
      };
    });
  }

  // 8. Request message access to a grantor
  async requestGrantorAccess(scholarUserId: number, dto: RequestGrantorDto) {
    if (scholarUserId === dto.grantor_user_id) {
      throw new BadRequestException('Invalid target user.');
    }

    const grantor = await this.prisma.user.findUnique({
      where: { user_id: dto.grantor_user_id },
      include: { employee: true },
    });

    if (!grantor || grantor.role !== 'GRANTOR') {
      throw new NotFoundException('Grantor not found.');
    }

    let conversation = await this.prisma.conversation.findUnique({
      where: {
        scholar_user_id_coordinator_user_id: {
          scholar_user_id: scholarUserId,
          coordinator_user_id: dto.grantor_user_id,
        },
      },
      include: {
        scholar: { include: { scholar_profile: true } },
        coordinator: { include: { employee: true } },
      },
    });

    if (conversation) {
      if (conversation.status === 'ACTIVE') {
        return conversation;
      }
      conversation = await this.prisma.conversation.update({
        where: { conversation_id: conversation.conversation_id },
        data: {
          status: 'PENDING_REQUEST',
          request_note: dto.reason,
          subject: dto.subject || 'Scholar Message Request',
        },
        include: {
          scholar: { include: { scholar_profile: true } },
          coordinator: { include: { employee: true } },
        },
      });
    } else {
      conversation = await this.prisma.conversation.create({
        data: {
          scholar_user_id: scholarUserId,
          coordinator_user_id: dto.grantor_user_id,
          status: 'PENDING_REQUEST',
          request_note: dto.reason,
          subject: dto.subject || 'Scholar Message Request',
        },
        include: {
          scholar: { include: { scholar_profile: true } },
          coordinator: { include: { employee: true } },
        },
      });
    }

    const scholarProfile = conversation.scholar.scholar_profile;
    const scholarName =
      `${scholarProfile?.first_name || ''} ${scholarProfile?.last_name || ''}`.trim() ||
      'Scholar';

    // Notify the grantor via WebSocket
    this.eventsGateway.emitToUser(dto.grantor_user_id, 'chat:message_request', {
      conversationId: conversation.conversation_id,
      scholarUserId,
      scholarName,
      subject: conversation.subject,
      reason: dto.reason,
    });

    return conversation;
  }

  // 9. Respond to message request (Grantor accepts or declines)
  async respondToRequest(
    userId: number,
    conversationId: number,
    dto: RespondRequestDto,
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

    if (conversation.coordinator_user_id !== userId) {
      const user = await this.prisma.user.findUnique({
        where: { user_id: userId },
      });
      if (!user || !['ADMIN', 'COORDINATOR', 'GRANTOR'].includes(user.role)) {
        throw new ForbiddenException(
          'Only the recipient grantor or staff can respond to this request.',
        );
      }
    }

    const newStatus = dto.action === 'ACCEPT' ? 'ACTIVE' : 'REJECTED';

    const updated = await this.prisma.conversation.update({
      where: { conversation_id: conversationId },
      data: { status: newStatus },
      include: {
        scholar: { include: { scholar_profile: true } },
        coordinator: { include: { employee: true } },
      },
    });

    // Notify the scholar in real-time
    this.eventsGateway.emitToUser(
      conversation.scholar_user_id,
      'chat:request_responded',
      {
        conversationId,
        status: newStatus,
        respondedByUserId: userId,
      },
    );

    this.eventsGateway.emitToRoom(
      `conversation_${conversationId}`,
      'chat:request_responded',
      {
        conversationId,
        status: newStatus,
        respondedByUserId: userId,
      },
    );

    return updated;
  }
}
