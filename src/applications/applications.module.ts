import { Module } from '@nestjs/common';
import { ApplicationsService } from './applications.service.js';
import { ApplicationsController } from './applications.controller.js';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module.js';

@Module({
  imports: [GoogleCalendarModule],
  providers: [ApplicationsService],
  controllers: [ApplicationsController],
})
export class ApplicationsModule {}

