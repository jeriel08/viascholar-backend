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
