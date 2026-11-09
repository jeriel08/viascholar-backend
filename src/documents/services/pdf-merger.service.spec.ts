import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestException, Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PDFDocument } from 'pdf-lib';
import { PdfMergerService } from './pdf-merger.service.js';

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const makeFile = (
  buffer: Buffer,
  name: string,
  mimetype: string,
): Express.Multer.File =>
  ({
    originalname: name,
    mimetype,
    size: buffer.length,
    buffer,
  }) as Express.Multer.File;

const makePdfPage = async (): Promise<Buffer> => {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return Buffer.from(await doc.save());
};

describe('PdfMergerService', () => {
  let service: PdfMergerService;

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [PdfMergerService],
    }).compile();

    service = module.get<PdfMergerService>(PdfMergerService);
  });

  it('is created by the Nest testing module', () => {
    expect(service).toBeDefined();
  });

  it('throws BadRequestException when no files are provided', async () => {
    await expect(service.processAndMergeFiles([])).rejects.toThrow(
      new BadRequestException('At least one file must be provided.'),
    );
  });

  it('passes a single PDF through untouched with a formatted size', async () => {
    const pdfBuffer = await makePdfPage();

    const result = await service.processAndMergeFiles(
      [makeFile(pdfBuffer, 'tor.pdf', 'application/pdf')],
      'TOR',
    );

    expect(result).toEqual({
      buffer: pdfBuffer,
      fileName: 'tor.pdf',
      fileSize: expect.stringMatching(/^[\d.]+ (KB|MB)$/) as string,
      mimeType: 'application/pdf',
      isPdf: true,
    });
  });

  it('treats a single image upload as an image document', async () => {
    const result = await service.processAndMergeFiles(
      [makeFile(png1x1, 'card.png', 'image/png')],
      'Form 138',
    );

    expect(result.isPdf).toBe(false);
    expect(result.mimeType).toBe('image/png');
    expect(result.fileName).toBe('card.png');
  });

  it('merges multiple images into a unified multi-page PDF', async () => {
    const result = await service.processAndMergeFiles(
      [
        makeFile(png1x1, 'front.png', 'image/png'),
        makeFile(png1x1, 'back.png', 'image/png'),
      ],
      'Form 138',
    );

    expect(result.isPdf).toBe(true);
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result.fileName).toMatch(/^form_138_combined_\d+\.pdf$/);

    const merged = await PDFDocument.load(result.buffer);
    expect(merged.getPageCount()).toBe(2);
  });

  it('merges a PDF and an image and keeps both pages', async () => {
    const pdfBuffer = await makePdfPage();

    const result = await service.processAndMergeFiles(
      [
        makeFile(pdfBuffer, 'page1.pdf', 'application/pdf'),
        makeFile(png1x1, 'page2.png', 'image/png'),
      ],
      'TOR',
    );

    const merged = await PDFDocument.load(result.buffer);
    expect(merged.getPageCount()).toBe(2);
  });

  it('skips empty buffers without failing the merge', async () => {
    const result = await service.processAndMergeFiles(
      [
        makeFile(Buffer.alloc(0), 'empty.png', 'image/png'),
        makeFile(png1x1, 'card.png', 'image/png'),
      ],
      'Form 138',
    );

    const merged = await PDFDocument.load(result.buffer);
    expect(merged.getPageCount()).toBe(1);
  });

  it('throws BadRequestException when no valid pages or images can be extracted', async () => {
    // Two empty files force the multi-file merge path, where the page count ends at 0.
    await expect(
      service.processAndMergeFiles(
        [
          makeFile(Buffer.alloc(0), 'empty1.png', 'image/png'),
          makeFile(Buffer.alloc(0), 'empty2.png', 'image/png'),
        ],
        'Form 138',
      ),
    ).rejects.toThrow(
      new BadRequestException(
        'Could not extract any valid pages or images from the provided files.',
      ),
    );
  });

  it('rejects unsupported MIME types in multi-file mode', async () => {
    await expect(
      service.processAndMergeFiles(
        [
          makeFile(png1x1, 'card.png', 'image/png'),
          makeFile(Buffer.from('<html>'), 'page.html', 'text/html'),
        ],
        'TOR',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('fails gracefully when a PDF is corrupt', async () => {
    await expect(
      service.processAndMergeFiles(
        [
          makeFile(png1x1, 'card.png', 'image/png'),
          makeFile(
            Buffer.from('not a real pdf'),
            'broken.pdf',
            'application/pdf',
          ),
        ],
        'TOR',
      ),
    ).rejects.toThrow(
      'Failed to combine uploaded files into a unified document',
    );
  });

  it('formats megabyte sizes with two decimals', async () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 1);

    const result = await service.processAndMergeFiles(
      [makeFile(big, 'big.bin', 'application/pdf')],
      'TOR',
    );

    expect(result.fileSize).toBe('2.00 MB');
  });
});
