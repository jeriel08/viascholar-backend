import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineController } from './academic-baseline.controller.js';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { AcademicChangeRequestService } from './services/academic-change-request.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { BatchUpdateSubjectsDto } from './dto/batch-update-subjects.dto.js';
import { FreezeBaselineDto } from './dto/freeze-baseline.dto.js';
import { SelectSchoolDto } from './dto/select-school.dto.js';

const makeFile = (overrides: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'prospectus.pdf',
    mimetype: 'application/pdf',
    size: 2048,
    buffer: Buffer.from('file'),
    ...overrides,
  }) as Express.Multer.File;

const makeRequest = (userId = 42, role = 'SCHOLAR') => ({
  user: { user_id: userId, role },
});

describe('AcademicBaselineController', () => {
  let controller: AcademicBaselineController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;
  let changeRequestMock: Record<string, ReturnType<typeof vi.fn>>;

  const req = makeRequest();
  const subjectsDto = { subjects: [] } as unknown as BatchUpdateSubjectsDto;
  const schoolDto = { school_id: 1 } as SelectSchoolDto;
  const freezeDto = { remarks: 'Verified' } as FreezeBaselineDto;

  beforeEach(async () => {
    serviceMock = {
      getScholarBaselineState: vi.fn(),
      getScholarDashboardSummary: vi.fn(),
      selectOrProposeSchool: vi.fn(),
      uploadProspectus: vi.fn(),
      updateProspectusSubjects: vi.fn(),
      uploadHistoricalCcg: vi.fn(),
      submitForReview: vi.fn(),
      getCoordinatorPendingBaselines: vi.fn(),
      getCoordinatorActiveScholars: vi.fn(),
      getCoordinatorScholarDetails: vi.fn(),
      getCoordinatorBaselineReview: vi.fn(),
      coordinatorUpdateSubjects: vi.fn(),
      freezeBaseline: vi.fn(),
      unfreezeBaseline: vi.fn(),
    };
    changeRequestMock = {
      getMyRequests: vi.fn(),
      createRequest: vi.fn(),
      cancelMyRequest: vi.fn(),
      listRequestsForStaff: vi.fn(),
      reviewRequest: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AcademicBaselineController],
      providers: [
        {
          provide: AcademicBaselineService,
          useValue: serviceMock,
        },
        {
          provide: AcademicChangeRequestService,
          useValue: changeRequestMock,
        },
      ],
    }).compile();

    controller = module.get(AcademicBaselineController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  describe('scholar onboarding endpoints', () => {
    it('delegates getMyBaseline with refresh=true', async () => {
      const expected = { profile_id: 1 };
      serviceMock.getScholarBaselineState.mockResolvedValue(expected);

      const result = await controller.getMyBaseline(req, 'true');

      expect(serviceMock.getScholarBaselineState).toHaveBeenCalledWith(
        42,
        true,
      );
      expect(result).toBe(expected);
    });

    it('treats a missing or non-true refresh value as false', async () => {
      await controller.getMyBaseline(req, undefined);
      await controller.getMyBaseline(req, 'TRUE');

      expect(serviceMock.getScholarBaselineState).toHaveBeenNthCalledWith(
        1,
        42,
        false,
      );
      expect(serviceMock.getScholarBaselineState).toHaveBeenNthCalledWith(
        2,
        42,
        false,
      );
    });

    it('delegates getScholarDashboardSummary with the refresh flag', async () => {
      await controller.getScholarDashboardSummary(req, 'true');

      expect(serviceMock.getScholarDashboardSummary).toHaveBeenCalledWith(
        42,
        true,
      );
    });

    it('delegates selectSchool with the authenticated user and DTO', async () => {
      const expected = {
        message: 'Institution grading configuration confirmed.',
      };
      serviceMock.selectOrProposeSchool.mockResolvedValue(expected);

      const result = await controller.selectSchool(req, schoolDto);

      expect(serviceMock.selectOrProposeSchool).toHaveBeenCalledWith(
        42,
        schoolDto,
      );
      expect(result).toBe(expected);
    });

    it('delegates valid prospectus uploads after file validation', async () => {
      const files = [makeFile()];
      const expected = { message: 'Prospectus uploaded.' };
      serviceMock.uploadProspectus.mockResolvedValue(expected);

      const result = await controller.uploadProspectus(req, files);

      expect(serviceMock.uploadProspectus).toHaveBeenCalledWith(42, files);
      expect(result).toBe(expected);
    });

    it('rejects prospectus uploads when no files are provided', () => {
      expect(() =>
        controller.uploadProspectus(
          req,
          undefined as unknown as Express.Multer.File[],
        ),
      ).toThrow(BadRequestException);
      expect(() => controller.uploadProspectus(req, [])).toThrow(
        'At least one file must be provided.',
      );
      expect(serviceMock.uploadProspectus).not.toHaveBeenCalled();
    });

    it('rejects prospectus files larger than 10MB', () => {
      const files = [
        makeFile({
          originalname: 'large.pdf',
          size: 10 * 1024 * 1024 + 1,
        }),
      ];

      expect(() => controller.uploadProspectus(req, files)).toThrow(
        'File "large.pdf" exceeds 10MB.',
      );
      expect(serviceMock.uploadProspectus).not.toHaveBeenCalled();
    });

    it('accepts a file exactly at the 10MB limit', async () => {
      const files = [makeFile({ size: 10 * 1024 * 1024 })];

      await controller.uploadProspectus(req, files);

      expect(serviceMock.uploadProspectus).toHaveBeenCalledWith(42, files);
    });

    it('rejects files with an unsupported MIME type and extension', () => {
      const files = [
        makeFile({ originalname: 'notes.txt', mimetype: 'text/plain' }),
      ];

      expect(() => controller.uploadProspectus(req, files)).toThrow(
        'File "notes.txt" has unsupported format. Allowed: JPG, PNG, WEBP, PDF.',
      );
      expect(serviceMock.uploadProspectus).not.toHaveBeenCalled();
    });

    it('accepts an allowed extension even when the MIME type is generic', async () => {
      const files = [
        makeFile({
          originalname: 'SCAN.PDF',
          mimetype: 'application/octet-stream',
        }),
      ];

      await controller.uploadProspectus(req, files);

      expect(serviceMock.uploadProspectus).toHaveBeenCalledWith(42, files);
    });

    it('accepts an allowed MIME type even when the filename has no extension', async () => {
      const files = [makeFile({ originalname: 'scan', mimetype: 'image/png' })];

      await controller.uploadProspectus(req, files);

      expect(serviceMock.uploadProspectus).toHaveBeenCalledWith(42, files);
    });

    it('delegates updateMyProspectusSubjects to the service', async () => {
      const expected = { message: 'Prospectus subjects saved successfully.' };
      serviceMock.updateProspectusSubjects.mockResolvedValue(expected);

      const result = await controller.updateMyProspectusSubjects(
        req,
        subjectsDto,
      );

      expect(serviceMock.updateProspectusSubjects).toHaveBeenCalledWith(
        42,
        subjectsDto,
      );
      expect(result).toBe(expected);
    });

    it('validates and delegates historical CCG uploads', async () => {
      const files = [
        makeFile({ originalname: 'tor.png', mimetype: 'image/png' }),
      ];

      await controller.uploadHistoricalCcg(req, files);

      expect(serviceMock.uploadHistoricalCcg).toHaveBeenCalledWith(42, files);
      expect(() => controller.uploadHistoricalCcg(req, [])).toThrow(
        'At least one file must be provided.',
      );
    });

    it('delegates submitForReview to the service', async () => {
      await controller.submitForReview(req);

      expect(serviceMock.submitForReview).toHaveBeenCalledWith(42);
    });
  });

  describe('coordinator endpoints', () => {
    it('delegates getPendingBaselines to the service', async () => {
      const expected = [{ profile_id: 10 }];
      serviceMock.getCoordinatorPendingBaselines.mockResolvedValue(expected);

      const result = await controller.getPendingBaselines();

      expect(serviceMock.getCoordinatorPendingBaselines).toHaveBeenCalledWith();
      expect(result).toBe(expected);
    });

    it('delegates getActiveScholars to the service', async () => {
      await controller.getActiveScholars();

      expect(serviceMock.getCoordinatorActiveScholars).toHaveBeenCalledWith();
    });

    it('delegates getCoordinatorReview with a parsed profile id and refresh flag', async () => {
      await controller.getCoordinatorReview(10, 'true');
      await controller.getCoordinatorReview(10, undefined);

      expect(serviceMock.getCoordinatorBaselineReview).toHaveBeenNthCalledWith(
        1,
        10,
        true,
      );
      expect(serviceMock.getCoordinatorBaselineReview).toHaveBeenNthCalledWith(
        2,
        10,
        false,
      );
    });

    it('delegates coordinatorUpdateSubjects with user, prospectus, and DTO', async () => {
      const coordinatorReq = makeRequest(2, 'COORDINATOR');

      await controller.coordinatorUpdateSubjects(
        coordinatorReq,
        55,
        subjectsDto,
      );

      expect(serviceMock.coordinatorUpdateSubjects).toHaveBeenCalledWith(
        2,
        55,
        subjectsDto,
      );
    });

    it('delegates freezeBaseline with user, prospectus, and DTO', async () => {
      const coordinatorReq = makeRequest(2, 'COORDINATOR');

      await controller.freezeBaseline(coordinatorReq, 55, freezeDto);

      expect(serviceMock.freezeBaseline).toHaveBeenCalledWith(2, 55, freezeDto);
    });

    it('delegates unfreezeBaseline with user and prospectus id', async () => {
      const coordinatorReq = makeRequest(2, 'COORDINATOR');

      await controller.unfreezeBaseline(coordinatorReq, 55);

      expect(serviceMock.unfreezeBaseline).toHaveBeenCalledWith(2, 55);
    });

    it('delegates getScholarDetails with scholar profile id', async () => {
      const expected = { scholar_profile: { profile_id: 10 } };
      serviceMock.getCoordinatorScholarDetails.mockResolvedValue(expected);

      const result = await controller.getScholarDetails(10);

      expect(serviceMock.getCoordinatorScholarDetails).toHaveBeenCalledWith(10);
      expect(result).toBe(expected);
    });
  });

  describe('authorization metadata', () => {
    // Look up handlers by name so the linter does not flag unbound methods.
    const handlerFor = (name: string) => {
      const prototype =
        AcademicBaselineController.prototype as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts scholar onboarding endpoints to scholar-side roles', () => {
      expect(rolesFor(handlerFor('getMyBaseline'))).toEqual([
        Role.SCHOLAR,
        Role.APPLICANT,
        Role.COORDINATOR,
        Role.GRANTOR,
        Role.ADMIN,
      ]);

      for (const name of [
        'selectSchool',
        'uploadProspectus',
        'updateMyProspectusSubjects',
        'uploadHistoricalCcg',
        'submitForReview',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.SCHOLAR,
          Role.APPLICANT,
        ]);
      }
    });

    it('restricts the dashboard summary to scholar and staff roles', () => {
      expect(rolesFor(handlerFor('getScholarDashboardSummary'))).toEqual([
        Role.SCHOLAR,
        Role.COORDINATOR,
        Role.GRANTOR,
        Role.ADMIN,
      ]);
    });

    it('restricts coordinator audit endpoints to staff roles', () => {
      for (const name of [
        'getPendingBaselines',
        'getActiveScholars',
        'getScholarDetails',
        'getCoordinatorReview',
        'coordinatorUpdateSubjects',
        'freezeBaseline',
        'unfreezeBaseline',
        'listAcademicChangeRequests',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.ADMIN,
          Role.GRANTOR,
          Role.COORDINATOR,
        ]);
      }
    });

    it('restricts academic change review decisions to grantors and admins', () => {
      expect(rolesFor(handlerFor('reviewAcademicChangeRequest'))).toEqual([
        Role.GRANTOR,
        Role.ADMIN,
      ]);
    });
  });
});
