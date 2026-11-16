import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Role } from '../../generated/prisma/enums.js';
import { AcademicChangeRequestService } from './academic-change-request.service.js';

describe('AcademicChangeRequestService', () => {
  let service: AcademicChangeRequestService;
  let prisma: Record<string, any>;
  let auditService: { log: ReturnType<typeof vi.fn> };
  let cloudinaryService: { uploadBuffer: ReturnType<typeof vi.fn> };
  let eventsGateway: { emitToStaff: ReturnType<typeof vi.fn>; emitToUser: ReturnType<typeof vi.fn> };
  let cacheService: { del: ReturnType<typeof vi.fn>; delPattern: ReturnType<typeof vi.fn> };
  let mailService: {
    sendAcademicChangeRequestedEmail: ReturnType<typeof vi.fn>;
    sendAcademicChangeDecisionEmail: ReturnType<typeof vi.fn>;
  };
  let notificationsService: {
    createForRoles: ReturnType<typeof vi.fn>;
    notifyUser: ReturnType<typeof vi.fn>;
    notifyCoordinators: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = {
      scholarProfile: {
        findUnique: vi.fn(),
        update: vi.fn(),
      },
      academicProgram: {
        findUnique: vi.fn(),
      },
      school: {
        findUnique: vi.fn(),
      },
      schoolGradingSystem: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      scholarDocument: {
        create: vi.fn(),
      },
      scholarProspectus: {
        update: vi.fn(),
      },
      academicChangeRequest: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(prisma)),
    };

    auditService = { log: vi.fn().mockResolvedValue(undefined) };
    cloudinaryService = {
      uploadBuffer: vi.fn().mockResolvedValue({ secure_url: 'https://cdn.example.com/shift.pdf' }),
    };
    eventsGateway = { emitToStaff: vi.fn(), emitToUser: vi.fn() };
    cacheService = {
      del: vi.fn().mockResolvedValue(undefined),
      delPattern: vi.fn().mockResolvedValue(undefined),
    };
    mailService = {
      sendAcademicChangeRequestedEmail: vi.fn().mockResolvedValue(undefined),
      sendAcademicChangeDecisionEmail: vi.fn().mockResolvedValue(undefined),
    };
    notificationsService = {
      createForRoles: vi.fn().mockResolvedValue([]),
      notifyUser: vi.fn().mockResolvedValue(null),
      notifyCoordinators: vi.fn().mockResolvedValue([]),
    };

    service = new AcademicChangeRequestService(
      prisma as any,
      auditService as any,
      cloudinaryService as any,
      eventsGateway as any,
      cacheService as any,
      mailService as any,
      notificationsService as any,
    );
  });

  it('creates a program shift request, notifies Grantor and CCs Coordinator', async () => {
    prisma.scholarProfile.findUnique.mockResolvedValue({
      profile_id: 10,
      user_id: 42,
      first_name: 'Maria',
      last_name: 'Clara',
      course_of_study: 'BS Computer Science',
      school_name: 'University of Mindanao',
      school_id: 3,
      user: { email: 'maria@example.com' },
      school_grading_system: { school_name: 'University of Mindanao' },
    });
    prisma.academicChangeRequest.findFirst.mockResolvedValue(null);
    prisma.academicProgram.findUnique.mockResolvedValue({
      program_id: 7,
      program_code: 'BSIT',
      program_name: 'BS Information Technology',
      is_active: true,
    });
    prisma.academicChangeRequest.create.mockResolvedValue({
      request_id: 99,
      scholar_profile_id: 10,
      change_type: 'PROGRAM_SHIFT',
      requested_course_of_study: 'BS Information Technology',
      requested_school_name: null,
      effective_academic_year: '2026-2027',
      effective_semester: '2nd Semester',
      reason: 'Aligning coursework toward systems administration.',
      status: 'PENDING_GRANTOR',
    });

    const result = await service.createRequest(42, {
      change_type: 'PROGRAM_SHIFT',
      requested_program_id: 7,
      effective_academic_year: '2026-2027',
      effective_semester: '2nd Semester',
      reason: 'Aligning coursework toward systems administration.',
    });

    expect(result.status).toBe('PENDING_GRANTOR');
    expect(notificationsService.createForRoles).toHaveBeenCalledWith(
      [Role.GRANTOR],
      expect.objectContaining({ title: 'Program Shift Request' }),
    );
    expect(notificationsService.createForRoles).toHaveBeenCalledWith(
      [Role.COORDINATOR, Role.ADMIN],
      expect.objectContaining({ title: '[CC] Program Shift Request' }),
    );
    expect(mailService.sendAcademicChangeRequestedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        studentName: 'Maria Clara',
        changeLabel: 'Program Shift',
      }),
    );
    expect(eventsGateway.emitToStaff).toHaveBeenCalledWith(
      'academic_change:requested',
      expect.objectContaining({ request_id: 99 }),
    );
  });

  it('rejects duplicate pending change requests and same-program shifts', async () => {
    prisma.scholarProfile.findUnique.mockResolvedValue({
      profile_id: 10,
      user_id: 42,
      first_name: 'Maria',
      last_name: 'Clara',
      course_of_study: 'BS Computer Science',
      school_name: 'University of Mindanao',
      school_id: 3,
      user: { email: 'maria@example.com' },
      school_grading_system: { school_name: 'University of Mindanao' },
    });
    prisma.academicChangeRequest.findFirst.mockResolvedValue({ request_id: 1, status: 'PENDING_GRANTOR' });

    await expect(
      service.createRequest(42, {
        change_type: 'PROGRAM_SHIFT',
        requested_course_of_study: 'BS Information Technology',
        reason: 'Switching focus area.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    prisma.academicChangeRequest.findFirst.mockResolvedValue(null);
    await expect(
      service.createRequest(42, {
        change_type: 'PROGRAM_SHIFT',
        requested_course_of_study: '  bs computer science ',
        reason: 'Switching focus area.',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('prevents non-owners from cancelling a pending request', async () => {
    prisma.academicChangeRequest.findUnique.mockResolvedValue({
      request_id: 99,
      status: 'PENDING_GRANTOR',
      scholar_profile: { user_id: 777, profile_id: 10 },
    });

    await expect(service.cancelMyRequest(42, 99)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approving a program shift updates ScholarProfile, unlocks frozen prospectus, and notifies Scholar & CC Coordinators', async () => {
    prisma.academicChangeRequest.findUnique.mockResolvedValue({
      request_id: 99,
      scholar_profile_id: 10,
      change_type: 'PROGRAM_SHIFT',
      requested_course_of_study: 'BS Information Technology',
      requested_school_id: null,
      requested_school_name: null,
      requested_program: { program_code: 'BSIT' },
      status: 'PENDING_GRANTOR',
      scholar_profile: {
        profile_id: 10,
        user_id: 42,
        first_name: 'Maria',
        last_name: 'Clara',
        school_id: 3,
        user: { email: 'maria@example.com', user_id: 42 },
        prospectus: { prospectus_id: 55, is_frozen: true, status: 'FROZEN' },
      },
    });
    prisma.academicChangeRequest.update.mockResolvedValue({
      request_id: 99,
      scholar_profile_id: 10,
      status: 'APPROVED',
      reviewed_by_user_id: 5,
    });

    const updated = await service.reviewRequest(5, 99, {
      decision: 'APPROVED',
      decision_notes: 'Confirmed by grantor board.',
    });

    expect(updated.status).toBe('APPROVED');
    expect(prisma.scholarProfile.update).toHaveBeenCalledWith({
      where: { profile_id: 10 },
      data: {
        course_of_study: 'BS Information Technology',
        academic_baseline_status: 'PENDING_PROSPECTUS',
      },
    });
    expect(prisma.scholarProspectus.update).toHaveBeenCalledWith({
      where: { prospectus_id: 55 },
      data: {
        is_frozen: false,
        status: 'DRAFT',
        course_name: 'BS Information Technology',
        course_code: 'BSIT',
      },
    });
    expect(notificationsService.notifyUser).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ title: 'Program Shift Confirmed' }),
    );
    expect(notificationsService.notifyCoordinators).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[CC] Program Shift Confirmed' }),
    );
    expect(mailService.sendAcademicChangeDecisionEmail).toHaveBeenCalledWith(
      'maria@example.com',
      expect.objectContaining({ decision: 'APPROVED' }),
    );
    expect(cacheService.del).toHaveBeenCalledWith('baseline:scholar:42');
  });
});
