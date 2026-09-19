import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { RequestGrantorDto } from '../dto/request-grantor.dto.js';
import { RespondRequestDto } from '../dto/respond-request.dto.js';

@Injectable()
export class ChatRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  // Get all available coordinators for scholar directory
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

  // Get all available grantors with scholar request status
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
        status: conv ? conv.status : 'NONE',
        request_note: conv?.request_note || null,
      };
    });
  }

  // Request message access to a grantor
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

  // Respond to message request (Grantor accepts or declines)
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
