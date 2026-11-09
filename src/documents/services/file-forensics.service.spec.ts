import { beforeEach, describe, expect, it } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { PDFDocument } from 'pdf-lib';
import { FileForensicsService } from './file-forensics.service.js';

const signaturePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const makePdfBuffer = async (
  setMetadata?: (doc: PDFDocument) => void,
): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  if (setMetadata) {
    setMetadata(doc);
  }
  return Buffer.from(await doc.save());
};

describe('FileForensicsService', () => {
  let service: FileForensicsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [FileForensicsService],
    }).compile();

    service = module.get<FileForensicsService>(FileForensicsService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('returns a clean result for an empty file list', async () => {
    const result = await service.inspectFileMetadata([]);

    expect(result).toEqual({
      is_flagged: false,
      detected_software: [],
      pdf_metadata: undefined,
      image_signatures: undefined,
      flags: [],
    });
  });

  it('skips buffers that are null or empty', async () => {
    const result = await service.inspectFileMetadata([
      {
        buffer: Buffer.alloc(0),
        mimeType: 'application/pdf',
        originalname: 'a.pdf',
      },
    ]);

    expect(result.is_flagged).toBe(false);
    expect(result.flags).toEqual([]);
  });

  it('flags Photoshop XMP/header signatures in image data', async () => {
    const poisoned = Buffer.concat([
      signaturePng,
      Buffer.from('Adobe Photoshop 3.0 ordinary bytes'),
    ]);

    const result = await service.inspectFileMetadata([
      { buffer: poisoned, mimeType: 'image/png', originalname: 'card.png' },
    ]);

    expect(result.is_flagged).toBe(true);
    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_PHOTOSHOP');
    expect(result.detected_software).toContain('photoshop');
    expect(result.image_signatures).toContain(
      'Adobe Photoshop signature in image header',
    );
  });

  it('flags Canva artifacts in image data', async () => {
    const result = await service.inspectFileMetadata([
      {
        buffer: Buffer.from('... canva design metadata ...'),
        mimeType: 'image/png',
      },
    ]);

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_CANVA');
  });

  it('flags GIMP artifacts in image data', async () => {
    const result = await service.inspectFileMetadata([
      { buffer: Buffer.from('gimp xcf export bytes'), mimeType: 'image/png' },
    ]);

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_GIMP');
  });

  it('flags Photopea artifacts in image data', async () => {
    const result = await service.inspectFileMetadata([
      { buffer: Buffer.from('photopea exported asset'), mimeType: 'image/png' },
    ]);

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_PHOTOPEA');
  });

  it('flags a PDF whose title advertises Canva', async () => {
    const buffer = await makePdfBuffer((doc) => {
      doc.setTitle('Canva Design Export');
    });

    const result = await service.inspectFileMetadata([
      { buffer, mimeType: 'application/pdf', originalname: 'card.pdf' },
    ]);

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_CANVA');
    expect(result.pdf_metadata?.title).toBe('Canva Design Export');
    expect(result.detected_software).toContain('canva');
  });

  it('flags a PDF whose author advertises Adobe ILovePdf', async () => {
    const buffer = await makePdfBuffer((doc) => {
      doc.setAuthor('iLovePDF converter service');
    });

    const result = await service.inspectFileMetadata([
      { buffer, originalname: 'card.pdf' }, // no mimeType; extension fallback
    ]);

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_ILOVEPDF');
  });

  it('flags PDFs modified long after creation', async () => {
    const creation = new Date('2026-01-01T00:00:00.000Z');
    const modified = new Date('2026-03-01T00:00:00.000Z');
    const buffer = await makePdfBuffer((doc) => {
      doc.setCreationDate(creation);
      doc.setModificationDate(modified);
    });

    const result = await service.inspectFileMetadata([
      { buffer, mimeType: 'application/pdf' },
    ]);

    expect(result.flags).toContain('PDF_MODIFIED_LONG_AFTER_CREATION');
    expect(result.pdf_metadata?.has_modification_gap).toBe(true);
  });

  it('does not flag a PDF modified within 14 days of creation', async () => {
    // pdf-lib rewrites the modification date at save time, so create two reference
    // times that straddle the 14-day window deterministically:
    const creation = new Date();
    creation.setDate(creation.getDate() - 2);
    const buffer = await makePdfBuffer((doc) => {
      doc.setCreationDate(creation);
    });

    const result = await service.inspectFileMetadata([
      { buffer, mimeType: 'application/pdf' },
    ]);

    expect(result.flags).not.toContain('PDF_MODIFIED_LONG_AFTER_CREATION');
    expect(result.pdf_metadata?.has_modification_gap).toBe(false);
  });

  it('deduplicates flags across multiple files', async () => {
    const first = await makePdfBuffer((doc) =>
      doc.setTitle('Canva Design Export'),
    );
    const result = await service.inspectFileMetadata([
      { buffer: first, mimeType: 'application/pdf' },
      { buffer: Buffer.from('canva canva canva'), mimeType: 'image/png' },
    ]);

    expect(
      result.flags.filter((flag) => flag === 'SUSPICIOUS_SOFTWARE_CANVA'),
    ).toHaveLength(1);
  });

  it('detects PDFs by magic bytes even without a pdf extension or mime type', async () => {
    const buffer = await makePdfBuffer((doc) =>
      doc.setTitle('Canva Design Export'),
    );

    const result = await service.inspectFileMetadata([
      {
        buffer,
        mimeType: 'application/octet-stream',
        originalname: 'strange.bin',
      },
    ]);

    expect(result.flags).toContain('SUSPICIOUS_SOFTWARE_CANVA');
  });
});
