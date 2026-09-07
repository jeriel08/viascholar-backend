import { Module } from '@nestjs/common';
import { ApplicationsService } from './applications.service.js';
import { ApplicationInterviewsService } from './application-interviews.service.js';
import { ApplicationStageService } from './application-stage.service.js';
import { ApplicationsController } from './applications.controller.js';
import { GoogleCalendarModule } from '../google-calendar/google-calendar.module.js';

@Module({
  imports: [GoogleCalendarModule],
  providers: [
    ApplicationsService,
    ApplicationInterviewsService,
    ApplicationStageService,
  ],
  controllers: [ApplicationsController],
  exports: [
    ApplicationsService,
    ApplicationInterviewsService,
    ApplicationStageService,
  ],
})
export class ApplicationsModule {}
