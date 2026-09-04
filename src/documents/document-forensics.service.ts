// src/documents/document-forensics.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

export type ForensicRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

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

export interface ForensicEvaluationResult {
  is_flagged: boolean;
  risk_level: ForensicRiskLevel;
  flags: string[];
  summary: string;
  math_reconciliation?: {
    reported_gwa?: number;
    calculated_gwa?: number;
    difference?: number;
    is_consistent: boolean;
  };
  metadata_forensics?: ForensicMetadataResult;
}

@Injectable()
export class DocumentForensicsService {
  private readonly logger = new Logger(DocumentForensicsService.name);

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
   * 1. Inspects raw file buffers (PDFs and Images) for editing software signatures and metadata anomalies.
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

          const combinedText = `${producer} ${creator} ${title} ${author}`.toLowerCase();

          for (const tool of this.suspiciousTools) {
            if (combinedText.includes(tool)) {
              detectedSoftware.add(tool);
              flags.push(`SUSPICIOUS_SOFTWARE_${tool.toUpperCase().replace(/\s+/g, '_')}`);
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
            creation_date: creationDate ? creationDate.toISOString() : undefined,
            modification_date: modDate ? modDate.toISOString() : undefined,
            has_modification_gap: hasModificationGap,
          };
        } catch (err: any) {
          this.logger.debug(`PDF metadata inspection skipped: ${err.message}`);
        }
      }

      // Binary scan for rasterized images or embedded XMP packets (Photoshop, Canva, GIMP tags)
      const asciiChunk = buffer.subarray(0, Math.min(buffer.length, 65536)).toString('binary');
      const utf8Chunk = buffer.subarray(0, Math.min(buffer.length, 65536)).toString('utf-8', 0, Math.min(buffer.length, 65536));
      const content = `${asciiChunk} ${utf8Chunk}`.toLowerCase();

      if (content.includes('photoshop 3.0') || content.includes('adobe photoshop') || content.includes('8bps')) {
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
      image_signatures: imageSignatures.length > 0 ? imageSignatures : undefined,
      flags: uniqueFlags,
    };
  }

  /**
   * 2. Reconciles OCR-extracted data against mathematical invariants, student profile, and signatures.
   */
  evaluateExtractedDocument(
    profile:
      | {
          first_name?: string | null;
          last_name?: string | null;
          course_of_study?: string | null;
        }
      | null
      | undefined,
    documentType: string,
    extractedData: Record<string, any>,
    initialMetadataForensics?: ForensicMetadataResult,
  ): ForensicEvaluationResult {
    const flags: string[] = [...(initialMetadataForensics?.flags || [])];
    const rawGrades = Array.isArray(extractedData.grades)
      ? extractedData.grades
      : [];
    // Only include subjects that have actual numeric grades recorded
    const grades = rawGrades.filter(
      (g) => g.grade != null && !isNaN(Number(g.grade)) && Number(g.grade) > 0,
    );


    const isForm138 =
      /138|137|report card|high school|shs|senior high/i.test(documentType || '') ||
      /138|137|report card|high school|shs|senior high/i.test(extractedData.label || '');

    // 1. Math Reconciliation & Semester-Aware Verification
    let mathResult: ForensicEvaluationResult['math_reconciliation'];
    const reportedGwaRaw = extractedData.general_average;
    const reportedGwa =
      reportedGwaRaw != null && !isNaN(Number(reportedGwaRaw))
        ? Number(reportedGwaRaw)
        : undefined;

    // Check for explicit 1st & 2nd semester averages (from Parseur fields or computed from semester-tagged subjects)
    const sem1Raw =
      extractedData.first_sem_average ??
      extractedData.first_semester_average ??
      extractedData.sem1_average ??
      extractedData.first_sem_gwa;
    const sem2Raw =
      extractedData.second_sem_average ??
      extractedData.second_semester_average ??
      extractedData.sem2_average ??
      extractedData.second_sem_gwa;

    let sem1 = sem1Raw != null && !isNaN(Number(sem1Raw)) ? Number(sem1Raw) : null;
    let sem2 = sem2Raw != null && !isNaN(Number(sem2Raw)) ? Number(sem2Raw) : null;

    // Fallback: If not explicitly extracted, calculate sem1 and sem2 averages from semester-tagged subjects
    if (sem1 == null || sem2 == null) {
      const sem1Items = grades.filter((g) => /1st|first/i.test(g.semester || ''));
      const sem2Items = grades.filter((g) => /2nd|second/i.test(g.semester || ''));
      if (sem1Items.length > 0 && sem1 == null) {
        sem1 = sem1Items.reduce((acc, i) => acc + Number(i.grade), 0) / sem1Items.length;
      }
      if (sem2Items.length > 0 && sem2 == null) {
        sem2 = sem2Items.reduce((acc, i) => acc + Number(i.grade), 0) / sem2Items.length;
      }
    }

    if (grades.length > 0 || (sem1 != null && sem2 != null)) {
      let computedGwa = 0;

      if (grades.length > 0) {
        if (isForm138) {
          // High School: Simple arithmetic mean of non-sub-subject grades
          const hasMapeh = grades.some((i) =>
            /^mapeh$/i.test(i.subject_code || i.subject_name || ''),
          );
          const mapehSubSubjects = /^(music|arts|physical education|pe|health)$/i;

          const coreGrades = hasMapeh
            ? grades.filter(
                (i) =>
                  !mapehSubSubjects.test(i.subject_name || '') &&
                  !mapehSubSubjects.test(i.subject_code || ''),
              )
            : grades;

          const sum = coreGrades.reduce(
            (acc, item) => acc + Number(item.grade),
            0,
          );
          computedGwa = coreGrades.length > 0 ? sum / coreGrades.length : 0;
        } else {
          // College: Weighted average by units
          let totalUnits = 0;
          let weightedSum = 0;
          for (const item of grades) {
            const units = Number(item.units) > 0 ? Number(item.units) : 1;
            const grade = Number(item.grade);
            totalUnits += units;
            weightedSum += grade * units;
          }
          computedGwa = totalUnits > 0 ? weightedSum / totalUnits : 0;
        }
      } else if (sem1 != null && sem2 != null) {
        computedGwa = (sem1 + sem2) / 2;
      }


      if (reportedGwa != null && (computedGwa > 0 || (sem1 != null && sem2 != null))) {
        let diff = Math.abs(reportedGwa - computedGwa);

        // Check if reported GWA matches the mean of the 2 semestral averages (with DepEd rounding)
        if (sem1 != null && sem2 != null) {
          const semMean = (sem1 + sem2) / 2;
          const semDiff = Math.abs(reportedGwa - semMean);
          if (semDiff < diff) {
            diff = semDiff;
          }
        }

        // Calibrated Tolerances:
        // On 100% scale: <= 1.5 pts is normal (DepEd semestral rounding or minor quarter averaging).
        // On 5.0 scale: <= 0.15 is normal.
        const isNumericScale = computedGwa <= 5.0 && computedGwa > 0;
        const normalTolerance = isNumericScale ? 0.15 : 1.5;
        const moderateTolerance = isNumericScale ? 0.35 : 3.5;

        const isConsistent = diff <= normalTolerance;

        if (!isConsistent) {
          if (diff <= moderateTolerance) {
            flags.push('MODERATE_MATH_VARIANCE');
          } else {
            flags.push('SEVERE_MATH_DISCREPANCY');
          }
        }

        mathResult = {
          reported_gwa: Number(reportedGwa.toFixed(2)),
          calculated_gwa: Number(computedGwa.toFixed(2)),
          difference: Number(diff.toFixed(2)),
          is_consistent: isConsistent,
        };
      }
    }

    // 2. Impossible Grade Range Validation
    for (const g of grades) {
      const val = Number(g.grade);
      if (val > 100 || (val > 5.0 && val < 50)) {
        flags.push('ANOMALOUS_GRADE_VALUE_DETECTED');
        break;
      }
    }

    // 3. Student Identity Matching
    if (profile) {
      const extractedName = (
        extractedData.student_name ||
        extractedData.name ||
        ''
      ).toLowerCase();
      const firstName = (profile.first_name || '').toLowerCase();
      const lastName = (profile.last_name || '').toLowerCase();

      if (extractedName.length > 3 && (firstName || lastName)) {
        const hasFirst = firstName && extractedName.includes(firstName);
        const hasLast = lastName && extractedName.includes(lastName);
        if (!hasFirst && !hasLast) {
          flags.push('STUDENT_NAME_MISMATCH');
        }
      }

      // Only check course mismatch for College TOR / Grade Slips (Skip for High School Form 138)
      if (!isForm138 && profile.course_of_study && extractedData.course_name) {
        const extractedCourse = String(extractedData.course_name).toLowerCase();
        const registeredCourse = profile.course_of_study.toLowerCase();
        if (
          !extractedCourse.includes(registeredCourse) &&
          !registeredCourse.includes(extractedCourse)
        ) {
          flags.push('COURSE_MISMATCH');
        }
      }
    }

    // 4. Registrar Signature / Seal Check
    const hasSig =
      String(extractedData.has_signature).toLowerCase() === 'true' ||
      extractedData.has_signature === true;
    if (extractedData.has_signature != null && !hasSig) {
      flags.push('MISSING_REGISTRAR_SIGNATURE');
    }

    const uniqueFlags = Array.from(new Set(flags));

    // 5. Risk Level Calculation
    let riskLevel: ForensicRiskLevel = 'LOW';
    const highRiskFlags = [
      'SEVERE_MATH_DISCREPANCY',
      'SUSPICIOUS_SOFTWARE_PHOTOSHOP',
      'SUSPICIOUS_SOFTWARE_CANVA',
      'SUSPICIOUS_SOFTWARE_PHOTOPEA',
      'SUSPICIOUS_SOFTWARE_GIMP',
      'ANOMALOUS_GRADE_VALUE_DETECTED',
    ];
    const mediumRiskFlags = [
      'MODERATE_MATH_VARIANCE',
      'STUDENT_NAME_MISMATCH',
      'MISSING_REGISTRAR_SIGNATURE',
      'PDF_MODIFIED_LONG_AFTER_CREATION',
      'COURSE_MISMATCH',
    ];

    if (uniqueFlags.some((f) => highRiskFlags.includes(f))) {
      riskLevel = 'HIGH';
    } else if (uniqueFlags.some((f) => mediumRiskFlags.includes(f))) {
      riskLevel = 'MEDIUM';
    }

    // Friendly human-readable summary for Coordinators
    let summary = 'Document passed forensic baseline check with zero tampering indicators.';
    const detectedSoft = initialMetadataForensics?.detected_software || [];

    if (detectedSoft.length > 0) {
      summary = `High tampering risk: Document asset contains signatures of graphic editing tool (${detectedSoft.join(', ')}).`;
    } else if (uniqueFlags.includes('SEVERE_MATH_DISCREPANCY')) {
      summary = `High risk discrepancy: Reported GWA (${mathResult?.reported_gwa}) deviates significantly from calculated subject average (${mathResult?.calculated_gwa}).`;
    } else if (uniqueFlags.includes('MODERATE_MATH_VARIANCE')) {
      summary = `Review advisory: Slight difference (${mathResult?.difference} pts) between printed GWA (${mathResult?.reported_gwa}) and subject grades (${mathResult?.calculated_gwa}). Likely due to semester weighting or non-credit subjects.`;
    } else if (uniqueFlags.includes('STUDENT_NAME_MISMATCH')) {
      summary = `Review advisory: Extracted student name does not closely match registered profile name.`;
    } else if (uniqueFlags.includes('MISSING_REGISTRAR_SIGNATURE')) {
      summary = `Review advisory: Official registrar signature or dry seal was not clearly detected.`;
    }

    return {
      is_flagged: riskLevel !== 'LOW',
      risk_level: riskLevel,
      flags: uniqueFlags,
      summary,
      math_reconciliation: mathResult,
      metadata_forensics: initialMetadataForensics,
    };
  }
}

