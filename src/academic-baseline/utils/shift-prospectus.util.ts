export interface ApprovedShiftRecord {
  request_id?: number;
  status?: string;
  reviewed_at?: Date | string | null;
  change_type?: string | null;
  current_course_of_study?: string | null;
  requested_course_of_study?: string | null;
  requested_program?: {
    program_code?: string | null;
    program_name?: string | null;
  } | null;
}

/**
 * Fetches the scholar's most recently approved shift/transfer request, if any.
 */
export async function findLatestApprovedShift(
  prisma: any,
  scholarProfileId: number,
  includeProgram = false,
): Promise<ApprovedShiftRecord | null> {
  if (typeof prisma?.academicChangeRequest?.findFirst !== 'function') {
    return null;
  }

  return prisma.academicChangeRequest.findFirst({
    where: { scholar_profile_id: scholarProfileId, status: 'APPROVED' },
    ...(includeProgram
      ? {
          include: {
            requested_program: {
              select: { program_code: true, program_name: true },
            },
          },
        }
      : {}),
    orderBy: { reviewed_at: 'desc' },
  });
}

/**
 * Deletes and removes leftover pre-shift subjects (`created_at <= shiftReviewedAtMs`)
 * once a new post-shift prospectus document has already been uploaded.
 */
export async function pruneStalePreShiftSubjects<
  TSubject extends { subject_id: number; created_at?: Date | string | null },
>(
  prisma: any,
  prospectus:
    | {
        prospectus_id: number;
        is_frozen?: boolean | null;
        document?: { uploaded_at?: Date | string | null } | null;
        subjects?: TSubject[];
      }
    | null
    | undefined,
  shiftReviewedAtMs: number,
): Promise<boolean> {
  if (!prospectus || prospectus.is_frozen || shiftReviewedAtMs <= 0) {
    return false;
  }

  const docUploadedMs = prospectus.document?.uploaded_at
    ? new Date(prospectus.document.uploaded_at).getTime()
    : 0;

  // Only prune after a post-shift prospectus has been uploaded; prior to upload
  // the scholar view intentionally surfaces the pre-shift notice banner.
  if (
    docUploadedMs <= shiftReviewedAtMs ||
    !Array.isArray(prospectus.subjects) ||
    prospectus.subjects.length === 0
  ) {
    return false;
  }

  const staleIds: number[] = [];
  const kept: TSubject[] = [];

  for (const sub of prospectus.subjects) {
    const subCreatedMs = sub.created_at
      ? new Date(sub.created_at).getTime()
      : 0;
    if (subCreatedMs > 0 && subCreatedMs <= shiftReviewedAtMs) {
      staleIds.push(sub.subject_id);
    } else {
      kept.push(sub);
    }
  }

  if (staleIds.length === 0) {
    return false;
  }

  if (typeof prisma?.prospectusSubject?.deleteMany === 'function') {
    await prisma.prospectusSubject.deleteMany({
      where: { subject_id: { in: staleIds } },
    });
  }

  prospectus.subjects = kept;
  return true;
}

export interface ProspectusHistorySubjectSnapshot {
  subject_code: string;
  descriptive_title: string;
  units: number;
  year_level: number;
  semester: string;
  status: string;
  grade: number | null;
  credited_term: string | null;
  remarks: string | null;
  prerequisites: string[] | null;
}

export interface ArchiveProspectusOptions {
  scholarProfileId: number;
  academicChangeRequestId?: number | null;
  schoolName?: string | null;
  archiveReason?: string;
}

/**
 * Snapshots a scholar's existing prospectus (and all subjects + earned grades)
 * into `scholar_prospectus_history` before it is cleared or superseded.
 */
export async function archiveProspectusToHistory(
  prismaOrTx: any,
  prospectus:
    | {
        prospectus_id?: number;
        document_id?: number | null;
        curriculum_year?: string | null;
        course_code?: string | null;
        course_name?: string | null;
        total_units?: unknown;
        status?: string | null;
        is_frozen?: boolean | null;
        frozen_at?: Date | string | null;
        subjects?: Array<{
          subject_code?: string | null;
          descriptive_title?: string | null;
          units?: unknown;
          year_level?: number | null;
          semester?: string | null;
          status?: string | null;
          grade?: unknown;
          credited_term?: string | null;
          remarks?: string | null;
          prerequisites?: unknown;
        }>;
      }
    | null
    | undefined,
  options: ArchiveProspectusOptions,
) {
  if (
    !prospectus ||
    typeof prismaOrTx?.scholarProspectusHistory?.create !== 'function'
  ) {
    return null;
  }

  try {
    if (
      options.academicChangeRequestId &&
      typeof prismaOrTx.scholarProspectusHistory.findFirst === 'function'
    ) {
      const existing = await prismaOrTx.scholarProspectusHistory.findFirst({
        where: {
          scholar_profile_id: options.scholarProfileId,
          academic_change_request_id: options.academicChangeRequestId,
        },
        select: { history_id: true },
      });
      if (existing) return existing;
    }

    const rawSubjects = Array.isArray(prospectus.subjects)
      ? prospectus.subjects
      : [];
    const subjectsSnapshot: ProspectusHistorySubjectSnapshot[] = rawSubjects.map(
      (s) => ({
        subject_code: String(s.subject_code || ''),
        descriptive_title: String(s.descriptive_title || ''),
        units: Number(s.units) || 0,
        year_level: Number(s.year_level) || 1,
        semester: String(s.semester || '1st Semester'),
        status: String(s.status || 'UNTAKEN'),
        grade: s.grade != null ? Number(s.grade) : null,
        credited_term: s.credited_term ? String(s.credited_term) : null,
        remarks: s.remarks ? String(s.remarks) : null,
        prerequisites: Array.isArray(s.prerequisites)
          ? s.prerequisites.map(String)
          : null,
      }),
    );

    const computedTotalUnits = subjectsSnapshot.reduce(
      (sum, s) => sum + (Number(s.units) || 0),
      0,
    );
    const totalUnits =
      prospectus.total_units != null && Number(prospectus.total_units) > 0
        ? Number(prospectus.total_units)
        : computedTotalUnits;
    const creditedUnits = subjectsSnapshot
      .filter((s) => s.status === 'PASSED' || s.status === 'CREDITED')
      .reduce((sum, s) => sum + (Number(s.units) || 0), 0);

    return await prismaOrTx.scholarProspectusHistory.create({
      data: {
        scholar_profile_id: options.scholarProfileId,
        academic_change_request_id: options.academicChangeRequestId ?? null,
        document_id: prospectus.document_id ?? null,
        curriculum_year: prospectus.curriculum_year || 'Archived Curriculum',
        course_code: prospectus.course_code ?? null,
        course_name: prospectus.course_name || 'Previous Program',
        school_name: options.schoolName ?? null,
        total_units: Number(totalUnits.toFixed(1)),
        credited_units: Number(creditedUnits.toFixed(1)),
        status: prospectus.status || 'ARCHIVED',
        archive_reason: options.archiveReason || 'PROGRAM_SHIFT',
        is_frozen: Boolean(prospectus.is_frozen),
        frozen_at: prospectus.frozen_at ? new Date(prospectus.frozen_at) : null,
        subjects_snapshot: subjectsSnapshot,
      },
    });
  } catch (err: any) {
    // Gracefully ignore missing-table errors if migration has not run yet
    if (err?.code === 'P2021') {
      return null;
    }
    throw err;
  }
}

