import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineController } from './academic-baseline.controller.js';
import { AcademicBaselineService } from './academic-baseline.service.js';

describe('AcademicBaselineController', () => {
  let controller: AcademicBaselineController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      getScholarBaselineState: vi.fn(),
      selectOrProposeSchool: vi.fn(),
      uploadProspectus: vi.fn(),
      updateProspectusSubjects: vi.fn(),
      uploadHistoricalCcg: vi.fn(),
      submitForReview: vi.fn(),
      getCoordinatorPendingBaselines: vi.fn(),
      getCoordinatorBaselineReview: vi.fn(),
      coordinatorUpdateSubjects: vi.fn(),
      freezeBaseline: vi.fn(),
      unfreezeBaseline: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AcademicBaselineController],
      providers: [
        {
          provide: AcademicBaselineService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get(AcademicBaselineController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('delegates getMyBaseline with refresh param', async () => {
    const req = { user: { user_id: 42, role: 'SCHOLAR' } };
    await controller.getMyBaseline(req, 'true');
    expect(serviceMock.getScholarBaselineState).toHaveBeenCalledWith(42, true);
  });

  it('delegates getCoordinatorReview with refresh param', async () => {
    await controller.getCoordinatorReview(10, 'true');
    expect(serviceMock.getCoordinatorBaselineReview).toHaveBeenCalledWith(
      10,
      true,
    );
  });
});
