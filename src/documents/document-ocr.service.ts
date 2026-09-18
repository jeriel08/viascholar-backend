import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ForensicMetadataResult } from './file-forensics.service.js';
import { DocumentReconciliationService } from './document-reconciliation.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { Prisma } from '../generated/prisma/client.js';

import { LlamaExtractService } from './extractors/llama-extract.service.js';
import { ParseurExtractorService } from './extractors/parseur-extractor.service.js';

interface ParseurFieldSet {
  grades?: unknown[];
  [key: string]: unknown;
}

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
    private eventsGateway: EventsGateway,
    private llamaExtractService: LlamaExtractService,
    private parseurExtractor: ParseurExtractorService,
  ) {}

  /**
   * Main entry point for document OCR parsing. Routes to active provider based on OCR_PROVIDER env ('llama-extract' | 'parseur').
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
      return this.sendToParseur(documentId, buffer, fileName, mimeType);
    }

    // Default Strategy: LlamaExtract SDK
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
      try {
        const detectedSchoolName = (extractedData.school_name || '').trim();
        if (detectedSchoolName && doc.scholar_profile_id) {
          // 1. Direct exact match
          let matchedSchool = await this.prisma.schoolGradingSystem.findFirst({
            where: {
              school_name: { equals: detectedSchoolName, mode: 'insensitive' },
            },
          });

          // 2. Intelligent fuzzy/normalized matching against existing configured schools
          if (!matchedSchool) {
            const allSchools = await this.prisma.schoolGradingSystem.findMany();
            const normalize = (s: string) =>
              s
                .toLowerCase()
                .replace(/\([^)]*\)/g, '') // remove parentheticals e.g. (UM), (USEP), (ADDU), (DepEd Standard)
                .replace(/[^a-z0-9]/g, '')
                .trim();

            const normalizedDetected = normalize(detectedSchoolName);

            // Normalized exact name match (e.g. "University of Mindanao" matches "University of Mindanao (UM)")
            matchedSchool =
              allSchools.find(
                (s) => normalize(s.school_name) === normalizedDetected,
              ) ?? null;

            // Substring or containment match
            if (!matchedSchool) {
              matchedSchool =
                allSchools.find((s) => {
                  const normS = normalize(s.school_name);
                  return (
                    (normS.length > 5 && normalizedDetected.includes(normS)) ||
                    (normalizedDetected.length > 5 &&
                      normS.includes(normalizedDetected))
                  );
                }) ?? null;
            }

            // High school / Senior High fallback to verified DepEd scale
            if (!matchedSchool) {
              const isHighSchool =
                /high\s*school|senior\s*high|junior\s*high|secondary|sf9|form\s*138|sf10/i.test(
                  detectedSchoolName,
                );
              if (isHighSchool) {
                matchedSchool =
                  allSchools.find(
                    (s) =>
                      /high\s*school|senior\s*high|deped/i.test(
                        s.school_name,
                      ) && s.is_verified,
                  ) ?? null;
              }
            }
          }

          let schoolIdToLink = matchedSchool?.school_id;

          // Only create a new unverified school entry if NO existing school matched
          if (!matchedSchool && extractedData.grading_legend) {
            const legend = extractedData.grading_legend;
            const defaultHighest =
              legend.highest_grade ??
              (legend.grading_scale === 'NUMERIC_4_POINT' ? 4.0 : 1.0);
            const defaultPassing =
              legend.passing_grade ??
              (legend.grading_scale === 'NUMERIC_4_POINT' ? 2.0 : 3.0);
            const defaultFailing =
              legend.failing_grade ??
              (legend.grading_scale === 'NUMERIC_4_POINT' ? 1.0 : 5.0);

            const newSchool = await this.prisma.schoolGradingSystem.create({
              data: {
                school_name: detectedSchoolName,
                grading_scale:
                  legend.grading_scale ||
                  (legend.highest_grade === 4
                    ? 'NUMERIC_4_POINT'
                    : 'NUMERIC_5_POINT'),
                highest_grade: defaultHighest,
                passing_grade: defaultPassing,
                failing_grade: defaultFailing,
                special_codes: legend.special_codes
                  ? (legend.special_codes as Prisma.InputJsonValue)
                  : undefined,
                notes:
                  legend.notes ||
                  `Auto-extracted from document: ${legend.legend_title || 'Legend'}`,
                is_verified: false,
                submitted_by_user_id: doc.scholar_profile?.user_id,
              },
            });
            schoolIdToLink = newSchool.school_id;
            this.eventsGateway.emitToStaff('school_grading:created', newSchool);
          }

          if (schoolIdToLink || !doc.scholar_profile?.school_name) {
            await this.prisma.scholarProfile.update({
              where: { profile_id: doc.scholar_profile_id },
              data: {
                ...(schoolIdToLink ? { school_id: schoolIdToLink } : {}),
                ...(!doc.scholar_profile?.school_name
                  ? { school_name: detectedSchoolName }
                  : {}),
              },
            });
          }
        }
      } catch (schoolErr: any) {
        this.logger.warn(
          `Could not auto-link school grading system: ${schoolErr.message}`,
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

      if (doc.scholar_profile?.user_id) {
        this.eventsGateway.emitToUser(
          doc.scholar_profile.user_id,
          'document:ocr_completed',
          {
            documentId: doc.document_id,
            scholarProfileId: doc.scholar_profile_id,
            status: validationStatus,
            documentType: doc.document_type,
            hasGrades,
          },
        );
      }

      this.eventsGateway.emitToStaff('document:ocr_completed', {
        documentId: doc.document_id,
        scholarProfileId: doc.scholar_profile_id,
        status: validationStatus,
        documentType: doc.document_type,
        hasGrades,
      });

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

      // Transition document from PENDING to NEEDS_REUPLOAD so the UI stops showing infinite 'Analyzing...'
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

          if (doc.scholar_profile?.user_id) {
            this.eventsGateway.emitToUser(
              doc.scholar_profile.user_id,
              'document:ocr_completed',
              {
                documentId: doc.document_id,
                scholarProfileId: doc.scholar_profile_id,
                status: 'NEEDS_REUPLOAD',
                documentType: doc.document_type,
                hasGrades: false,
                errorMessage: failureReason,
              },
            );
          }

          this.eventsGateway.emitToStaff('document:ocr_completed', {
            documentId: doc.document_id,
            scholarProfileId: doc.scholar_profile_id,
            status: 'NEEDS_REUPLOAD',
            documentType: doc.document_type,
            hasGrades: false,
            errorMessage: failureReason,
          });
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

    // Set document back to PENDING
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

  // Uploads the document buffer to the Parseur mailbox
  async sendToParseur(
    documentId: number,
    buffer: Buffer,
    fileName: string,
    mimeType: string,
  ) {
    const apiKey = this.configService.get<string>('PARSEUR_API_KEY');
    const mailboxId = this.configService.get<string>('PARSEUR_MAILBOX_ID');

    if (!apiKey || !mailboxId) {
      this.logger.warn(
        'Parseur credentials missing in .env. Skipping automated OCR trigger.',
      );
      return null;
    }

    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      fileName,
    );
    form.append('viascholar_document_id', String(documentId));

    const response = await fetch(
      `https://api.parseur.com/parser/${mailboxId}/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
        },
        body: form,
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Parseur API responded with status ${response.status}: ${errorBody}`,
      );
    }

    const data = (await response.json()) as {
      attachments?: { DocumentID?: string | number }[];
    };

    this.logger.debug(
      `Parseur upload response for doc ${documentId}: ${JSON.stringify(data)}`,
    );

    const parseurDocId = data.attachments?.[0]?.DocumentID;
    if (parseurDocId != null) {
      await this.prisma.scholarDocument.update({
        where: { document_id: documentId },
        data: { parseur_doc_id: String(parseurDocId) },
      });
      this.logger.log(
        `Document ID ${documentId} dispatched to Parseur successfully (Parseur Doc ID: ${parseurDocId}).`,
      );
    } else {
      this.logger.warn(
        `Parseur upload succeeded for doc ${documentId} but no DocumentID was returned in the response.`,
      );
    }

    return data;
  }

  // Retrieve OCR-extracted fields and smart warnings for a document
  async getExtractedData(
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

    const isOwner = doc.scholar_profile.user_id === userId;
    const isStaff = ['ADMIN', 'GRANTOR', 'COORDINATOR'].includes(callerRole);

    if (!isOwner && !isStaff) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const extracted = (doc.extracted_data ?? {}) as ExtractedDocumentData;
    const gradeCount = Array.isArray(extracted.grades)
      ? extracted.grades.length
      : 0;
    const isForm138 =
      /138|137|report card|high school/i.test(doc.document_type || '') ||
      /138|137|report card|high school/i.test(doc.label || '');

    const smartWarnings: string[] = [];
    if (['PENDING', 'PASSED_PRECHECK', 'NEEDS_REUPLOAD'].includes(doc.status)) {
      if (isForm138 && gradeCount > 0 && gradeCount < 6) {
        smartWarnings.push(
          `Only ${gradeCount} subjects were detected. If your Form 138 has multiple quarters/semesters across 2 pages (front & back), please verify both sides were uploaded or use 'Replace Document'.`,
        );
      }
      if (gradeCount > 0 && extracted.general_average == null) {
        smartWarnings.push(
          'General Average was not automatically detected on this document. You can manually enter your General Average or let the system compute it from subject grades.',
        );
      }
    }

    return {
      document_id: doc.document_id,
      document_type: doc.document_type,
      label: doc.label,
      file_url: doc.file_url,
      file_name: doc.file_name,
      file_size: doc.file_size,
      status: doc.status,
      rejection_reason: doc.rejection_reason,
      extracted_data: doc.extracted_data,
      confirmed_data: doc.confirmed_data,
      smart_warnings: smartWarnings,
      forensic_analysis: extracted.forensic_analysis ?? null,
      uploaded_at: doc.uploaded_at,
    };
  }

  // Staff re-fetches Parseur results for documents whose webhook was missed
  async syncFromParseur(actorUserId: number, documentId: number) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) {
      throw new NotFoundException(`Document ID ${documentId} not found.`);
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: actorUserId },
      select: { role: true },
    });
    const isOwner = doc.scholar_profile?.user_id === actorUserId;
    const isStaff = ['ADMIN', 'GRANTOR', 'COORDINATOR'].includes(
      user?.role || '',
    );
    if (!isOwner && !isStaff) {
      throw new ForbiddenException(
        'You do not have permission to sync this document.',
      );
    }

    if (!doc.parseur_doc_id) {
      throw new BadRequestException(
        `Document ID ${documentId} was never dispatched to Parseur.`,
      );
    }

    const apiKey = this.configService.get<string>('PARSEUR_API_KEY');
    if (!apiKey) {
      throw new BadRequestException('PARSEUR_API_KEY is not configured.');
    }

    const response = await fetch(
      `https://api.parseur.com/document/${doc.parseur_doc_id}`,
      { headers: { Authorization: `Token ${apiKey}` } },
    );

    if (!response.ok) {
      throw new BadRequestException(
        `Parseur API responded with status ${response.status} for document ${doc.parseur_doc_id}.`,
      );
    }

    const meta = (await response.json()) as {
      status?: string;
      result?: string | Record<string, unknown> | null;
    };

    if (meta.status !== 'PARSEDOK') {
      return {
        synced: false,
        message: `Parseur has not finished processing this document (status: ${meta.status ?? 'UNKNOWN'}).`,
      };
    }

    let parsed: Record<string, unknown> | null = null;
    if (typeof meta.result === 'string') {
      try {
        parsed = JSON.parse(meta.result) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    } else if (meta.result && typeof meta.result === 'object') {
      parsed = meta.result;
    }

    const nestedFields =
      parsed && typeof parsed.fields === 'object' && parsed.fields !== null
        ? (parsed.fields as ParseurFieldSet)
        : null;
    const fields: ParseurFieldSet | null = nestedFields ?? parsed;

    if (!fields) {
      return {
        synced: false,
        message:
          'Parseur reported the document as processed but returned no parsable result.',
      };
    }

    const hasGrades = Array.isArray(fields.grades) && fields.grades.length > 0;
    const validationStatus = hasGrades ? 'PASSED_PRECHECK' : 'NEEDS_REUPLOAD';

    // Retrieve initial metadata forensics
    const existingExtracted = (doc.extracted_data ??
      {}) as ExtractedDocumentData;
    const initialMetadataForensics = existingExtracted.forensic_metadata;

    const forensicEvaluation =
      this.documentReconciliationService.evaluateExtractedDocument(
        doc.scholar_profile || {},
        doc.document_type || 'document',
        fields,
        initialMetadataForensics,
      );

    const mergedExtractedData = {
      ...fields,
      forensic_analysis: forensicEvaluation,
      validation_flags: forensicEvaluation.flags,
    };

    const updated = await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status: validationStatus,
        extracted_data: mergedExtractedData as unknown as Prisma.InputJsonValue,
        rejection_reason: hasGrades
          ? null
          : 'Unreadable document or missing grade records.',
      },
    });

    await this.auditService.log(
      actorUserId,
      'DOCUMENT_SYNCED',
      `Staff synced Parseur results for document ID ${documentId}. Status: ${validationStatus}, Risk: ${forensicEvaluation.risk_level}, grade items: ${hasGrades ? fields.grades?.length : 0}.`,
    );

    if (doc.scholar_profile?.user_id) {
      this.eventsGateway.emitToUser(
        doc.scholar_profile.user_id,
        'document:ocr_completed',
        {
          documentId: doc.document_id,
          scholarProfileId: doc.scholar_profile_id,
          status: validationStatus,
          documentType: doc.document_type,
          hasGrades,
        },
      );
    }

    this.eventsGateway.emitToStaff('document:ocr_completed', {
      documentId: doc.document_id,
      scholarProfileId: doc.scholar_profile_id,
      status: validationStatus,
      documentType: doc.document_type,
      hasGrades,
    });

    return {
      synced: true,
      status: updated.status,
      extracted_data: updated.extracted_data,
      forensic_analysis: forensicEvaluation,
    };
  }
}
