import { Test, TestingModule } from '@nestjs/testing';
import { DocumentsController } from './documents.controller.js';
import { DocumentsStorageService } from './documents-storage.service.js';
import { DocumentOcrService } from './document-ocr.service.js';
import { DocumentEvaluationService } from './document-evaluation.service.js';
import { GradeReportsService } from './grade-reports.service.js';

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
      ],
    }).compile();

    controller = module.get<DocumentsController>(DocumentsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
