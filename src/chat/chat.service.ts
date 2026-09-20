import {
  BadRequestException,
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
import { ChatMessagesService } from './services/chat-messages.service.js';
import { ChatRequestsService } from './services/chat-requests.service.js';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
    private readonly messagesService: ChatMessagesService,
    private readonly requestsService: ChatRequestsService,
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

  // Delegated message operations
  getMessages(userId: number, conversationId: number, query: QueryMessagesDto) {
    return this.messagesService.getMessages(userId, conversationId, query);
  }

  sendMessage(
    senderUserId: number,
    conversationId: number,
    dto: SendMessageDto,
  ) {
    return this.messagesService.sendMessage(senderUserId, conversationId, dto);
  }

  markAsRead(userId: number, conversationId: number) {
    return this.messagesService.markAsRead(userId, conversationId);
  }

  // Delegated directory & request operations
  getCoordinators(currentUserId: number) {
    return this.requestsService.getCoordinators(currentUserId);
  }

  getGrantors(currentUserId: number) {
    return this.requestsService.getGrantors(currentUserId);
  }

  requestGrantorAccess(scholarUserId: number, dto: RequestGrantorDto) {
    return this.requestsService.requestGrantorAccess(scholarUserId, dto);
  }

  respondToRequest(
    userId: number,
    conversationId: number,
    dto: RespondRequestDto,
  ) {
    return this.requestsService.respondToRequest(userId, conversationId, dto);
  }
}
