import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentStatus } from '../generated/prisma/enums.js';

@Injectable()
export class DocumentValidationService {
  constructor(private prisma: PrismaService) {}

  async validateExtractedDocument(documentId: number, parseurData: any) {
    const doc = await this.prisma.scholarDocument.findUnique({
      where: { document_id: documentId },
      include: { scholar_profile: true },
    });

    if (!doc) return;

    const profile = doc.scholar_profile;
    const flags: string[] = [];

    // 1. Name Check (Handles "SANAO, JERIEL LIAN DANGO" vs "Jeriel Lian Sanao")
    const extractedName = (parseurData.student_name || '').toLowerCase();
    const firstName = profile.first_name.toLowerCase();
    const lastName = profile.last_name.toLowerCase();

    const nameMatches =
      extractedName.includes(firstName) || extractedName.includes(lastName);
    if (!nameMatches && extractedName.length > 0) {
      flags.push('STUDENT_NAME_MISMATCH');
    }

    // 2. Soft Course Check (Only evaluate if course_name exists on the document)
    if (profile.course_of_study && parseurData.course_name) {
      const extractedCourse = parseurData.course_name.toLowerCase();
      const registeredCourse = profile.course_of_study.toLowerCase();
      if (
        !extractedCourse.includes(registeredCourse) &&
        !registeredCourse.includes(extractedCourse)
      ) {
        flags.push('COURSE_MISMATCH');
      }
    }

    // 3. Signature Check (Parseur string "true" / "false")
    const hasSignature =
      String(parseurData.has_signature).toLowerCase() === 'true';
    if (!hasSignature) {
      flags.push('MISSING_REGISTRAR_SIGNATURE');
    }

    // 4. Valid Grades Check (Ensures there is at least one completed subject)
    const validGrades = Array.isArray(parseurData.grades)
      ? parseurData.grades.filter(
          (g: any) => Number(g.units) > 0 && Number(g.grade) > 0,
        )
      : [];

    if (validGrades.length === 0) {
      flags.push('NO_COMPLETED_GRADES_FOUND');
    }

    // Determine Status
    const isPassingPrecheck = flags.length === 0;
    const status = isPassingPrecheck
      ? DocumentStatus.PASSED_PRECHECK
      : DocumentStatus.NEEDS_REUPLOAD;

    await this.prisma.scholarDocument.update({
      where: { document_id: documentId },
      data: {
        status,
        rejection_reason: flags.length > 0 ? flags.join(', ') : null,
        extracted_data: {
          ...parseurData,
          completed_subjects_count: validGrades.length,
          validation_flags: flags,
        },
      },
    });

    return { status, flags };
  }
}
