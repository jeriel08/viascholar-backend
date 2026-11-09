import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { SettingsController } from './settings.controller.js';
import { SettingsService } from './settings.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { CreateSchoolGradingDto } from './dto/create-school-grading.dto.js';
import type { UpdateSchoolGradingDto } from './dto/update-school-grading.dto.js';
import type { CreateAcademicProgramDto } from './dto/create-program.dto.js';
import type { CreateSchoolDto } from './dto/create-school.dto.js';

const makeRequest = (userId = 7, role: Role = Role.COORDINATOR) => ({
  user: { user_id: userId, role },
});

describe('SettingsController', () => {
  let controller: SettingsController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      getSettings: vi.fn(),
      updateSettings: vi.fn(),
      getSchoolGradings: vi.fn(),
      createSchoolGrading: vi.fn(),
      verifySchoolGrading: vi.fn(),
      deleteSchoolGrading: vi.fn(),
      updateSchoolGrading: vi.fn(),
      getPrograms: vi.fn(),
      createProgram: vi.fn(),
      updateProgram: vi.fn(),
      deleteProgram: vi.fn(),
      getSchools: vi.fn(),
      createSchool: vi.fn(),
      updateSchool: vi.fn(),
      deleteSchool: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        {
          provide: SettingsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<SettingsController>(SettingsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates getSettings to the service', () => {
    serviceMock.getSettings.mockReturnValue({ grade_threshold: '90.00' });

    const result = controller.getSettings();
    expect(serviceMock.getSettings).toHaveBeenCalledWith();
    expect(result).toEqual({ grade_threshold: '90.00' });
  });

  it('delegates updateSettings with the authenticated user', () => {
    const dto = { grade_threshold: 80 };

    void controller.updateSettings(makeRequest(), dto);

    expect(serviceMock.updateSettings).toHaveBeenCalledWith(7, dto);
  });

  it('delegates getSchoolGradings', () => {
    void controller.getSchoolGradings();

    expect(serviceMock.getSchoolGradings).toHaveBeenCalledWith();
  });

  it('delegates createSchoolGrading with user id, dto, and role', () => {
    const dto = { school_name: 'UM' } as CreateSchoolGradingDto;

    void controller.createSchoolGrading(makeRequest(), dto);

    expect(serviceMock.createSchoolGrading).toHaveBeenCalledWith(
      7,
      dto,
      Role.COORDINATOR,
    );
  });

  it('delegates verifySchoolGrading with user and id', () => {
    void controller.verifySchoolGrading(makeRequest(), 10);

    expect(serviceMock.verifySchoolGrading).toHaveBeenCalledWith(7, 10);
  });

  it('delegates deleteSchoolGrading with user and id', () => {
    void controller.deleteSchoolGrading(makeRequest(), 10);

    expect(serviceMock.deleteSchoolGrading).toHaveBeenCalledWith(7, 10);
  });

  it('delegates updateSchoolGrading with user, id, and dto', () => {
    const dto = { passing_grade: 2.5 } as UpdateSchoolGradingDto;

    void controller.updateSchoolGrading(makeRequest(), 10, dto);

    expect(serviceMock.updateSchoolGrading).toHaveBeenCalledWith(7, 10, dto);
  });

  it('parses the only_active query flag for getPrograms', () => {
    void controller.getPrograms('true');
    void controller.getPrograms('false');

    expect(serviceMock.getPrograms).toHaveBeenNthCalledWith(1, true, false);
    expect(serviceMock.getPrograms).toHaveBeenNthCalledWith(2, false, false);
  });

  it('parses the include_archived query flag for getPrograms', () => {
    void controller.getPrograms(undefined, 'true');

    expect(serviceMock.getPrograms).toHaveBeenCalledWith(false, true);
  });

  it('parses the only_active query flag for institutions endpoints', () => {
    void controller.getInstitutions('true');
    void controller.getInstitutions(undefined);

    expect(serviceMock.getSchools).toHaveBeenNthCalledWith(1, true, false);
    expect(serviceMock.getSchools).toHaveBeenNthCalledWith(2, false, false);
  });

  it('delegates getSchoolsList with the only_active flag', () => {
    void controller.getSchoolsList('true');

    expect(serviceMock.getSchools).toHaveBeenCalledWith(true, false);
  });

  it('delegates getSchoolsList with the include_archived flag', () => {
    void controller.getSchoolsList(undefined, 'true');

    expect(serviceMock.getSchools).toHaveBeenCalledWith(false, true);
  });

  it('delegates createProgram with user and dto', () => {
    const dto = {
      program_code: 'BSIT',
      program_name: 'BSIT',
    } as CreateAcademicProgramDto;

    void controller.createProgram(makeRequest(), dto);

    expect(serviceMock.createProgram).toHaveBeenCalledWith(7, dto);
  });

  it('delegates updateProgram with user, id, and dto', () => {
    const dto = { category: 'Vocational' } as never;

    void controller.updateProgram(makeRequest(), 10, dto);

    expect(serviceMock.updateProgram).toHaveBeenCalledWith(7, 10, dto);
  });

  it('delegates deleteProgram with user and id', () => {
    void controller.deleteProgram(makeRequest(), 10);

    expect(serviceMock.deleteProgram).toHaveBeenCalledWith(7, 10);
  });

  it('delegates createSchoolEntity and createInstitution to the same handler', () => {
    const dto = { school_name: 'UM' } as CreateSchoolDto;

    void controller.createSchoolEntity(makeRequest(), dto);
    void controller.createInstitution(makeRequest(), dto);

    expect(serviceMock.createSchool).toHaveBeenNthCalledWith(1, 7, dto);
    expect(serviceMock.createSchool).toHaveBeenNthCalledWith(2, 7, dto);
  });

  it('delegates updateSchool and updateInstitution to the same handler', () => {
    const dto = { school_name: 'Ateneo de Davao' } as never;

    void controller.updateSchoolEntity(makeRequest(), 10, dto);
    void controller.updateInstitution(makeRequest(), 10, dto);

    expect(serviceMock.updateSchool).toHaveBeenNthCalledWith(1, 7, 10, dto);
    expect(serviceMock.updateSchool).toHaveBeenNthCalledWith(2, 7, 10, dto);
  });

  it('delegates deleteSchoolEntity and deleteInstitution to the same handler', () => {
    void controller.deleteSchoolEntity(makeRequest(), 10);
    void controller.deleteInstitution(makeRequest(), 10);

    expect(serviceMock.deleteSchool).toHaveBeenNthCalledWith(1, 7, 10);
    expect(serviceMock.deleteSchool).toHaveBeenNthCalledWith(2, 7, 10);
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = SettingsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts updateSettings to admins and grantors', () => {
      expect(rolesFor(handlerFor('updateSettings'))).toEqual([
        Role.ADMIN,
        Role.GRANTOR,
      ]);
    });

    it('restricts school grading creation to all roles and verification to staff', () => {
      expect(rolesFor(handlerFor('createSchoolGrading'))).toEqual([
        Role.ADMIN,
        Role.GRANTOR,
        Role.COORDINATOR,
        Role.SCHOLAR,
        Role.APPLICANT,
      ]);
      expect(rolesFor(handlerFor('verifySchoolGrading'))).toEqual([
        Role.ADMIN,
        Role.GRANTOR,
        Role.COORDINATOR,
      ]);
    });

    it('restricts catalog mutations and destructive operations to staff', () => {
      for (const name of [
        'deleteSchoolGrading',
        'deleteProgram',
        'deleteSchoolEntity',
        'deleteInstitution',
      ]) {
        expect(rolesFor(handlerFor(name))).toEqual([Role.ADMIN, Role.GRANTOR]);
      }
    });

    it('restricts school and program mutation endpoints to staff roles', () => {
      for (const name of [
        'verifySchoolGrading',
        'updateSchoolGrading',
        'createProgram',
        'updateProgram',
        'createSchoolEntity',
        'createInstitution',
        'updateSchoolEntity',
        'updateInstitution',
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
