import { Module } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller.js';
import { DocumentsModule } from '../documents/documents.module.js';

@Module({
  imports: [DocumentsModule],
  controllers: [WebhooksController],
})
export class WebhooksModule {}

