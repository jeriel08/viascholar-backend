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
  ) {}

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
