import { Module } from '@nestjs/common';
import { ForumService } from './forum.service.js';
import { ForumController } from './forum.controller.js';

@Module({
  controllers: [ForumController],
  providers: [ForumService],
  exports: [ForumService],
})
export class ForumModule {}
