import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsStorageService } from './documents-storage.service.js';
import { DocumentOcrService } from './document-ocr.service.js';
import { DocumentEvaluationService } from './document-evaluation.service.js';
import { GradeReportsService } from './grade-reports.service.js';
import { PdfMergerService } from './pdf-merger.service.js';
import { GradeCalculatorService } from './grade-calculator.service.js';
import { FileForensicsService } from './file-forensics.service.js';
import { DocumentReconciliationService } from './document-reconciliation.service.js';

@Module({
  imports: [CloudinaryModule, SettingsModule],
  controllers: [DocumentsController],
  providers: [
    DocumentsStorageService,
    DocumentOcrService,
    DocumentEvaluationService,
    GradeReportsService,
    PdfMergerService,
    GradeCalculatorService,
    FileForensicsService,
    DocumentReconciliationService,
  ],
  exports: [
    DocumentsStorageService,
    DocumentOcrService,
    DocumentEvaluationService,
    GradeReportsService,
    PdfMergerService,
    GradeCalculatorService,
    FileForensicsService,
    DocumentReconciliationService,
  ],
})
export class DocumentsModule {}
