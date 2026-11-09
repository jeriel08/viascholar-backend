import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { DocumentValidationService } from './documents-validation.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const objectMatching = (shape: Record<string, unknown>) =>
  expect.objectContaining(shape) as Record<string, unknown>;

const createPrismaMock = () => ({
  scholarDocument: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
});

const makeDoc = (overrides: Record<string, unknown> = {}) => ({
  document_id: 55,
  document_type: 'TOR',
  scholar_profile: {
    profile_id: 11,
    first_name: 'Juan',
    last_name: 'Dela Cruz',
    course_of_study: 'BS Information Technology',
  },
  ...overrides,
});

describe('DocumentValidationService', () => {
  let service: DocumentValidationService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());
    prisma.scholarDocument.update.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentValidationService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DocumentValidationService>(DocumentValidationService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('returns undefined and skips the update when the document does not exist', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(null);

    const result = await service.validateExtractedDocument(999, {});

    expect(result).toBeUndefined();
    expect(prisma.scholarDocument.update).not.toHaveBeenCalled();
  });

  it('passes a clean TOR and marks it PASSED_PRECHECK', async () => {
    const result = await service.validateExtractedDocument(55, {
      student_name: 'Juan Dela Cruz',
      course_name: 'BS Information Technology',
      has_signature: 'true',
      grades: [
        { units: 3, grade: 1.5 },
        { units: 3, grade: 2.0 },
      ],
    });

    expect(prisma.scholarDocument.update).toHaveBeenCalledWith({
      where: { document_id: 55 },
      data: objectMatching({
        status: 'PASSED_PRECHECK',
        rejection_reason: null,
        extracted_data: objectMatching({
          completed_subjects_count: 2,
          validation_flags: [],
        }),
      }),
    });
    expect(result!).toEqual({ status: 'PASSED_PRECHECK', flags: [] });
  });

  it('flags a name mismatch and requires a re-upload', async () => {
    const result = await service.validateExtractedDocument(55, {
      student_name: 'Completely Unrelated Person',
      has_signature: 'true',
      grades: [{ units: 3, grade: 1.5 }],
    });

    expect(result!.flags).toContain('STUDENT_NAME_MISMATCH');
    expect(result!.status).toBe('NEEDS_REUPLOAD');
  });

  it('flags a course mismatch against the registered program', async () => {
    const result = await service.validateExtractedDocument(55, {
      student_name: 'Juan Dela Cruz',
      course_name: 'Doctor of Medicine',
      has_signature: 'true',
      grades: [{ units: 3, grade: 1.5 }],
    });

    expect(result!.flags).toContain('COURSE_MISMATCH');
  });

  it('does not flag the course when either side contains the other', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({
        scholar_profile: {
          profile_id: 11,
          first_name: 'Juan',
          last_name: 'Dela Cruz',
          course_of_study: 'Information Technology',
        },
      }),
    );

    const result = await service.validateExtractedDocument(55, {
      student_name: 'Juan Dela Cruz',
      course_name: 'Bachelor of Science in Information Technology degree',
      has_signature: 'true',
      grades: [{ units: 3, grade: 1.5 }],
    });

    expect(result!.flags).not.toContain('COURSE_MISMATCH');
  });

  it('flags a missing registrar signature', async () => {
    const result = await service.validateExtractedDocument(55, {
      student_name: 'Juan Dela Cruz',
      has_signature: 'false',
      grades: [{ units: 3, grade: 1.5 }],
    });

    expect(result!.flags).toContain('MISSING_REGISTRAR_SIGNATURE');
  });

  it('flags a document without completed grade rows', async () => {
    const result = await service.validateExtractedDocument(55, {
      student_name: 'Juan Dela Cruz',
      has_signature: 'true',
      grades: [
        { units: 0, grade: 1.5 },
        { units: 3, grade: 0 },
      ],
    });

    expect(result!.flags).toContain('NO_COMPLETED_GRADES_FOUND');
  });

  it('aggregates every failing rule into the rejection reason', async () => {
    await service.validateExtractedDocument(55, {
      student_name: 'Unrelated Person',
      course_name: 'Doctor of Medicine',
      has_signature: 'no',
      grades: [],
    });

    const updateCall = prisma.scholarDocument.update.mock.calls[0][0] as {
      data: { rejection_reason: string | null; status: string };
    };
    expect(updateCall.data.status).toBe('NEEDS_REUPLOAD');
    expect(updateCall.data.rejection_reason).toContain('STUDENT_NAME_MISMATCH');
    expect(updateCall.data.rejection_reason).toContain('COURSE_MISMATCH');
    expect(updateCall.data.rejection_reason).toContain(
      'MISSING_REGISTRAR_SIGNATURE',
    );
    expect(updateCall.data.rejection_reason).toContain(
      'NO_COMPLETED_GRADES_FOUND',
    );
  });
});
