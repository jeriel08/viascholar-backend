import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { Prisma } from '../../generated/prisma/client.js';
import { LlamaExtractService } from '../extractors/llama-extract.service.js';
import { ForensicMetadataResult } from './file-forensics.service.js';
import { DocumentReconciliationService } from './document-reconciliation.service.js';
import { DocumentSchoolLinkerService } from './document-school-linker.service.js';
import { ParseurSyncService } from './parseur-sync.service.js';
import { DocumentDataQueryService } from './document-data-query.service.js';

interface ExtractedDocumentData {
  academic_year?: string;
  general_average?: number;
  grades?: unknown[];
  forensic_analysis?: unknown;
  forensic_metadata?: ForensicMetadataResult;
  [key: string]: unknown;
}

@Injectable()
export class DocumentOcrService {
  private readonly logger = new Logger(DocumentOcrService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private auditService: AuditService,
    private documentReconciliationService: DocumentReconciliationService,
    private documentSchoolLinkerService: DocumentSchoolLinkerService,
    private parseurSyncService: ParseurSyncService,
    private documentDataQueryService: DocumentDataQueryService,
    private eventsGateway: EventsGateway,
    private llamaExtractService: LlamaExtractService,
  ) {}

  /**
   * Main entry point for document OCR parsing.
   */
  async processDocumentExtraction(
    documentId: number,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
    documentType: string = 'document',
    rawFiles?: Express.Multer.File[],
  ) {
    const provider = (
      this.configService.get<string>('OCR_PROVIDER') || 'llama-extract'
    ).toLowerCase();

    this.logger.log(
      `Processing OCR for Document ID ${documentId} using provider '${provider}'...`,
    );

    if (provider === 'parseur') {
      return this.parseurSyncService.sendToParseur(
        documentId,
        buffer,
        fileName,
        mimeType,
      );
    }

    try {
      const doc = await this.prisma.scholarDocument.findUnique({
        where: { document_id: documentId },
        include: { scholar_profile: true },
      });

      if (!doc) {
        throw new NotFoundException(`Document ID ${documentId} not found.`);
      }

      const inputFiles = [
        {
          buffer,
          mimeType,
          fileName,
          fileUrl: doc.file_url,
        },
      ];

      const extractedData = await this.llamaExtractService.extractData(
        inputFiles,
        documentType,
      );

      const existingExtracted = (doc.extracted_data ??
        {}) as ExtractedDocumentData;
      const initialMetadataForensics = existingExtracted.forensic_metadata;

      const detectedDocType = extractedData.detected_document_type;
      const scholarYearLevel = doc.scholar_profile?.current_year_level ?? 1;
      const isUpperclassman = scholarYearLevel >= 2;

      let isInvalidOrMismatchedType = false;
      let mismatchRejectionReason: string | null = null;

      if (
        detectedDocType === 'STATEMENT_OF_ACCOUNT' ||
        detectedDocType === 'OTHER'
      ) {
        isInvalidOrMismatchedType = true;
        mismatchRejectionReason = `Invalid document type: The uploaded document appears to be ${detectedDocType === 'STATEMENT_OF_ACCOUNT' ? 'a Statement of Account / Billing' : 'an unsupported document'}, not an official grade report or transcript. Please upload a valid grade record.`;
      } else if (isUpperclassman && detectedDocType === 'FORM_138') {
        isInvalidOrMismatchedType = true;
        mismatchRejectionReason = `Document type mismatch: As a Year ${scholarYearLevel} scholar, you are required to upload a Transcript of Records (TOR) or Certificate of Grades (COG). A High School Report Card (Form 138/SF9) was detected.`;
      } else if (
        !isUpperclassman &&
        doc.document_type !== 'CCG' &&
        documentType !== 'CCG' &&
        (detectedDocType === 'TRANSCRIPT_OF_RECORDS' ||
          detectedDocType === 'CERTIFICATE_OF_GRADES')
      ) {
        isInvalidOrMismatchedType = true;
        mismatchRejectionReason = `Document type mismatch: As a 1st year applicant, you are required to upload your Senior High School Form 138 or Form 9 report card. A college transcript / certificate of grades was detected.`;
      }

      const hasGrades =
        Array.isArray(extractedData.grades) && extractedData.grades.length > 0;
      const validationStatus =
        hasGrades && !isInvalidOrMismatchedType
          ? 'PASSED_PRECHECK'
          : 'NEEDS_REUPLOAD';

      const forensicEvaluation =
        this.documentReconciliationService.evaluateExtractedDocument(
          doc.scholar_profile || {},
          doc.document_type || documentType,
          extractedData as Record<string, unknown>,
          initialMetadataForensics,
        );

      const mergedExtractedData = {
        ...extractedData,
        forensic_analysis: forensicEvaluation,
        validation_flags: forensicEvaluation.flags,
      };

      // Auto-register or link school grading system from extracted data
      if (doc.scholar_profile_id) {
        await this.documentSchoolLinkerService.linkSchoolGradingSystem(
          doc.scholar_profile_id,
          doc.scholar_profile?.user_id,
          extractedData.school_name || '',
          extractedData.grading_legend,
          doc.scholar_profile?.school_name,
        );
      }

      const finalRejectionReason = isInvalidOrMismatchedType
        ? mismatchRejectionReason
        : hasGrades
          ? null
          : 'Unreadable document or missing grade records.';

      const updated = await this.prisma.scholarDocument.update({
        where: { document_id: documentId },
        data: {
          status: validationStatus,
          extracted_data:
            mergedExtractedData as unknown as Prisma.InputJsonValue,
          rejection_reason: finalRejectionReason,
        },
      });

      await this.auditService.log(
        doc.scholar_profile?.user_id || 0,
        'DOCUMENT_OCR_PROCESSED',
        `LlamaExtract OCR finished for document ID ${documentId}. Status: ${validationStatus}, Risk: ${forensicEvaluation.risk_level}, grade items: ${hasGrades ? extractedData.grades?.length : 0}.`,
      );

      const ocrPayload = {
        documentId: doc.document_id,
        scholarProfileId: doc.scholar_profile_id,
        status: validationStatus,
        documentType: doc.document_type,
        hasGrades,
      };

      if (doc.scholar_profile?.user_id) {
        this.eventsGateway.emitToUser(
          doc.scholar_profile.user_id,
          'document:ocr_completed',
          ocrPayload,
        );
      }
      this.eventsGateway.emitToStaff('document:ocr_completed', ocrPayload);

      return {
        processed: true,
        provider: 'llama-extract',
        status: updated.status,
        extracted_data: updated.extracted_data,
        forensic_analysis: forensicEvaluation,
      };
    } catch (err: any) {
      this.logger.error(
        `LlamaExtract OCR extraction failed for document ID ${documentId}: ${err.message}`,
        err.stack,
      );

      try {
        const doc = await this.prisma.scholarDocument.findUnique({
          where: { document_id: documentId },
          include: { scholar_profile: true },
        });

        if (doc && doc.status === 'PENDING') {
          const failureReason =
            'AI analysis was unable to extract grades from this file. You can retry AI Analysis, replace the file, or enter grades manually.';

          await this.prisma.scholarDocument.update({
            where: { document_id: documentId },
            data: {
              status: 'NEEDS_REUPLOAD',
              rejection_reason: failureReason,
            },
          });

          const errorPayload = {
            documentId: doc.document_id,
            scholarProfileId: doc.scholar_profile_id,
            status: 'NEEDS_REUPLOAD',
            documentType: doc.document_type,
            hasGrades: false,
            errorMessage: failureReason,
          };

          if (doc.scholar_profile?.user_id) {
            this.eventsGateway.emitToUser(
              doc.scholar_profile.user_id,
              'document:ocr_completed',
              errorPayload,
            );
          }
          this.eventsGateway.emitToStaff('document:ocr_completed', errorPayload);
        }
      } catch (dbErr: any) {
        this.logger.error(
          `Failed to record OCR failure in database for doc ${documentId}: ${dbErr.message}`,
        );
      }

      throw err;
    }
  }

  /**
   * Retries AI OCR extraction on an already uploaded document file
   */
  async retryDocumentOcr(
    userId: number,
    documentId: number,
    callerRole: string,
  ) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const isOwner = doc.scholar_profile?.user_id === userId;
    const isStaff = ['ADMIN', 'GRANTOR', 'COORDINATOR'].includes(callerRole);

    if (!isOwner && !isStaff) {
      throw new ForbiddenException(
        'You do not have permission to retry OCR on this document.',
      );
    }

    if (doc.status === 'VERIFIED') {
      throw new BadRequestException(
        'Verified documents cannot be re-extracted.',
      );
    }

    if (!doc.file_url) {
      throw new BadRequestException(
        'Document has no valid file URL to re-process.',
      );
    }

    await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: 'PENDING',
        rejection_reason: null,
      },
    });

    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:ocr_completed',
        {
          documentId: doc.document_id,
          scholarProfileId: doc.scholar_profile_id,
          status: 'PENDING',
          documentType: doc.document_type,
          hasGrades: false,
        },
      );
    }

    this.logger.log(
      `Downloading stored file from '${doc.file_url}' to retry OCR for document ID ${documentId}...`,
    );

    const fileRes = await fetch(doc.file_url);
    if (!fileRes.ok) {
      throw new BadRequestException(
        `Failed to download stored file from storage (${fileRes.status}).`,
      );
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType =
      fileRes.headers.get('content-type') ||
      (doc.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg');

    return this.processDocumentExtraction(
      doc.document_id,
      buffer,
      doc.file_name || 'document.pdf',
      mimeType,
      doc.document_type || 'document',
    );
  }

  // Retrieve OCR-extracted fields and smart warnings for a document
  getExtractedData(
    userId: number,
    documentId: number,
    callerRole: string,
  ) {
    return this.documentDataQueryService.getExtractedData(userId, documentId, callerRole);
  }

  // Delegated Parseur sync methods
  sendToParseur(
    documentId: number,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ) {
    return this.parseurSyncService.sendToParseur(
      documentId,
      buffer,
      fileName,
      mimeType,
    );
  }

  syncFromParseur(actorUserId: number, documentId: number) {
    return this.parseurSyncService.syncFromParseur(actorUserId, documentId);
  }
}
