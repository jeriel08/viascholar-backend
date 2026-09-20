import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { EventsGateway } from '../../events/events.gateway.js';
import { Prisma } from '../../generated/prisma/client.js';

interface GradingLegendData {
  highest_grade?: number;
  passing_grade?: number;
  failing_grade?: number;
  grading_scale?: any;
  special_codes?: unknown;
  notes?: string;
  legend_title?: string;
}

@Injectable()
export class DocumentSchoolLinkerService {
  private readonly logger = new Logger(DocumentSchoolLinkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  /**
   * Identifies or auto-registers the school grading system based on extracted school name and legend
   */
  async linkSchoolGradingSystem(
    scholarProfileId: number,
    userId: number | undefined,
    detectedSchoolName: string,
    gradingLegend?: GradingLegendData | null,
    currentScholarSchoolName?: string | null,
  ): Promise<void> {
    const trimmedSchool = (detectedSchoolName || '').trim();
    if (!trimmedSchool || !scholarProfileId) return;

    try {
      // 1. Direct exact match
      let matchedSchool = await this.prisma.schoolGradingSystem.findFirst({
        where: {
          school_name: { equals: trimmedSchool, mode: 'insensitive' },
        },
      });

      // 2. Intelligent fuzzy/normalized matching against existing configured schools
      if (!matchedSchool) {
        const allSchools = await this.prisma.schoolGradingSystem.findMany();
        const normalize = (s: string) =>
          s
            .toLowerCase()
            .replace(/\([^)]*\)/g, '')
            .replace(/[^a-z0-9]/g, '')
            .trim();

        const normalizedDetected = normalize(trimmedSchool);

        // Normalized exact name match
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
              trimmedSchool,
            );
          if (isHighSchool) {
            matchedSchool =
              allSchools.find(
                (s) =>
                  /high\s*school|senior\s*high|deped/i.test(s.school_name) &&
                  s.is_verified,
              ) ?? null;
          }
        }
      }

      let schoolIdToLink = matchedSchool?.school_id;

      // Only create a new unverified school entry if NO existing school matched
      if (!matchedSchool && gradingLegend) {
        const defaultHighest =
          gradingLegend.highest_grade ??
          (gradingLegend.grading_scale === 'NUMERIC_4_POINT' ? 4.0 : 1.0);
        const defaultPassing =
          gradingLegend.passing_grade ??
          (gradingLegend.grading_scale === 'NUMERIC_4_POINT' ? 2.0 : 3.0);
        const defaultFailing =
          gradingLegend.failing_grade ??
          (gradingLegend.grading_scale === 'NUMERIC_4_POINT' ? 1.0 : 5.0);

        const newSchool = await this.prisma.schoolGradingSystem.create({
          data: {
            school_name: trimmedSchool,
            grading_scale:
              gradingLegend.grading_scale ||
              (gradingLegend.highest_grade === 4
                ? 'NUMERIC_4_POINT'
                : 'NUMERIC_5_POINT'),
            highest_grade: defaultHighest,
            passing_grade: defaultPassing,
            failing_grade: defaultFailing,
            special_codes: gradingLegend.special_codes
              ? (gradingLegend.special_codes as Prisma.InputJsonValue)
              : undefined,
            notes:
              gradingLegend.notes ||
              `Auto-extracted from document: ${gradingLegend.legend_title || 'Legend'}`,
            is_verified: false,
            submitted_by_user_id: userId,
          },
        });
        schoolIdToLink = newSchool.school_id;
        this.eventsGateway.emitToStaff('school_grading:created', newSchool);
      }

      if (schoolIdToLink || !currentScholarSchoolName) {
        await this.prisma.scholarProfile.update({
          where: { profile_id: scholarProfileId },
          data: {
            ...(schoolIdToLink ? { school_id: schoolIdToLink } : {}),
            ...(!currentScholarSchoolName
              ? { school_name: trimmedSchool }
              : {}),
          },
        });
      }
    } catch (schoolErr: any) {
      this.logger.warn(
        `Could not auto-link school grading system: ${schoolErr.message}`,
      );
    }
  }
}
