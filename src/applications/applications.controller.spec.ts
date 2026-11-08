import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { ApplicationsController } from './applications.controller.js';
import { ApplicationsService } from './applications.service.js';
import { ApplicationInterviewsService } from './services/application-interviews.service.js';
import { ApplicationStageService } from './services/application-stage.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { CreateApplicationDto } from './dto/create-application.dto.js';
import type { QueryApplicationsDto } from './dto/query-applications.dto.js';
import type { ScheduleInterviewDto } from './dto/schedule-interview.dto.js';
import type { RequestRescheduleDto } from './dto/request-reschedule.dto.js';
import type { RescheduleInterviewDto } from './dto/reschedule-interview.dto.js';
import type { CancelInterviewDto } from './dto/cancel-interview.dto.js';
import type { UpdateApplicationStageDto } from './dto/update-stage.dto.js';

const makeRequest = (userId = 7, role = 'SCHOLAR') => ({
  user: { user_id: userId, role },
});

describe('ApplicationsController', () => {
  let controller: ApplicationsController;
  let applicationsService: ReturnType<typeof createApplicationsServiceMock>;
  let interviewsService: ReturnType<typeof createInterviewsServiceMock>;
  let stageService: ReturnType<typeof createStageServiceMock>;

  const createApplicationsServiceMock = () => ({
    submitApplication: vi.fn(),
    finalizeApplication: vi.fn(),
    getMyApplication: vi.fn(),
    findAll: vi.fn(),
    getApplicationDocuments: vi.fn(),
  });
  const createInterviewsServiceMock = () => ({
    scheduleInterview: vi.fn(),
    requestReschedule: vi.fn(),
    rescheduleInterview: vi.fn(),
    cancelInterview: vi.fn(),
  });
  const createStageServiceMock = () => ({
    updateStage: vi.fn(),
  });

  beforeEach(async () => {
    applicationsService = createApplicationsServiceMock();
    interviewsService = createInterviewsServiceMock();
    stageService = createStageServiceMock();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApplicationsController],
      providers: [
        { provide: ApplicationsService, useValue: applicationsService },
        { provide: ApplicationInterviewsService, useValue: interviewsService },
        { provide: ApplicationStageService, useValue: stageService },
      ],
    }).compile();

    controller = module.get<ApplicationsController>(ApplicationsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates submitApplication with the authenticated user', async () => {
    const request = makeRequest();
    const dto = { scholarship_track: 'Academic Track' } as CreateApplicationDto;
    applicationsService.submitApplication.mockResolvedValue({
      application_id: 42,
    });

    const result = await controller.submitApplication(request, dto);

    expect(applicationsService.submitApplication).toHaveBeenCalledWith(7, dto);
    expect(result).toEqual({ application_id: 42 });
  });

  it('delegates finalizeApplication with the authenticated user', async () => {
    const request = makeRequest();
    await controller.finalizeApplication(request);

    expect(applicationsService.finalizeApplication).toHaveBeenCalledWith(7);
  });

  it('delegates getMyApplication with the authenticated user', async () => {
    const request = makeRequest();
    await controller.getMyApplication(request);

    expect(applicationsService.getMyApplication).toHaveBeenCalledWith(7);
  });

  it('delegates requestReschedule to the interviews service', async () => {
    const request = makeRequest();
    const dto = { reason: 'Schedule conflict' } as RequestRescheduleDto;
    await controller.requestReschedule(request, dto);

    expect(interviewsService.requestReschedule).toHaveBeenCalledWith(7, dto);
  });

  it('delegates findAll with the query object', async () => {
    const query = { status: 'PENDING' } as QueryApplicationsDto;
    applicationsService.findAll.mockResolvedValue([{ application_id: 42 }]);

    const result = await controller.findAll(query);

    expect(applicationsService.findAll).toHaveBeenCalledWith(query);
    expect(result).toEqual([{ application_id: 42 }]);
  });

  it('delegates getApplicationDocuments with the parsed id', async () => {
    await controller.getApplicationDocuments(42);

    expect(applicationsService.getApplicationDocuments).toHaveBeenCalledWith(
      42,
    );
  });

  it('delegates scheduleInterview with staff user, id, and DTO', async () => {
    const request = makeRequest(2, 'COORDINATOR');
    const dto = {
      interview_at: '2026-08-15T10:00:00.000Z',
    } as ScheduleInterviewDto;
    await controller.scheduleInterview(request, 42, dto);

    expect(interviewsService.scheduleInterview).toHaveBeenCalledWith(
      2,
      42,
      dto,
    );
  });

  it('delegates rescheduleInterview with staff user, id, and DTO', async () => {
    const request = makeRequest(2, 'COORDINATOR');
    const dto = {
      new_interview_at: '2026-09-01T10:00:00.000Z',
    } as RescheduleInterviewDto;
    await controller.rescheduleInterview(request, 42, dto);

    expect(interviewsService.rescheduleInterview).toHaveBeenCalledWith(
      2,
      42,
      dto,
    );
  });

  it('delegates cancelInterview with staff user, id, and DTO', async () => {
    const request = makeRequest(2, 'COORDINATOR');
    const dto = { reason: 'Scholar dropped' } as CancelInterviewDto;
    await controller.cancelInterview(request, 42, dto);

    expect(interviewsService.cancelInterview).toHaveBeenCalledWith(2, 42, dto);
  });

  it('delegates updateStage with staff user, id, DTO, and caller role', async () => {
    const request = makeRequest(2, 'COORDINATOR');
    const dto = {
      stage: 'Under review',
      status: 'UNDER_REVIEW',
    } as UpdateApplicationStageDto;
    await controller.updateStage(request, 42, dto);

    expect(stageService.updateStage).toHaveBeenCalledWith(
      2,
      42,
      dto,
      'COORDINATOR',
    );
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = ApplicationsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts applicant-facing endpoints to applicants and scholars', () => {
      for (const name of [
        'submitApplication',
        'finalizeApplication',
        'getMyApplication',
        'requestReschedule',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.APPLICANT,
          Role.SCHOLAR,
        ]);
      }
    });

    it('restricts staff endpoints to staff roles', () => {
      for (const name of [
        'findAll',
        'getApplicationDocuments',
        'scheduleInterview',
        'rescheduleInterview',
        'cancelInterview',
        'updateStage',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.ADMIN,
          Role.GRANTOR,
          Role.COORDINATOR,
        ]);
      }
    });
  });
});
