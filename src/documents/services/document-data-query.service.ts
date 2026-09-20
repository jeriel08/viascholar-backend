import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ForensicMetadataResult } from './file-forensics.service.js';

interface ExtractedDocumentData {
  academic_year?: string;
  general_average?: number;
  grades?: unknown[];
  forensic_analysis?: unknown;
  forensic_metadata?: ForensicMetadataResult;
  [key: string]: unknown;
}

@Injectable()
export class DocumentDataQueryService {
  constructor(private readonly prisma: PrismaService) {}

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
}
