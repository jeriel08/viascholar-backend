import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { EventsModule } from '../events/events.module.js';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { DisbursementsController } from './disbursements.controller.js';
import { GrantorDisbursementService } from './services/grantor-disbursement.service.js';
import { CoordinatorDisbursementService } from './services/coordinator-disbursement.service.js';
import { ScholarDisbursementService } from './services/scholar-disbursement.service.js';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    EventsModule,
    CloudinaryModule,
    DocumentsModule,
  ],
  controllers: [DisbursementsController],
  providers: [
    GrantorDisbursementService,
    CoordinatorDisbursementService,
    ScholarDisbursementService,
  ],
  exports: [
    GrantorDisbursementService,
    CoordinatorDisbursementService,
    ScholarDisbursementService,
  ],
})
export class DisbursementsModule {}
