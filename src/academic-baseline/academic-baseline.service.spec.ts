import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { ScholarBaselineService } from './services/scholar-baseline.service.js';
import { BaselineDocumentIngestionService } from './services/baseline-document-ingestion.service.js';
import { CoordinatorBaselineService } from './services/coordinator-baseline.service.js';
import { ActiveScholarsAnalyticsService } from './services/active-scholars-analytics.service.js';
import { BatchUpdateSubjectsDto } from './dto/batch-update-subjects.dto.js';
import { FreezeBaselineDto } from './dto/freeze-baseline.dto.js';
import { SelectSchoolDto } from './dto/select-school.dto.js';

const createScholarBaselineServiceMock = () => ({
  getScholarBaselineState: vi.fn(),
  getScholarDashboardSummary: vi.fn(),
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

  const files = [
    { originalname: 'prospectus.pdf' },
  ] as unknown as Express.Multer.File[];
  const subjectsDto = { subjects: [] } as unknown as BatchUpdateSubjectsDto;
  const schoolDto = { school_id: 1 } as SelectSchoolDto;
  const freezeDto = { remarks: 'Verified' } as FreezeBaselineDto;

  beforeEach(async () => {
    scholarBaselineServiceMock = createScholarBaselineServiceMock();
    baselineDocumentIngestionServiceMock =
      createBaselineDocumentIngestionServiceMock();
    coordinatorBaselineServiceMock = createCoordinatorBaselineServiceMock();
    activeScholarsAnalyticsServiceMock =
      createActiveScholarsAnalyticsServiceMock();

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

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('delegates getScholarBaselineState with the default refresh flag', async () => {
    const expected = { profile_id: 1 };
    scholarBaselineServiceMock.getScholarBaselineState.mockResolvedValue(
      expected,
    );

    const result = await service.getScholarBaselineState(123);

    expect(
      scholarBaselineServiceMock.getScholarBaselineState,
    ).toHaveBeenCalledWith(123, false);
    expect(result).toBe(expected);
  });

  it('delegates getScholarBaselineState with an explicit refresh flag', async () => {
    await service.getScholarBaselineState(123, true);

    expect(
      scholarBaselineServiceMock.getScholarBaselineState,
    ).toHaveBeenCalledWith(123, true);
  });

  it('delegates getScholarDashboardSummary with the refresh flag', async () => {
    const expected = { profile: { profile_id: 1 } };
    scholarBaselineServiceMock.getScholarDashboardSummary.mockResolvedValue(
      expected,
    );

    const result = await service.getScholarDashboardSummary(123, true);

    expect(
      scholarBaselineServiceMock.getScholarDashboardSummary,
    ).toHaveBeenCalledWith(123, true);
    expect(result).toBe(expected);
  });

  it('delegates selectOrProposeSchool to the scholar baseline service', async () => {
    const expected = {
      message: 'Institution grading configuration confirmed.',
    };
    scholarBaselineServiceMock.selectOrProposeSchool.mockResolvedValue(
      expected,
    );

    const result = await service.selectOrProposeSchool(123, schoolDto);

    expect(
      scholarBaselineServiceMock.selectOrProposeSchool,
    ).toHaveBeenCalledWith(123, schoolDto);
    expect(result).toBe(expected);
  });

  it('delegates uploadProspectus to the document ingestion service', async () => {
    const expected = { message: 'Prospectus uploaded.' };
    baselineDocumentIngestionServiceMock.uploadProspectus.mockResolvedValue(
      expected,
    );

    const result = await service.uploadProspectus(123, files);

    expect(
      baselineDocumentIngestionServiceMock.uploadProspectus,
    ).toHaveBeenCalledWith(123, files);
    expect(result).toBe(expected);
  });

  it('delegates updateProspectusSubjects with the default staff flag', async () => {
    const expected = { message: 'Prospectus subjects saved successfully.' };
    scholarBaselineServiceMock.updateProspectusSubjects.mockResolvedValue(
      expected,
    );

    const result = await service.updateProspectusSubjects(123, subjectsDto);

    expect(
      scholarBaselineServiceMock.updateProspectusSubjects,
    ).toHaveBeenCalledWith(123, subjectsDto, false);
    expect(result).toBe(expected);
  });

  it('delegates updateProspectusSubjects with an explicit staff flag', async () => {
    await service.updateProspectusSubjects(123, subjectsDto, true);

    expect(
      scholarBaselineServiceMock.updateProspectusSubjects,
    ).toHaveBeenCalledWith(123, subjectsDto, true);
  });

  it('delegates uploadHistoricalCcg to the document ingestion service', async () => {
    const expected = { matched_credited: [] };
    baselineDocumentIngestionServiceMock.uploadHistoricalCcg.mockResolvedValue(
      expected,
    );

    const result = await service.uploadHistoricalCcg(123, files);

    expect(
      baselineDocumentIngestionServiceMock.uploadHistoricalCcg,
    ).toHaveBeenCalledWith(123, files);
    expect(result).toBe(expected);
  });

  it('delegates submitForReview to the scholar baseline service', async () => {
    const expected = { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' };
    scholarBaselineServiceMock.submitForReview.mockResolvedValue(expected);

    const result = await service.submitForReview(123);

    expect(scholarBaselineServiceMock.submitForReview).toHaveBeenCalledWith(
      123,
    );
    expect(result).toBe(expected);
  });

  it('delegates getCoordinatorPendingBaselines to the coordinator service', async () => {
    const expected = [{ profile_id: 10 }];
    coordinatorBaselineServiceMock.getCoordinatorPendingBaselines.mockResolvedValue(
      expected,
    );

    const result = await service.getCoordinatorPendingBaselines();

    expect(
      coordinatorBaselineServiceMock.getCoordinatorPendingBaselines,
    ).toHaveBeenCalledWith();
    expect(result).toBe(expected);
  });

  it('delegates getCoordinatorBaselineReview with the refresh flag', async () => {
    const expected = { metrics: { total_units: 9 } };
    coordinatorBaselineServiceMock.getCoordinatorBaselineReview.mockResolvedValue(
      expected,
    );

    const result = await service.getCoordinatorBaselineReview(10, true);

    expect(
      coordinatorBaselineServiceMock.getCoordinatorBaselineReview,
    ).toHaveBeenCalledWith(10, true);
    expect(result).toBe(expected);
  });

  it('delegates coordinatorUpdateSubjects with all arguments', async () => {
    const expected = { message: 'Prospectus subjects updated by coordinator.' };
    coordinatorBaselineServiceMock.coordinatorUpdateSubjects.mockResolvedValue(
      expected,
    );

    const result = await service.coordinatorUpdateSubjects(2, 55, subjectsDto);

    expect(
      coordinatorBaselineServiceMock.coordinatorUpdateSubjects,
    ).toHaveBeenCalledWith(2, 55, subjectsDto);
    expect(result).toBe(expected);
  });

  it('delegates freezeBaseline with all arguments', async () => {
    const expected = { academic_baseline_status: 'BASELINE_FROZEN' };
    coordinatorBaselineServiceMock.freezeBaseline.mockResolvedValue(expected);

    const result = await service.freezeBaseline(2, 55, freezeDto);

    expect(coordinatorBaselineServiceMock.freezeBaseline).toHaveBeenCalledWith(
      2,
      55,
      freezeDto,
    );
    expect(result).toBe(expected);
  });

  it('delegates unfreezeBaseline with all arguments', async () => {
    const expected = { academic_baseline_status: 'PENDING_COORDINATOR_REVIEW' };
    coordinatorBaselineServiceMock.unfreezeBaseline.mockResolvedValue(expected);

    const result = await service.unfreezeBaseline(2, 55);

    expect(
      coordinatorBaselineServiceMock.unfreezeBaseline,
    ).toHaveBeenCalledWith(2, 55);
    expect(result).toBe(expected);
  });

  it('delegates getCoordinatorActiveScholars to the analytics service', async () => {
    const expected = [{ id: 10, health: 'good' }];
    activeScholarsAnalyticsServiceMock.getCoordinatorActiveScholars.mockResolvedValue(
      expected,
    );

    const result = await service.getCoordinatorActiveScholars();

    expect(
      activeScholarsAnalyticsServiceMock.getCoordinatorActiveScholars,
    ).toHaveBeenCalledWith();
    expect(result).toBe(expected);
  });
});
