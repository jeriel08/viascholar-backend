import { Test, TestingModule } from '@nestjs/testing';
import { DocumentsController } from './documents.controller.js';
import { DocumentsStorageService } from './services/documents-storage.service.js';
import { DocumentOcrService } from './services/document-ocr.service.js';
import { DocumentEvaluationService } from './services/document-evaluation.service.js';
import { GradeReportsService } from './services/grade-reports.service.js';
import { AcademicAppealService } from './services/academic-appeal.service.js';

describe('DocumentsController', () => {
  let controller: DocumentsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DocumentsController],
      providers: [
        { provide: DocumentsStorageService, useValue: {} },
        { provide: DocumentOcrService, useValue: {} },
        { provide: DocumentEvaluationService, useValue: {} },
        { provide: GradeReportsService, useValue: {} },
        { provide: AcademicAppealService, useValue: {} },
      ],
    }).compile();

    controller = module.get<DocumentsController>(DocumentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
