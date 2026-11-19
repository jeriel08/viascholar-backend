import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DeadlinesController } from './deadlines.controller.js';
import { DeadlinesService } from './deadlines.service.js';

@Module({
  imports: [SettingsModule, ChatModule],
  controllers: [DeadlinesController],
  providers: [DeadlinesService],
  exports: [DeadlinesService],
})
export class DeadlinesModule {}
