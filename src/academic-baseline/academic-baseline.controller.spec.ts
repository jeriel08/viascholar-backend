import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';

describe('AcademicBaselineController', () => {
  let controller: any;
  let serviceMock: any;

  beforeAll(async () => {
    jest.unstable_mockModule('@nestjs/throttler', () => ({
      Throttle: () => () => {},
      SkipThrottle: () => () => {},
      ThrottlerGuard: class {},
    }));

    const { AcademicBaselineController } = await import(
      './academic-baseline.controller.js'
    );
    const { AcademicBaselineService } = await import(
      './academic-baseline.service.js'
    );

    serviceMock = {
      getScholarBaselineState: jest.fn(),
      selectOrProposeSchool: jest.fn(),
      uploadProspectus: jest.fn(),
      updateProspectusSubjects: jest.fn(),
      uploadHistoricalCcg: jest.fn(),
      submitForReview: jest.fn(),
      getCoordinatorPendingBaselines: jest.fn(),
      getCoordinatorBaselineReview: jest.fn(),
      coordinatorUpdateSubjects: jest.fn(),
      freezeBaseline: jest.fn(),
      unfreezeBaseline: jest.fn(),
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
    const req = { user: { user_id: 42, role: 'SCHOLAR' } } as any;
    await controller.getMyBaseline(req, 'true');
    expect(serviceMock.getScholarBaselineState).toHaveBeenCalledWith(42, true);
  });

  it('delegates getCoordinatorReview with refresh param', async () => {
    await controller.getCoordinatorReview(10, 'true');
    expect(serviceMock.getCoordinatorBaselineReview).toHaveBeenCalledWith(10, true);
  });
});
