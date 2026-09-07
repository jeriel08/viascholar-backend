import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

export interface ForensicMetadataResult {
  is_flagged: boolean;
  detected_software: string[];
  pdf_metadata?: {
    producer?: string;
    creator?: string;
    title?: string;
    author?: string;
    creation_date?: string;
    modification_date?: string;
    has_modification_gap?: boolean;
  };
  image_signatures?: string[];
  flags: string[];
}

@Injectable()
export class FileForensicsService {
  private readonly logger = new Logger(FileForensicsService.name);

  private readonly suspiciousTools = [
    'photoshop',
    'canva',
    'gimp',
    'photopea',
    'pdfescape',
    'sejda',
    'ilovepdf',
    'smallpdf',
    'illustrator',
    'coreldraw',
    'inkscape',
    'indesign',
    'wondershare',
    'foxit phantom',
    'nitro pro',
    'acrobat distill',
  ];

  /**
   * Inspects raw file buffers (PDFs and Images) for editing software signatures and metadata anomalies.
   */
  async inspectFileMetadata(
    files: { buffer: Buffer; mimeType?: string; originalname?: string }[],
  ): Promise<ForensicMetadataResult> {
    const flags: string[] = [];
    const detectedSoftware = new Set<string>();
    let pdfMetadataResult: ForensicMetadataResult['pdf_metadata'];
    const imageSignatures: string[] = [];

    for (const file of files) {
      const buffer = file.buffer;
      if (!buffer || buffer.length === 0) continue;

      const isPdf =
        file.mimeType?.includes('pdf') ||
        file.originalname?.toLowerCase().endsWith('.pdf') ||
        buffer.subarray(0, 5).toString('ascii').startsWith('%PDF-');

      if (isPdf) {
        try {
          const pdfDoc = await PDFDocument.load(buffer, {
            ignoreEncryption: true,
          });
          const producer = (pdfDoc.getProducer() || '').trim();
          const creator = (pdfDoc.getCreator() || '').trim();
          const title = (pdfDoc.getTitle() || '').trim();
          const author = (pdfDoc.getAuthor() || '').trim();
          const creationDate = pdfDoc.getCreationDate();
          const modDate = pdfDoc.getModificationDate();

          const combinedText =
            `${producer} ${creator} ${title} ${author}`.toLowerCase();

          for (const tool of this.suspiciousTools) {
            if (combinedText.includes(tool)) {
              detectedSoftware.add(tool);
              flags.push(
                `SUSPICIOUS_SOFTWARE_${tool.toUpperCase().replace(/\s+/g, '_')}`,
              );
            }
          }

          let hasModificationGap = false;
          if (creationDate && modDate) {
            const diffDays =
              Math.abs(modDate.getTime() - creationDate.getTime()) /
              (1000 * 60 * 60 * 24);
            // If modified > 14 days after creation, flag potential post-issuance tampering
            if (diffDays > 14) {
              hasModificationGap = true;
              flags.push('PDF_MODIFIED_LONG_AFTER_CREATION');
            }
          }

          pdfMetadataResult = {
            producer: producer || undefined,
            creator: creator || undefined,
            title: title || undefined,
            author: author || undefined,
            creation_date: creationDate
              ? creationDate.toISOString()
              : undefined,
            modification_date: modDate ? modDate.toISOString() : undefined,
            has_modification_gap: hasModificationGap,
          };
        } catch (err: any) {
          this.logger.debug(`PDF metadata inspection skipped: ${err.message}`);
        }
      }

      // Binary scan for rasterized images or embedded XMP packets (Photoshop, Canva, GIMP tags)
      const asciiChunk = buffer
        .subarray(0, Math.min(buffer.length, 65536))
        .toString('binary');
      const utf8Chunk = buffer
        .subarray(0, Math.min(buffer.length, 65536))
        .toString('utf-8', 0, Math.min(buffer.length, 65536));
      const content = `${asciiChunk} ${utf8Chunk}`.toLowerCase();

      if (
        content.includes('photoshop 3.0') ||
        content.includes('adobe photoshop') ||
        content.includes('8bps')
      ) {
        detectedSoftware.add('photoshop');
        imageSignatures.push('Adobe Photoshop signature in image header');
        flags.push('SUSPICIOUS_SOFTWARE_PHOTOSHOP');
      }

      if (content.includes('canva')) {
        detectedSoftware.add('canva');
        imageSignatures.push('Canva graphic asset tag detected');
        flags.push('SUSPICIOUS_SOFTWARE_CANVA');
      }

      if (content.includes('photopea')) {
        detectedSoftware.add('photopea');
        imageSignatures.push('Photopea web editor signature detected');
        flags.push('SUSPICIOUS_SOFTWARE_PHOTOPEA');
      }

      if (content.includes('gimp')) {
        detectedSoftware.add('gimp');
        imageSignatures.push('GIMP graphic editor signature detected');
        flags.push('SUSPICIOUS_SOFTWARE_GIMP');
      }
    }

    const uniqueSoftware = Array.from(detectedSoftware);
    const uniqueFlags = Array.from(new Set(flags));

    return {
      is_flagged: uniqueFlags.length > 0,
      detected_software: uniqueSoftware,
      pdf_metadata: pdfMetadataResult,
      image_signatures:
        imageSignatures.length > 0 ? imageSignatures : undefined,
      flags: uniqueFlags,
    };
  }
}
