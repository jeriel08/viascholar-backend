import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  CrossDocReconciliationResult,
  EnrollmentAuditResult,
  SubjectAuditDetail,
} from '../dto/enrollment-response.dto.js';
import { EnrolledSubjectItemDto } from '../dto/submit-enrollment.dto.js';

@Injectable()
export class EnrollmentAuditEngineService {
  private readonly logger = new Logger(EnrollmentAuditEngineService.name);

  constructor(private readonly prisma: PrismaService) {}

  normalizeSubjectCode(code: string): string {
    if (!code) return '';
    return code
      .trim()
      .toUpperCase()
      .replace(/[\s\-_.\/\\]+/g, '')
      .replace(/(?<=[A-Z])III$/g, '3')
      .replace(/(?<=[A-Z])II$/g, '2')
      .replace(/(?<=[A-Z])I$/g, '1');
  }

  getBaseSubjectCode(code: string): string {
    if (!code) return '';
    let normalized = this.normalizeSubjectCode(code);
    normalized = normalized
      .replace(/(?:LAB|LEC)$/i, '')
      .replace(/(?<=\d[A-Z]?)L$/i, '')
      .replace(/(?<=\d)L$/i, '');
    return normalized;
  }

  private isNonPrerequisiteToken(token: string): boolean {
    if (!token) return true;
    const clean = token.trim().toLowerCase();
    if (clean.length <= 1) return true;

    const ignorableKeywords = [
      'none',
      'n/a',
      'na',
      'n.a.',
      'n / a',
      '-',
      '--',
      'nil',
      'null',
      'l',
      'lab',
      'lec',
      '/l',
      '/lab',
      '/lec',
      'no prerequisite',
      'no prerequisites',
      'no pre-requisite',
      'none.',
      'none / n/a',
      'n/a.',
      'n/a / none',
    ];
    if (ignorableKeywords.includes(clean)) return true;

    // Academic standing / non-course requirements
    if (
      clean.includes('standing') ||
      clean.includes('year') ||
      clean.includes('level') ||
      clean.includes('units') ||
      clean.includes('graduating') ||
      clean.includes('permission') ||
      clean.includes('consent') ||
      clean.includes('adviser') ||
      clean.includes('regular') ||
      clean.includes('n/a') ||
      clean.includes('none')
    ) {
      return true;
    }

    // Must contain letters and digits or be a known code
    if (!/[a-z]/i.test(clean)) return true;

    return false;
  }

  parsePrerequisiteTokens(rawPrereqs: unknown): string[] {
    if (!rawPrereqs) return [];
    const list: string[] = [];

    const items = Array.isArray(rawPrereqs)
      ? rawPrereqs
      : typeof rawPrereqs === 'string'
        ? [rawPrereqs]
        : [];

    for (const item of items) {
      if (typeof item !== 'string') continue;
      const cleanItem = item.trim();
      if (this.isNonPrerequisiteToken(cleanItem)) continue;

      // Split by commas, semicolons, ampersands, or "and", "or", or "/" when surrounded by whitespace
      const tokens = cleanItem.split(/[,;&|]|\s+(?:and|or)\s+|\s+\/\s+/i);
      for (const t of tokens) {
        const trimmed = t.trim();
        if (trimmed && !this.isNonPrerequisiteToken(trimmed)) {
          list.push(trimmed);
        }
      }
    }

    return list;
  }

  private isSubjectCleared(sub: {
    status?: string | null;
    grade?: any;
    credited_term?: string | null;
    historical_document_id?: number | null;
    remarks?: string | null;
  }): boolean {
    const statusUpper = (sub.status || '').toUpperCase().trim();
    if (['PASSED', 'CREDITED', 'TAKEN', 'COMPLETED', 'CREDIT', 'ENROLLED'].includes(statusUpper)) {
      return true;
    }

    if (sub.grade !== null && sub.grade !== undefined) {
      const g = Number(sub.grade);
      if (!Number.isNaN(g) && g > 0 && g !== 5.0) {
        return true;
      }
    }

    if (sub.credited_term && sub.credited_term.trim() !== '') {
      return true;
    }

    if (sub.historical_document_id != null) {
      return true;
    }

    if (sub.remarks && /passed|credited|cleared|equivalent|enrolled/i.test(sub.remarks)) {
      return true;
    }

    return false;
  }

  async runAudit(
    scholarProfileId: number,
    enrolledSubjects: EnrolledSubjectItemDto[],
    meta?: {
      corStudentId?: string;
      corStudentName?: string;
      soaStudentId?: string;
      soaStudentName?: string;
      academicYear?: string;
      semester?: string;
    },
  ): Promise<EnrollmentAuditResult> {
    const flags: string[] = [];

    // 1. Fetch scholar's prospectus and subjects
    const prospectus = await this.prisma.scholarProspectus.findUnique({
      where: { scholar_profile_id: scholarProfileId },
      include: { subjects: true },
    });

    const curriculumSubjects = prospectus?.subjects || [];
    const normalizedCurriculumMap = new Map<string, (typeof curriculumSubjects)[0]>();

    for (const sub of curriculumSubjects) {
      const normCode = this.normalizeSubjectCode(sub.subject_code);
      const baseCode = this.getBaseSubjectCode(sub.subject_code);
      if (normCode) normalizedCurriculumMap.set(normCode, sub);
      if (baseCode && !normalizedCurriculumMap.has(baseCode)) {
        normalizedCurriculumMap.set(baseCode, sub);
      }
    }

    // Set of cleared subject codes (PASSED, CREDITED, Graded, or Credited Term)
    const clearedCodes = new Set<string>();
    for (const sub of curriculumSubjects) {
      if (this.isSubjectCleared(sub)) {
        const norm = this.normalizeSubjectCode(sub.subject_code);
        const base = this.getBaseSubjectCode(sub.subject_code);
        if (norm) clearedCodes.add(norm);
        if (base) clearedCodes.add(base);
        if (norm && !norm.endsWith('L')) {
          clearedCodes.add(norm + 'L');
        }
      }
    }

    // 2. Audit each enrolled subject
    const subjectsAudit: SubjectAuditDetail[] = [];
    let totalUnits = 0;

    for (const enrolled of enrolledSubjects) {
      const normEnrolledCode = this.normalizeSubjectCode(enrolled.subject_code);
      const baseEnrolledCode = this.getBaseSubjectCode(enrolled.subject_code);
      const units = Number(enrolled.units) || 3.0;
      totalUnits += units;

      const matchedCurriculumSub =
        normalizedCurriculumMap.get(normEnrolledCode) ||
        normalizedCurriculumMap.get(baseEnrolledCode);

      if (!matchedCurriculumSub) {
        // Off-track / unlisted elective
        flags.push(`OFF_TRACK_SUBJECT:${enrolled.subject_code}`);
        subjectsAudit.push({
          subject_code: enrolled.subject_code,
          descriptive_title: enrolled.descriptive_title,
          units: units,
          section: enrolled.section,
          schedule: enrolled.schedule,
          room: enrolled.room,
          status: 'OFF_TRACK',
          remarks: 'Subject code not found in the frozen curriculum baseline.',
        });
        continue;
      }

      // Check prerequisites
      const prereqTokens = this.parsePrerequisiteTokens(matchedCurriculumSub.prerequisites);

      const unmetPrereqs: string[] = [];
      for (const p of prereqTokens) {
        const normP = this.normalizeSubjectCode(p);
        const baseP = this.getBaseSubjectCode(p);
        if (normP && !clearedCodes.has(normP) && !clearedCodes.has(baseP)) {
          unmetPrereqs.push(p);
        }
      }

      if (unmetPrereqs.length > 0) {
        flags.push(`MISSING_PREREQUISITE:${enrolled.subject_code}`);
        subjectsAudit.push({
          subject_code: enrolled.subject_code,
          descriptive_title: matchedCurriculumSub.descriptive_title || enrolled.descriptive_title,
          units: units,
          section: enrolled.section,
          schedule: enrolled.schedule,
          room: enrolled.room,
          status: 'MISSING_PREREQUISITE',
          curriculum_subject_id: matchedCurriculumSub.subject_id,
          unmet_prerequisites: unmetPrereqs,
          remarks: `Prerequisite (${unmetPrereqs.join(', ')}) not cleared in prior terms.`,
        });
      } else {
        subjectsAudit.push({
          subject_code: enrolled.subject_code,
          descriptive_title: matchedCurriculumSub.descriptive_title || enrolled.descriptive_title,
          units: units,
          section: enrolled.section,
          schedule: enrolled.schedule,
          room: enrolled.room,
          status: 'ON_TRACK',
          curriculum_subject_id: matchedCurriculumSub.subject_id,
          remarks: 'Curriculum verified and all prerequisites cleared.',
        });
      }
    }

    // 3. Credit load checks
    let overloadFlag = false;
    let underloadFlag = false;
    if (totalUnits > 24) {
      overloadFlag = true;
      flags.push('OVERLOAD_UNITS');
    } else if (totalUnits < 12 && totalUnits > 0) {
      underloadFlag = true;
      flags.push('UNDERLOAD_UNITS');
    }

    // 4. Cross-document reconciliation
    let crossDocReconciliation: CrossDocReconciliationResult | undefined;
    if (meta?.corStudentId || meta?.soaStudentId || meta?.corStudentName || meta?.soaStudentName) {
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { profile_id: scholarProfileId },
      });

      const mismatches: string[] = [];
      let score = 100;

      const profileStudentId = (scholar?.student_number || '').trim().toLowerCase();
      const corId = (meta.corStudentId || '').trim().toLowerCase();
      const soaId = (meta.soaStudentId || '').trim().toLowerCase();

      let idMatch = true;
      if (corId && soaId && corId !== soaId) {
        idMatch = false;
        mismatches.push('COR and SOA Student ID mismatch');
        score -= 40;
      } else if (corId && profileStudentId && corId !== profileStudentId) {
        idMatch = false;
        mismatches.push('Document Student ID does not match Profile Student Number');
        score -= 30;
      }

      const profileName = `${scholar?.first_name || ''} ${scholar?.last_name || ''}`.trim().toLowerCase();
      const corName = (meta.corStudentName || '').trim().toLowerCase();
      const soaName = (meta.soaStudentName || '').trim().toLowerCase();

      let nameMatch = true;
      if (corName && soaName && !corName.includes(soaName) && !soaName.includes(corName)) {
        nameMatch = false;
        mismatches.push('COR and SOA Student Name mismatch');
        score -= 30;
      }

      crossDocReconciliation = {
        is_match: mismatches.length === 0,
        student_id_match: idMatch,
        student_name_match: nameMatch,
        confidence_score: Math.max(0, score),
        mismatches,
      };

      if (mismatches.length > 0) {
        flags.push(...mismatches.map((m) => `RECONCILIATION_FLAG:${m}`));
      }
    }

    const blockingFlags = flags.filter(
      (f) => !f.startsWith('UNDERLOAD_UNITS'),
    );
    const allCleared = blockingFlags.length === 0;

    return {
      all_cleared: allCleared,
      flags,
      total_units: totalUnits,
      overload_flag: overloadFlag,
      underload_flag: underloadFlag,
      subjects_audit: subjectsAudit,
      cross_doc_reconciliation: crossDocReconciliation,
    };
  }
}
