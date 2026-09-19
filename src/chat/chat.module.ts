import { Module } from '@nestjs/common';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { ChatMessagesService } from './services/chat-messages.service.js';
import { ChatRequestsService } from './services/chat-requests.service.js';

@Module({
  controllers: [ChatController],
  providers: [ChatService, ChatMessagesService, ChatRequestsService],
  exports: [ChatService, ChatMessagesService, ChatRequestsService],
})
export class ChatModule {}
