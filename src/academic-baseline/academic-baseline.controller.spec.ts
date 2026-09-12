import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineController } from './academic-baseline.controller';
import { AcademicBaselineService } from './academic-baseline.service';

describe('AcademicBaselineController', () => {
  let controller: AcademicBaselineController;
  let serviceMock: any;

  beforeEach(async () => {
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

    controller = module.get<AcademicBaselineController>(
      AcademicBaselineController,
    );
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
