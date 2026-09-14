import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { ScholarBaselineService } from './services/scholar-baseline.service.js';
import { BaselineDocumentIngestionService } from './services/baseline-document-ingestion.service.js';
import { CoordinatorBaselineService } from './services/coordinator-baseline.service.js';
import { ActiveScholarsAnalyticsService } from './services/active-scholars-analytics.service.js';

describe('AcademicBaselineService', () => {
  let service: AcademicBaselineService;
  let scholarBaselineServiceMock: any;
  let baselineDocumentIngestionServiceMock: any;
  let coordinatorBaselineServiceMock: any;
  let activeScholarsAnalyticsServiceMock: any;

  beforeEach(async () => {
    scholarBaselineServiceMock = {
      getScholarBaselineState: jest.fn().mockResolvedValue({ profile_id: 1 } as never),
      selectOrProposeSchool: jest.fn().mockResolvedValue({ message: 'OK' } as never),
      updateProspectusSubjects: jest.fn().mockResolvedValue({ message: 'OK' } as never),
      submitForReview: jest.fn().mockResolvedValue({ message: 'OK' } as never),
    };

    baselineDocumentIngestionServiceMock = {
      uploadProspectus: jest.fn().mockResolvedValue({ message: 'OK' } as never),
      uploadHistoricalCcg: jest.fn().mockResolvedValue({ message: 'OK' } as never),
    };

    coordinatorBaselineServiceMock = {
      getCoordinatorPendingBaselines: jest.fn().mockResolvedValue([] as never),
      getCoordinatorBaselineReview: jest.fn().mockResolvedValue({} as never),
      coordinatorUpdateSubjects: jest.fn().mockResolvedValue({ message: 'OK' } as never),
      freezeBaseline: jest.fn().mockResolvedValue({ message: 'OK' } as never),
      unfreezeBaseline: jest.fn().mockResolvedValue({ message: 'OK' } as never),
    };

    activeScholarsAnalyticsServiceMock = {
      getCoordinatorActiveScholars: jest.fn().mockResolvedValue([] as never),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcademicBaselineService,
        { provide: ScholarBaselineService, useValue: scholarBaselineServiceMock },
        { provide: BaselineDocumentIngestionService, useValue: baselineDocumentIngestionServiceMock },
        { provide: CoordinatorBaselineService, useValue: coordinatorBaselineServiceMock },
        { provide: ActiveScholarsAnalyticsService, useValue: activeScholarsAnalyticsServiceMock },
      ],
    }).compile();

    service = module.get<AcademicBaselineService>(AcademicBaselineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('delegates getScholarBaselineState to ScholarBaselineService', async () => {
    await service.getScholarBaselineState(123);
    expect(scholarBaselineServiceMock.getScholarBaselineState).toHaveBeenCalledWith(123);
  });

  it('delegates uploadProspectus to BaselineDocumentIngestionService', async () => {
    const files = [{ originalname: 'prospectus.pdf' }] as any;
    await service.uploadProspectus(123, files);
    expect(baselineDocumentIngestionServiceMock.uploadProspectus).toHaveBeenCalledWith(123, files);
  });

  it('delegates getCoordinatorPendingBaselines to CoordinatorBaselineService', async () => {
    await service.getCoordinatorPendingBaselines();
    expect(coordinatorBaselineServiceMock.getCoordinatorPendingBaselines).toHaveBeenCalled();
  });

  it('delegates getCoordinatorActiveScholars to ActiveScholarsAnalyticsService', async () => {
    await service.getCoordinatorActiveScholars();
    expect(activeScholarsAnalyticsServiceMock.getCoordinatorActiveScholars).toHaveBeenCalled();
  });
});
