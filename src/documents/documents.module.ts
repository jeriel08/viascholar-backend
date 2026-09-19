import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsStorageService } from './services/documents-storage.service.js';
import { DocumentOcrService } from './services/document-ocr.service.js';
import { DocumentEvaluationService } from './services/document-evaluation.service.js';
import { DocumentConfirmationService } from './services/document-confirmation.service.js';
import { DocumentDataQueryService } from './services/document-data-query.service.js';
import { GradeReportsService } from './services/grade-reports.service.js';
import { PdfMergerService } from './services/pdf-merger.service.js';
import { GradeCalculatorService } from './services/grade-calculator.service.js';
import { FileForensicsService } from './services/file-forensics.service.js';
import { DocumentReconciliationService } from './services/document-reconciliation.service.js';
import { DocumentSchoolLinkerService } from './services/document-school-linker.service.js';
import { ParseurSyncService } from './services/parseur-sync.service.js';
import { ProspectusTransitionService } from './services/prospectus-transition.service.js';
import { DocumentValidationService } from './services/documents-validation.service.js';
import { AcademicAppealService } from './services/academic-appeal.service.js';
import { LlamaExtractService } from './extractors/llama-extract.service.js';
import { ParseurExtractorService } from './extractors/parseur-extractor.service.js';

@Module({
  imports: [CloudinaryModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsStorageService,
    DocumentOcrService,
    DocumentEvaluationService,
    DocumentConfirmationService,
    DocumentDataQueryService,
    GradeReportsService,
    AcademicAppealService,
    PdfMergerService,
    GradeCalculatorService,
    FileForensicsService,
    DocumentReconciliationService,
    DocumentSchoolLinkerService,
    ParseurSyncService,
    ProspectusTransitionService,
    DocumentValidationService,
    LlamaExtractService,
    ParseurExtractorService,
  ],
  exports: [
    DocumentsStorageService,
    DocumentOcrService,
    DocumentEvaluationService,
    DocumentConfirmationService,
    DocumentDataQueryService,
    GradeReportsService,
    AcademicAppealService,
    PdfMergerService,
    GradeCalculatorService,
    FileForensicsService,
    DocumentReconciliationService,
    DocumentSchoolLinkerService,
    ParseurSyncService,
    ProspectusTransitionService,
    DocumentValidationService,
    LlamaExtractService,
    ParseurExtractorService,
  ],
})
export class DocumentsModule {}
