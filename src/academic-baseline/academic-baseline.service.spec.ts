import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { ScholarBaselineService } from './services/scholar-baseline.service.js';
import { BaselineDocumentIngestionService } from './services/baseline-document-ingestion.service.js';
import { CoordinatorBaselineService } from './services/coordinator-baseline.service.js';
import { ActiveScholarsAnalyticsService } from './services/active-scholars-analytics.service.js';

const createScholarBaselineServiceMock = () => ({
  getScholarBaselineState: vi.fn(),
  selectOrProposeSchool: vi.fn(),
  updateProspectusSubjects: vi.fn(),
  submitForReview: vi.fn(),
});

const createBaselineDocumentIngestionServiceMock = () => ({
  uploadProspectus: vi.fn(),
  uploadHistoricalCcg: vi.fn(),
});

const createCoordinatorBaselineServiceMock = () => ({
  getCoordinatorPendingBaselines: vi.fn(),
  getCoordinatorBaselineReview: vi.fn(),
  coordinatorUpdateSubjects: vi.fn(),
  freezeBaseline: vi.fn(),
  unfreezeBaseline: vi.fn(),
});

const createActiveScholarsAnalyticsServiceMock = () => ({
  getCoordinatorActiveScholars: vi.fn(),
});

describe('AcademicBaselineService', () => {
  let service: AcademicBaselineService;
  let scholarBaselineServiceMock: ReturnType<
    typeof createScholarBaselineServiceMock
  >;
  let baselineDocumentIngestionServiceMock: ReturnType<
    typeof createBaselineDocumentIngestionServiceMock
  >;
  let coordinatorBaselineServiceMock: ReturnType<
    typeof createCoordinatorBaselineServiceMock
  >;
  let activeScholarsAnalyticsServiceMock: ReturnType<
    typeof createActiveScholarsAnalyticsServiceMock
  >;

  beforeEach(async () => {
    scholarBaselineServiceMock = createScholarBaselineServiceMock();
    scholarBaselineServiceMock.getScholarBaselineState.mockResolvedValue({
      profile_id: 1,
    });
    scholarBaselineServiceMock.selectOrProposeSchool.mockResolvedValue({
      message: 'OK',
    });
    scholarBaselineServiceMock.updateProspectusSubjects.mockResolvedValue({
      message: 'OK',
    });
    scholarBaselineServiceMock.submitForReview.mockResolvedValue({
      message: 'OK',
    });

    baselineDocumentIngestionServiceMock =
      createBaselineDocumentIngestionServiceMock();
    baselineDocumentIngestionServiceMock.uploadProspectus.mockResolvedValue({
      message: 'OK',
    });
    baselineDocumentIngestionServiceMock.uploadHistoricalCcg.mockResolvedValue({
      message: 'OK',
    });

    coordinatorBaselineServiceMock = createCoordinatorBaselineServiceMock();
    coordinatorBaselineServiceMock.getCoordinatorPendingBaselines.mockResolvedValue(
      [],
    );
    coordinatorBaselineServiceMock.getCoordinatorBaselineReview.mockResolvedValue(
      {},
    );
    coordinatorBaselineServiceMock.coordinatorUpdateSubjects.mockResolvedValue({
      message: 'OK',
    });
    coordinatorBaselineServiceMock.freezeBaseline.mockResolvedValue({
      message: 'OK',
    });
    coordinatorBaselineServiceMock.unfreezeBaseline.mockResolvedValue({
      message: 'OK',
    });

    activeScholarsAnalyticsServiceMock =
      createActiveScholarsAnalyticsServiceMock();
    activeScholarsAnalyticsServiceMock.getCoordinatorActiveScholars.mockResolvedValue(
      [],
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcademicBaselineService,
        {
          provide: ScholarBaselineService,
          useValue: scholarBaselineServiceMock,
        },
        {
          provide: BaselineDocumentIngestionService,
          useValue: baselineDocumentIngestionServiceMock,
        },
        {
          provide: CoordinatorBaselineService,
          useValue: coordinatorBaselineServiceMock,
        },
        {
          provide: ActiveScholarsAnalyticsService,
          useValue: activeScholarsAnalyticsServiceMock,
        },
      ],
    }).compile();

    service = module.get<AcademicBaselineService>(AcademicBaselineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('delegates getScholarBaselineState to ScholarBaselineService', async () => {
    await service.getScholarBaselineState(123);
    expect(
      scholarBaselineServiceMock.getScholarBaselineState,
    ).toHaveBeenCalledWith(123, false);
  });

  it('delegates uploadProspectus to BaselineDocumentIngestionService', async () => {
    const files = [
      { originalname: 'prospectus.pdf' },
    ] as unknown as Express.Multer.File[];
    await service.uploadProspectus(123, files);
    expect(
      baselineDocumentIngestionServiceMock.uploadProspectus,
    ).toHaveBeenCalledWith(123, files);
  });

  it('delegates getCoordinatorPendingBaselines to CoordinatorBaselineService', async () => {
    await service.getCoordinatorPendingBaselines();
    expect(
      coordinatorBaselineServiceMock.getCoordinatorPendingBaselines,
    ).toHaveBeenCalled();
  });

  it('delegates getCoordinatorActiveScholars to ActiveScholarsAnalyticsService', async () => {
    await service.getCoordinatorActiveScholars();
    expect(
      activeScholarsAnalyticsServiceMock.getCoordinatorActiveScholars,
    ).toHaveBeenCalled();
  });
});
