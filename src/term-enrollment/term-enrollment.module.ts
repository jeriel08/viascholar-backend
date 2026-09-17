import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { EventsModule } from '../events/events.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { TermEnrollmentController } from './term-enrollment.controller.js';
import { ScholarEnrollmentService } from './services/scholar-enrollment.service.js';
import { EnrollmentOcrService } from './services/enrollment-ocr.service.js';
import { EnrollmentAuditEngineService } from './services/enrollment-audit-engine.service.js';
import { CoordinatorEnrollmentService } from './services/coordinator-enrollment.service.js';

@Module({
  imports: [CloudinaryModule, AuditModule, EventsModule, DocumentsModule],
  controllers: [TermEnrollmentController],
  providers: [
    ScholarEnrollmentService,
    EnrollmentOcrService,
    EnrollmentAuditEngineService,
    CoordinatorEnrollmentService,
  ],
  exports: [
    ScholarEnrollmentService,
    EnrollmentOcrService,
    EnrollmentAuditEngineService,
    CoordinatorEnrollmentService,
  ],
})
export class TermEnrollmentModule {}
