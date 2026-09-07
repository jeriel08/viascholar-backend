// src/documents/pdf-merger.service.ts
import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

export interface ProcessedDocumentFile {
  buffer: Buffer;
  fileName: string;
  fileSize: string;
  mimeType: string;
  isPdf: boolean;
}

@Injectable()
export class PdfMergerService {
  private readonly logger = new Logger(PdfMergerService.name);

  /**
   * Formats a byte size into human readable string (KB / MB).
   */
  private formatFileSize(bytes: number): string {
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /**
   * Sanitizes document label/type for safe filenames.
   */
  private sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  }

  /**
   * Merges multiple files (images and/or PDFs) into a single unified multi-page PDF.
   * If a single file is provided, it processes it as-is without unnecessary conversions.
   */
  async processAndMergeFiles(
    files: Express.Multer.File[],
    documentType: string = 'document',
  ): Promise<ProcessedDocumentFile> {
    if (!files || files.length === 0) {
      throw new BadRequestException('At least one file must be provided.');
    }

    // Single file optimization
    if (files.length === 1) {
      const single = files[0];
      const isPdf = single.mimetype.includes('pdf');
      return {
        buffer: single.buffer,
        fileName: single.originalname,
        fileSize: this.formatFileSize(single.size),
        mimeType: single.mimetype,
        isPdf,
      };
    }

    this.logger.log(
      `Merging ${files.length} files for document type '${documentType}' into a unified multi-page PDF...`,
    );

    try {
      const mergedPdf = await PDFDocument.create();

      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        const mime = (file.mimetype || '').toLowerCase();
        const buffer = file.buffer;

        if (!buffer || buffer.length === 0) {
          this.logger.warn(`Skipping empty buffer for file index ${index}`);
          continue;
        }

        if (mime.includes('pdf')) {
          // Merge pages from existing PDF
          const sourceDoc = await PDFDocument.load(buffer, {
            ignoreEncryption: true,
          });
          const pageIndices = sourceDoc.getPageIndices();
          const copiedPages = await mergedPdf.copyPages(sourceDoc, pageIndices);
          copiedPages.forEach((page) => mergedPdf.addPage(page));
        } else if (mime.includes('jpeg') || mime.includes('jpg')) {
          // Embed JPEG image
          const embeddedImage = await mergedPdf.embedJpg(buffer);
          const page = mergedPdf.addPage([
            embeddedImage.width,
            embeddedImage.height,
          ]);
          page.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: embeddedImage.width,
            height: embeddedImage.height,
          });
        } else if (mime.includes('png')) {
          // Embed PNG image
          const embeddedImage = await mergedPdf.embedPng(buffer);
          const page = mergedPdf.addPage([
            embeddedImage.width,
            embeddedImage.height,
          ]);
          page.drawImage(embeddedImage, {
            x: 0,
            y: 0,
            width: embeddedImage.width,
            height: embeddedImage.height,
          });
        } else {
          throw new BadRequestException(
            `Unsupported file format (${file.mimetype}) for multi-page merging. Please upload JPG, PNG, or PDF files.`,
          );
        }
      }

      if (mergedPdf.getPageCount() === 0) {
        throw new BadRequestException(
          'Could not extract any valid pages or images from the provided files.',
        );
      }

      const mergedPdfBytes = await mergedPdf.save();
      const finalBuffer = Buffer.from(mergedPdfBytes);
      const cleanType = this.sanitizeFileName(documentType);
      const fileName = `${cleanType}_combined_${Date.now()}.pdf`;

      this.logger.log(
        `Successfully merged ${files.length} files into ${mergedPdf.getPageCount()}-page PDF (${this.formatFileSize(finalBuffer.length)}).`,
      );

      return {
        buffer: finalBuffer,
        fileName,
        fileSize: this.formatFileSize(finalBuffer.length),
        mimeType: 'application/pdf',
        isPdf: true,
      };
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      this.logger.error(
        `Failed to merge files into PDF: ${err.message}`,
        err.stack,
      );
      throw new BadRequestException(
        `Failed to combine uploaded files into a unified document: ${err.message}`,
      );
    }
  }
}
