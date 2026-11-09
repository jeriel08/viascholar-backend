import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentDataQueryService } from './document-data-query.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const createPrismaMock = () => ({
  scholarDocument: {
    findUnique: vi.fn(),
  },
});

const makeDoc = (overrides: Record<string, unknown> = {}) => ({
  document_id: 55,
  scholar_profile_id: 11,
  document_type: 'Form 138',
  label: 'Senior High School Report Card (Form 138 / Form 9)',
  status: 'PENDING',
  file_name: 'form138.pdf',
  file_url: 'https://cdn.test/doc.pdf',
  file_size: '0.1 KB',
  rejection_reason: null,
  extracted_data: null,
  confirmed_data: null,
  uploaded_at: new Date('2026-08-01T00:00:00.000Z'),
  scholar_profile: { profile_id: 11, user_id: 7 },
  ...overrides,
});

describe('DocumentDataQueryService', () => {
  let service: DocumentDataQueryService;
  let prisma: ReturnType<typeof createPrismaMock>;

  beforeEach(async () => {
    prisma = createPrismaMock();
    prisma.scholarDocument.findUnique.mockResolvedValue(makeDoc());

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocumentDataQueryService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<DocumentDataQueryService>(DocumentDataQueryService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('throws NotFoundException when the document does not exist', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(null);

    await expect(service.getExtractedData(7, 55, 'SCHOLAR')).rejects.toThrow(
      new NotFoundException('Document ID 55 not found.'),
    );
  });

  it('throws NotFoundException when a non-owner non-staff user asks for an inaccessible document', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({ scholar_profile: { profile_id: 11, user_id: 99 } }),
    );

    await expect(service.getExtractedData(7, 55, 'SCHOLAR')).rejects.toThrow(
      NotFoundException,
    );
  });

  it.each(['ADMIN', 'GRANTOR', 'COORDINATOR'])(
    'allows staff role %s to read any document',
    async (role) => {
      prisma.scholarDocument.findUnique.mockResolvedValue(
        makeDoc({ scholar_profile: { profile_id: 11, user_id: 99 } }),
      );

      const result = await service.getExtractedData(7, 55, role);

      expect(result.document_id).toBe(55);
    },
  );

  it('returns the forensic analysis passthrough and empty warnings for verified docs', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({
        status: 'VERIFIED',
        extracted_data: {
          grades: [{ subject_code: 'A', grade: 90 }],
          forensic_analysis: { risk_level: 'LOW' },
        },
      }),
    );

    const result = await service.getExtractedData(7, 55, 'SCHOLAR');

    expect(result.smart_warnings).toEqual([]);
    expect(result.forensic_analysis).toEqual({ risk_level: 'LOW' });
  });

  it('warns about too few detected subjects on multi-page Form 138s', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({
        status: 'PASSED_PRECHECK',
        document_type: 'Form 138',
        extracted_data: { grades: [{ subject_code: 'A', grade: 90 }] },
      }),
    );

    const result = await service.getExtractedData(7, 55, 'SCHOLAR');

    expect(result.smart_warnings).toHaveLength(2);
    expect(result.smart_warnings[0]).toContain('Only 1 subjects were detected');
  });

  it('warns when grades were detected but the general average was not', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({
        status: 'PENDING',
        document_type: 'TOR',
        label: 'College Transcript of Records (TOR)',
        extracted_data: {
          grades: [{ subject_code: 'A', grade: 90 }],
        },
      }),
    );

    const result = await service.getExtractedData(7, 55, 'SCHOLAR');

    expect(result.smart_warnings).toHaveLength(1);
    expect(result.smart_warnings[0]).toContain(
      'General Average was not automatically detected',
    );
  });

  it('does not warn about general average when it was detected already', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({
        status: 'PENDING',
        document_type: 'TOR',
        label: 'College Transcript of Records (TOR)',
        extracted_data: {
          grades: [{ subject_code: 'A', grade: 90 }],
          general_average: 1.5,
        },
      }),
    );

    const result = await service.getExtractedData(7, 55, 'SCHOLAR');

    expect(result.smart_warnings).toEqual([]);
  });

  it('does not warn on low grade counts for non-Form 138 documents', async () => {
    prisma.scholarDocument.findUnique.mockResolvedValue(
      makeDoc({
        status: 'PASSED_PRECHECK',
        document_type: 'TOR',
        label: 'College Transcript of Records (TOR)',
        extracted_data: { grades: [{ subject_code: 'A', grade: 90 }] },
      }),
    );

    const result = await service.getExtractedData(7, 55, 'SCHOLAR');

    expect(result.smart_warnings).toHaveLength(1);
    expect(result.smart_warnings[0]).not.toContain('Only 1 subjects');
  });
});
