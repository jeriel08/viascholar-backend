import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChatService } from './chat.service.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { QueryMessagesDto } from './dto/query-messages.dto.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    role: string;
    [key: string]: unknown;
  };
}

@ApiTags('Real-Time Chat (Scholar <-> Coordinator)')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('conversations')
  @ApiOperation({
    summary: 'Get existing or initiate a direct chat conversation',
  })
  createConversation(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateConversationDto,
  ) {
    return this.chatService.getOrCreateConversation(req.user.user_id, dto);
  }

  @Get('conversations')
  @ApiOperation({
    summary: 'List active conversations with unread counts and partner info',
  })
  getUserConversations(@Request() req: AuthenticatedRequest) {
    return this.chatService.getUserConversations(req.user.user_id);
  }

  @Get('conversations/:id/messages')
  @ApiOperation({
    summary:
      'Retrieve paginated messages for a conversation and mark incoming as read',
  })
  getMessages(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: QueryMessagesDto,
  ) {
    return this.chatService.getMessages(req.user.user_id, id, query);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({
    summary: 'Send a message in a conversation (broadcasts via WebSocket)',
  })
  sendMessage(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(req.user.user_id, id, dto);
  }

  @Patch('conversations/:id/read')
  @ApiOperation({
    summary: 'Explicitly mark conversation messages as read',
  })
  markAsRead(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.chatService.markAsRead(req.user.user_id, id);
  }
}
