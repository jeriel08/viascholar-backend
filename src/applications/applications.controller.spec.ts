import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';
import { ApplicationInterviewsService } from './application-interviews.service.js';
import { ApplicationStageService } from './application-stage.service.js';

describe('ApplicationsController', () => {
  let controller: ApplicationsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicationsController],
      providers: [
        { provide: ApplicationsService, useValue: {} },
        { provide: ApplicationInterviewsService, useValue: {} },
        { provide: ApplicationStageService, useValue: {} },
      ],
    }).compile();

    controller = module.get<ApplicationsController>(ApplicationsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
