import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { AcademicBaselineController } from './academic-baseline.controller.js';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { ProspectusOcrService } from './prospectus-ocr.service.js';
import { ScholarBaselineService } from './services/scholar-baseline.service.js';
import { BaselineDocumentIngestionService } from './services/baseline-document-ingestion.service.js';
import { CoordinatorBaselineService } from './services/coordinator-baseline.service.js';
import { ActiveScholarsAnalyticsService } from './services/active-scholars-analytics.service.js';

@Module({
  imports: [CloudinaryModule, SettingsModule, DocumentsModule],
  controllers: [AcademicBaselineController],
  providers: [
    AcademicBaselineService,
    ProspectusOcrService,
    ScholarBaselineService,
    BaselineDocumentIngestionService,
    CoordinatorBaselineService,
    ActiveScholarsAnalyticsService,
  ],
  exports: [
    AcademicBaselineService,
    ProspectusOcrService,
    ScholarBaselineService,
    BaselineDocumentIngestionService,
    CoordinatorBaselineService,
    ActiveScholarsAnalyticsService,
  ],
})
export class AcademicBaselineModule {}
