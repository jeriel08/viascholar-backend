import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { ChatMessagesService } from '../chat/services/chat-messages.service.js';
import { ChatService } from '../chat/chat.service.js';
import {
  academicYearsMatchForTerm,
  normalizeAcademicYear,
  normalizeSemester,
} from '../documents/utils/academic-term.util.js';
import { EventsGateway } from '../events/events.gateway.js';
import { Role } from '../generated/prisma/enums.js';
import { MailService } from '../mail/mail.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import {
  CreateDeadlineDto,
  DEADLINE_REQUIREMENT_TYPES,
  type DeadlineRequirementType,
  ExemptScholarDeadlineDto,
  SendDeadlineFollowUpDto,
  UpdateDeadlineDto,
} from './dto/deadline.dto.js';
import {
  type DeadlineComplianceStatus,
  evaluateScholarRequirementStatus,
  getRequirementActionPath,
  getRequirementLabel,
  normalizeDueDateInput,
  normalizeSchoolName,
  resolveEffectiveDeadline,
  resolveScholarSchoolName,
} from './utils/deadline-compliance.util.js';

const STATUS_SORT_PRIORITY: Record<DeadlineComplianceStatus, number> = {
  OVERDUE: 0,
  NEEDS_ACTION: 1,
  UPCOMING: 2,
  NOT_SUBMITTED: 3,
  CURRENTLY_ENROLLED: 4,
  SUBMITTED: 5,
  EXEMPT: 6,
  NOT_APPLICABLE: 7,
};

@Injectable()
export class DeadlinesService {
  private readonly logger = new Logger(DeadlinesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly chatService: ChatService,
    private readonly chatMessagesService: ChatMessagesService,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    private readonly auditService: AuditService,
    private readonly eventsGateway: EventsGateway,
  ) {}

  private buildAvailableAcademicYears(
    activeTerm: {
      effective_academic_year: string;
      valid_academic_years?: string[];
    },
    extraYears: Array<string | null | undefined>,
  ): string[] {
    const years = new Set<string>();
    const addIfAy = (raw?: string | null) => {
      const norm = normalizeAcademicYear(raw);
      if (norm && /^\d{4}-\d{4}$/.test(norm)) {
        years.add(norm);
      }
    };

    addIfAy(activeTerm.effective_academic_year);
    for (const ay of activeTerm.valid_academic_years || []) {
      addIfAy(ay);
    }
    for (const ay of extraYears) {
      addIfAy(ay);
    }

    const anchorNorm = normalizeAcademicYear(activeTerm.effective_academic_year);
    const startYear = Number.parseInt((anchorNorm || '').split('-')[0], 10);
    if (Number.isFinite(startYear)) {
      for (let offset = 1; offset >= -3; offset--) {
        const y = startYear + offset;
        years.add(`${y}-${y + 1}`);
      }
    }

    return Array.from(years).sort((a, b) => b.localeCompare(a));
  }

  private formatDeadline(d: any) {
    const creatorName = d.created_by?.employee
      ? `${d.created_by.employee.first_name || ''} ${d.created_by.employee.last_name || ''}`.trim()
      : null;

    return {
      deadline_id: d.deadline_id,
      requirement_type: d.requirement_type as DeadlineRequirementType,
      academic_year: d.academic_year,
      semester: d.semester,
      school_id: d.school_id ?? null,
      school: d.school
        ? {
            school_id: d.school.school_id,
            school_name: d.school.school_name,
            school_code: d.school.school_code ?? null,
          }
        : null,
      due_date:
        d.due_date instanceof Date ? d.due_date.toISOString() : d.due_date,
      grace_period_days: Number(d.grace_period_days ?? 0),
      is_optional_term: Boolean(d.is_optional_term),
      title: d.title ?? null,
      instructions: d.instructions ?? null,
      is_active: Boolean(d.is_active),
      created_by_user_id: d.created_by_user_id ?? null,
      created_by_name: creatorName || d.created_by?.email || null,
      created_at:
        d.created_at instanceof Date ? d.created_at.toISOString() : d.created_at,
      updated_at:
        d.updated_at instanceof Date ? d.updated_at.toISOString() : d.updated_at,
    };
  }

  async listDeadlines(query: {
    academic_year?: string;
    semester?: string;
    requirement_type?: string;
    only_active?: boolean;
  }) {
    const normAy = query.academic_year
      ? normalizeAcademicYear(query.academic_year) || query.academic_year.trim()
      : undefined;
    const normSem = query.semester
      ? normalizeSemester(query.semester)
      : undefined;

    const rows = await this.prisma.submissionDeadline.findMany({
      where: {
        ...(normAy ? { academic_year: normAy } : {}),
        ...(normSem ? { semester: normSem } : {}),
        ...(query.requirement_type
          ? { requirement_type: query.requirement_type }
          : {}),
        ...(query.only_active ? { is_active: true } : {}),
      },
      include: {
        school: {
          select: { school_id: true, school_name: true, school_code: true },
        },
        created_by: {
          select: {
            user_id: true,
            email: true,
            employee: { select: { first_name: true, last_name: true } },
          },
        },
      },
      orderBy: [
        { academic_year: 'desc' },
        { semester: 'asc' },
        { due_date: 'asc' },
      ],
    });

    return rows.map((r) => this.formatDeadline(r));
  }

  async createDeadline(userId: number, dto: CreateDeadlineDto) {
    const academicYear =
      normalizeAcademicYear(dto.academic_year) || dto.academic_year.trim();
    const semester = normalizeSemester(dto.semester);
    if (!academicYear || !semester) {
      throw new BadRequestException(
        'Valid academic year and semester are required.',
      );
    }

    const dueDate = normalizeDueDateInput(dto.due_date);
    if (Number.isNaN(dueDate.getTime())) {
      throw new BadRequestException('Invalid due_date format.');
    }

    const schoolId = dto.school_id ? Number(dto.school_id) : null;
    if (schoolId) {
      const school = await this.prisma.school.findUnique({
        where: { school_id: schoolId },
        select: { school_id: true },
      });
      if (!school) {
        throw new NotFoundException(`School ID ${schoolId} not found.`);
      }
    }

    const existing = await this.prisma.submissionDeadline.findFirst({
      where: {
        requirement_type: dto.requirement_type,
        academic_year: academicYear,
        semester,
        school_id: schoolId,
        is_active: true,
      },
      select: { deadline_id: true },
    });

    if (existing) {
      throw new ConflictException(
        `An active ${getRequirementLabel(dto.requirement_type)} deadline already exists for A.Y. ${academicYear} ${semester}${schoolId ? ' for this school' : ' (All Schools)'}. Please edit the existing deadline instead.`,
      );
    }

    const isOptionalTerm =
      dto.is_optional_term !== undefined
        ? dto.is_optional_term
        : semester === 'Summer';

    const created = await this.prisma.submissionDeadline.create({
      data: {
        requirement_type: dto.requirement_type,
        academic_year: academicYear,
        semester,
        school_id: schoolId,
        due_date: dueDate,
        grace_period_days: dto.grace_period_days ?? 0,
        is_optional_term: isOptionalTerm,
        title:
          dto.title?.trim() ||
          `${getRequirementLabel(dto.requirement_type)} — ${academicYear} ${semester}`,
        instructions: dto.instructions?.trim() || null,
        is_active: true,
        created_by_user_id: userId,
      },
      include: {
        school: {
          select: { school_id: true, school_name: true, school_code: true },
        },
        created_by: {
          select: {
            user_id: true,
            email: true,
            employee: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });

    const formatted = this.formatDeadline(created);
    await this.auditService.log(
      userId,
      'DEADLINE_CREATED',
      `Set ${dto.requirement_type} deadline for A.Y. ${academicYear} ${semester} (Due: ${dueDate.toISOString().slice(0, 10)}${schoolId ? `, School ID: ${schoolId}` : ', All Schools'})`,
    );

    if (dto.notify_scholars) {
      await this.broadcastNewDeadlineNotification(created);
    }

    this.eventsGateway.emitToAll('deadline:updated', {
      action: 'CREATED',
      deadline: formatted,
    });

    return formatted;
  }

  private async broadcastNewDeadlineNotification(deadline: {
    deadline_id: number;
    requirement_type: string;
    academic_year: string;
    semester: string;
    due_date: Date;
    grace_period_days: number;
    is_optional_term: boolean;
    is_active: boolean;
    school_id: number | null;
    school?: { school_id?: number; school_name: string; school_code?: string | null } | null;
  }) {
    try {
      const [activeDeadlines, scholars] = await Promise.all([
        typeof (this.prisma as any).submissionDeadline?.findMany === 'function'
          ? this.prisma.submissionDeadline.findMany({
              where: {
                academic_year: deadline.academic_year,
                semester: deadline.semester,
                requirement_type: deadline.requirement_type,
                is_active: true,
              },
              include: {
                school: {
                  select: { school_id: true, school_name: true, school_code: true },
                },
              },
            })
          : Promise.resolve([]),
        this.prisma.scholarProfile.findMany({
          where: {
            archived_at: null,
            user: { role: Role.SCHOLAR, is_active: true },
          },
          select: {
            profile_id: true,
            user_id: true,
            first_name: true,
            last_name: true,
            current_year_level: true,
            school_id: true,
            school_name: true,
            school: { select: { school_id: true, school_name: true } },
            school_grading_system: {
              select: { school_id: true, school_name: true },
            },
            prospectus: {
              include: {
                subjects: {
                  select: { year_level: true, semester: true, status: true },
                },
              },
            },
            enrollments: {
              select: {
                enrollment_id: true,
                academic_year: true,
                semester: true,
                status: true,
                cor_document_id: true,
                soa_document_id: true,
              },
            },
            grade_reports: {
              select: {
                report_id: true,
                academic_year: true,
                semester: true,
                status: true,
                submitted_at: true,
              },
            },
          },
        }),
      ]);

      const scopedDeadlines =
        Array.isArray(activeDeadlines) && activeDeadlines.length > 0
          ? activeDeadlines
          : [deadline];
      const reqType = deadline.requirement_type as DeadlineRequirementType;
      const reqLabel = getRequirementLabel(deadline.requirement_type);
      const dueStr = deadline.due_date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
      const link = getRequirementActionPath(deadline.requirement_type);

      const now = new Date();
      const targets = scholars.filter((s) => {
        const effective = resolveEffectiveDeadline(
          scopedDeadlines,
          reqType,
          s,
        );
        if (!effective || effective.deadline_id !== deadline.deadline_id) {
          return false;
        }
        const evaluation = evaluateScholarRequirementStatus({
          deadline: effective,
          scholar: s,
          now,
        });
        return [
          'OVERDUE',
          'NEEDS_ACTION',
          'UPCOMING',
          'NOT_SUBMITTED',
        ].includes(evaluation.status);
      });

      await Promise.all(
        targets.map((s) =>
          this.notificationsService.notifyUser(s.user_id, {
            title: `${reqLabel} Deadline Set`,
            message: `Please submit your ${reqLabel} for A.Y. ${deadline.academic_year} ${deadline.semester} on or before ${dueStr}.`,
            category: 'deadline',
            link,
          }),
        ),
      );
    } catch (err) {
      this.logger.warn(`Failed to broadcast deadline notifications: ${err}`);
    }
  }

  async updateDeadline(
    userId: number,
    deadlineId: number,
    dto: UpdateDeadlineDto,
  ) {
    const existing = await this.prisma.submissionDeadline.findUnique({
      where: { deadline_id: deadlineId },
    });
    if (!existing) {
      throw new NotFoundException(`Deadline ID ${deadlineId} not found.`);
    }

    let dueDateUpdate: Date | undefined;
    if (dto.due_date !== undefined) {
      dueDateUpdate = normalizeDueDateInput(dto.due_date);
      if (Number.isNaN(dueDateUpdate.getTime())) {
        throw new BadRequestException('Invalid due_date format.');
      }
    }

    const updated = await this.prisma.submissionDeadline.update({
      where: { deadline_id: deadlineId },
      data: {
        ...(dueDateUpdate ? { due_date: dueDateUpdate } : {}),
        ...(dto.school_id !== undefined ? { school_id: dto.school_id } : {}),
        ...(dto.grace_period_days !== undefined
          ? { grace_period_days: dto.grace_period_days }
          : {}),
        ...(dto.is_optional_term !== undefined
          ? { is_optional_term: dto.is_optional_term }
          : {}),
        ...(dto.title !== undefined
          ? { title: dto.title.trim() || null }
          : {}),
        ...(dto.instructions !== undefined
          ? { instructions: dto.instructions.trim() || null }
          : {}),
        ...(dto.is_active !== undefined ? { is_active: dto.is_active } : {}),
      },
      include: {
        school: {
          select: { school_id: true, school_name: true, school_code: true },
        },
        created_by: {
          select: {
            user_id: true,
            email: true,
            employee: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });

    const formatted = this.formatDeadline(updated);
    await this.auditService.log(
      userId,
      'DEADLINE_UPDATED',
      `Updated ${updated.requirement_type} deadline ID ${deadlineId} (Due: ${updated.due_date.toISOString().slice(0, 10)}, Active: ${updated.is_active})`,
    );

    this.eventsGateway.emitToAll('deadline:updated', {
      action: 'UPDATED',
      deadline: formatted,
    });

    return formatted;
  }

  async deleteDeadline(userId: number, deadlineId: number) {
    const existing = await this.prisma.submissionDeadline.findUnique({
      where: { deadline_id: deadlineId },
    });
    if (!existing) {
      throw new NotFoundException(`Deadline ID ${deadlineId} not found.`);
    }

    await this.prisma.submissionDeadline.delete({
      where: { deadline_id: deadlineId },
    });

    await this.auditService.log(
      userId,
      'DEADLINE_DELETED',
      `Deleted ${existing.requirement_type} deadline ID ${deadlineId} (${existing.academic_year} ${existing.semester})`,
    );

    this.eventsGateway.emitToAll('deadline:updated', {
      action: 'DELETED',
      deadlineId,
    });

    return {
      message: 'Submission deadline removed.',
      deadline_id: deadlineId,
    };
  }

  async getCompliance(query: {
    academic_year?: string;
    semester?: string;
    requirement_type?: string;
    status?: string;
    school_id?: number;
    search?: string;
  }) {
    const activeTerm = await this.settingsService.getAcademicTermStatus();
    const academicYear =
      (query.academic_year && normalizeAcademicYear(query.academic_year)) ||
      activeTerm.effective_academic_year;
    const semester =
      (query.semester && normalizeSemester(query.semester)) ||
      activeTerm.effective_semester;

    const deadlines = await this.prisma.submissionDeadline.findMany({
      where: {
        academic_year: academicYear,
        semester,
        is_active: true,
        ...(query.requirement_type && query.requirement_type !== 'ALL'
          ? { requirement_type: query.requirement_type }
          : {}),
      },
      include: {
        school: {
          select: { school_id: true, school_name: true, school_code: true },
        },
        created_by: {
          select: {
            user_id: true,
            email: true,
            employee: { select: { first_name: true, last_name: true } },
          },
        },
      },
      orderBy: [{ requirement_type: 'asc' }, { due_date: 'asc' }],
    });

    const formattedDeadlines = deadlines.map((d) => this.formatDeadline(d));
    const deadlineIds = deadlines.map((d) => d.deadline_id);

    const scholars = await this.prisma.scholarProfile.findMany({
      where: {
        archived_at: null,
        user: { role: Role.SCHOLAR, is_active: true },
      },
      include: {
        user: { select: { user_id: true, email: true } },
        school: {
          select: { school_id: true, school_name: true, school_code: true },
        },
        school_grading_system: {
          select: { school_id: true, school_name: true },
        },
        prospectus: {
          include: {
            subjects: {
              select: { year_level: true, semester: true, status: true },
            },
          },
        },
        enrollments: {
          select: {
            enrollment_id: true,
            academic_year: true,
            semester: true,
            status: true,
            cor_document_id: true,
            soa_document_id: true,
          },
        },
        grade_reports: {
          select: {
            report_id: true,
            academic_year: true,
            semester: true,
            status: true,
            submitted_at: true,
          },
        },
        ...(deadlineIds.length > 0
          ? {
              deadline_exemptions: {
                where: { deadline_id: { in: deadlineIds } },
              },
              deadline_follow_ups: {
                where: { deadline_id: { in: deadlineIds } },
                include: {
                  sent_by: {
                    select: {
                      user_id: true,
                      email: true,
                      employee: { select: { first_name: true, last_name: true } },
                    },
                  },
                },
                orderBy: { created_at: 'desc' },
              },
            }
          : {}),
      },
      orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }],
    });

    const [schoolsList, allDeadlineTerms] = await Promise.all([
      typeof (this.prisma as any).school?.findMany === 'function'
        ? this.prisma.school.findMany({
            select: { school_id: true, school_name: true },
          })
        : Promise.resolve([]),
      typeof (this.prisma as any).submissionDeadline?.findMany === 'function'
        ? this.prisma.submissionDeadline.findMany({
            select: { academic_year: true },
            distinct: ['academic_year'],
          })
        : Promise.resolve([]),
    ]);
    const schoolIdByName = new Map<string, number>();
    for (const s of schoolsList) {
      const norm = normalizeSchoolName(s.school_name);
      if (norm) schoolIdByName.set(norm, s.school_id);
    }

    const availableAcademicYears = this.buildAvailableAcademicYears(activeTerm, [
      academicYear,
      ...scholars.flatMap((s) =>
        (s.enrollments || []).map((e) => e.academic_year),
      ),
      ...(Array.isArray(allDeadlineTerms)
        ? allDeadlineTerms.map((d: any) => d?.academic_year)
        : []),
    ]);

    const requirementTypesToCheck =
      query.requirement_type && query.requirement_type !== 'ALL'
        ? ([query.requirement_type] as DeadlineRequirementType[])
        : [...DEADLINE_REQUIREMENT_TYPES];

    const now = new Date();
    const allItems: Array<Record<string, any>> = [];
    const summary = {
      total_scholars: scholars.length,
      total_entries: 0,
      submitted_count: 0,
      currently_enrolled_count: 0,
      missing_count: 0,
      overdue_count: 0,
      needs_action_count: 0,
      upcoming_count: 0,
      exempt_count: 0,
      not_applicable_count: 0,
      contacted_count: 0,
    };

    for (const scholar of scholars) {
      for (const reqType of requirementTypesToCheck) {
        const effectiveDeadline = resolveEffectiveDeadline(
          deadlines,
          reqType,
          scholar,
        );
        if (!effectiveDeadline) continue;

        const exemption =
          (scholar as any).deadline_exemptions?.find(
            (e: any) => e.deadline_id === effectiveDeadline.deadline_id,
          ) ?? null;
        const followUps = (scholar as any).deadline_follow_ups?.filter(
          (f: any) => f.deadline_id === effectiveDeadline.deadline_id,
        ) ?? [];
        const latestFollowUp = followUps[0] ?? null;

        const evaluation = evaluateScholarRequirementStatus({
          deadline: effectiveDeadline,
          scholar,
          exemption,
          now,
        });

        summary.total_entries++;
        switch (evaluation.status) {
          case 'SUBMITTED':
            summary.submitted_count++;
            break;
          case 'CURRENTLY_ENROLLED':
            summary.currently_enrolled_count++;
            break;
          case 'OVERDUE':
            summary.overdue_count++;
            summary.missing_count++;
            break;
          case 'NEEDS_ACTION':
            summary.needs_action_count++;
            summary.missing_count++;
            break;
          case 'UPCOMING':
            summary.upcoming_count++;
            summary.missing_count++;
            break;
          case 'NOT_SUBMITTED':
            summary.missing_count++;
            break;
          case 'EXEMPT':
            summary.exempt_count++;
            break;
          case 'NOT_APPLICABLE':
            summary.not_applicable_count++;
            break;
        }

        if (latestFollowUp) {
          summary.contacted_count++;
        }

        const scholarSchoolName = resolveScholarSchoolName(scholar);
        const resolvedSchoolId =
          schoolIdByName.get(normalizeSchoolName(scholarSchoolName)) ??
          scholar.school_id ??
          null;

        allItems.push({
          row_key: `${effectiveDeadline.deadline_id}-${scholar.profile_id}`,
          deadline_id: effectiveDeadline.deadline_id,
          requirement_type: reqType,
          requirement_label: getRequirementLabel(reqType),
          is_school_override: effectiveDeadline.school_id !== null,
          due_date: effectiveDeadline.due_date.toISOString(),
          effective_due_date: evaluation.effective_due_date,
          grace_period_days: effectiveDeadline.grace_period_days,
          status: evaluation.status,
          status_detail: evaluation.status_detail,
          days_remaining: evaluation.days_remaining,
          days_overdue: evaluation.days_overdue,
          scholar: {
            profile_id: scholar.profile_id,
            user_id: scholar.user_id,
            name: `${scholar.first_name} ${scholar.last_name}`.trim(),
            email: scholar.user?.email || '',
            phone_number: scholar.phone_number || null,
            student_number: scholar.student_number || null,
            course_of_study: scholar.course_of_study || null,
            year_level: scholar.current_year_level ?? null,
            school_id: resolvedSchoolId,
            school_name: scholarSchoolName,
          },
          exemption: exemption
            ? {
                reason: exemption.reason ?? null,
                created_at:
                  exemption.created_at instanceof Date
                    ? exemption.created_at.toISOString()
                    : exemption.created_at,
              }
            : null,
          follow_up_count: followUps.length,
          last_follow_up: latestFollowUp
            ? {
                follow_up_id: latestFollowUp.follow_up_id,
                channels: Array.isArray(latestFollowUp.channels)
                  ? latestFollowUp.channels
                  : [],
                conversation_id: latestFollowUp.conversation_id ?? null,
                message_text: latestFollowUp.message_text,
                sent_by_name: latestFollowUp.sent_by?.employee
                  ? `${latestFollowUp.sent_by.employee.first_name || ''} ${latestFollowUp.sent_by.employee.last_name || ''}`.trim()
                  : latestFollowUp.sent_by?.email || 'Coordinator',
                created_at:
                  latestFollowUp.created_at instanceof Date
                    ? latestFollowUp.created_at.toISOString()
                    : latestFollowUp.created_at,
              }
            : null,
        });
      }
    }

    const searchQ = (query.search || '').trim().toLowerCase();
    const filteredItems = allItems
      .filter((item) => {
        if (query.school_id && item.scholar.school_id !== Number(query.school_id)) {
          return false;
        }
        if (query.status && query.status !== 'ALL') {
          if (query.status === 'MISSING_ALL') {
            if (
              !['OVERDUE', 'NEEDS_ACTION', 'UPCOMING', 'NOT_SUBMITTED'].includes(
                item.status,
              )
            ) {
              return false;
            }
          } else if (item.status !== query.status) {
            return false;
          }
        }
        if (searchQ) {
          const hay = [
            item.scholar.name,
            item.scholar.email,
            item.scholar.school_name,
            item.scholar.course_of_study,
            item.scholar.student_number,
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          if (!hay.includes(searchQ)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const pDiff =
          (STATUS_SORT_PRIORITY[a.status as DeadlineComplianceStatus] ?? 99) -
          (STATUS_SORT_PRIORITY[b.status as DeadlineComplianceStatus] ?? 99);
        if (pDiff !== 0) return pDiff;
        if (b.days_overdue !== a.days_overdue) {
          return b.days_overdue - a.days_overdue;
        }
        return a.scholar.name.localeCompare(b.scholar.name);
      });

    return {
      academic_year: academicYear,
      semester,
      available_academic_years: availableAcademicYears,
      active_term: activeTerm,
      deadlines: formattedDeadlines,
      summary,
      items: filteredItems,
    };
  }

  async sendFollowUp(staffUserId: number, dto: SendDeadlineFollowUpDto) {
    const deadline = await this.prisma.submissionDeadline.findUnique({
      where: { deadline_id: dto.deadline_id },
    });
    if (!deadline) {
      throw new NotFoundException(`Deadline ID ${dto.deadline_id} not found.`);
    }

    const uniqueProfileIds = Array.from(new Set(dto.scholar_profile_ids));
    const scholars = await this.prisma.scholarProfile.findMany({
      where: { profile_id: { in: uniqueProfileIds } },
      include: { user: { select: { user_id: true, email: true } } },
    });

    if (scholars.length === 0) {
      throw new NotFoundException('No matching target scholars found.');
    }

    const staffEmp = await this.prisma.employee.findUnique({
      where: { user_id: staffUserId },
      select: { first_name: true, last_name: true },
    });
    const coordinatorName = staffEmp
      ? `${staffEmp.first_name || ''} ${staffEmp.last_name || ''}`.trim()
      : 'Scholarship Coordinator';

    const useChat = dto.send_chat !== false;
    const useEmail = dto.send_email !== false;
    const useNotification = dto.send_notification !== false;
    if (!useChat && !useEmail && !useNotification) {
      throw new BadRequestException(
        'Select at least one communication channel (Chat, Email, or Notification).',
      );
    }

    const reqLabel = getRequirementLabel(deadline.requirement_type);
    const actionPath = getRequirementActionPath(deadline.requirement_type);
    const effectiveDueMs =
      new Date(deadline.due_date).getTime() +
      (deadline.grace_period_days || 0) * 86400000;
    const isOverdue = Date.now() > effectiveDueMs;
    const daysOverdue = isOverdue
      ? Math.max(1, Math.ceil((Date.now() - effectiveDueMs) / 86400000))
      : 0;
    const dueDateLabel = new Date(deadline.due_date).toLocaleDateString(
      'en-US',
      { month: 'short', day: 'numeric', year: 'numeric' },
    );

    const trimmedMsg = dto.message.trim();
    const results: Array<{
      scholar_profile_id: number;
      channels: string[];
      conversation_id: number | null;
      follow_up_id: number;
    }> = [];

    for (const scholar of scholars) {
      const deliveredChannels: string[] = [];
      let conversationId: number | null = null;
      const studentName =
        `${scholar.first_name || ''} ${scholar.last_name || ''}`.trim() ||
        'Scholar';

      if (useChat && scholar.user_id) {
        try {
          const convo = await this.chatService.getOrCreateConversation(
            staffUserId,
            {
              target_user_id: scholar.user_id,
              subject: `${reqLabel} — A.Y. ${deadline.academic_year} ${deadline.semester}`,
            },
          );
          conversationId = convo.conversation_id;
          await this.chatMessagesService.sendMessage(
            staffUserId,
            convo.conversation_id,
            { message_text: trimmedMsg },
          );
          deliveredChannels.push('CHAT');
        } catch (err) {
          this.logger.warn(
            `Failed to send chat follow-up to scholar user ${scholar.user_id}: ${err}`,
          );
        }
      }

      if (useEmail && scholar.user?.email) {
        try {
          await this.mailService.sendDeadlineFollowUpEmail(scholar.user.email, {
            studentName,
            requirementLabel: reqLabel,
            academicYear: deadline.academic_year,
            semester: deadline.semester,
            dueDateLabel,
            isOverdue,
            daysOverdue,
            coordinatorName,
            message: trimmedMsg,
            actionPath,
          });
          deliveredChannels.push('EMAIL');
        } catch (err) {
          this.logger.warn(
            `Failed to send email follow-up to ${scholar.user.email}: ${err}`,
          );
        }
      }

      if (useNotification && scholar.user_id) {
        try {
          await this.notificationsService.notifyUser(scholar.user_id, {
            title: isOverdue
              ? `Follow-Up: ${reqLabel} Overdue`
              : `Reminder: ${reqLabel}`,
            message: trimmedMsg,
            category: 'deadline',
            link: conversationId
              ? `/scholarMessage?conversationId=${conversationId}`
              : actionPath,
          });
          deliveredChannels.push('IN_APP');
        } catch (err) {
          this.logger.warn(
            `Failed to send in-app notification to scholar user ${scholar.user_id}: ${err}`,
          );
        }
      }

      const saved = await this.prisma.deadlineFollowUp.create({
        data: {
          deadline_id: deadline.deadline_id,
          scholar_profile_id: scholar.profile_id,
          sent_by_user_id: staffUserId,
          channels: deliveredChannels,
          conversation_id: conversationId,
          message_text: trimmedMsg,
        },
      });

      results.push({
        scholar_profile_id: scholar.profile_id,
        channels: deliveredChannels,
        conversation_id: conversationId,
        follow_up_id: saved.follow_up_id,
      });
    }

    await this.auditService.log(
      staffUserId,
      'DEADLINE_FOLLOWUP_SENT',
      `Sent follow-up for ${deadline.requirement_type} deadline #${deadline.deadline_id} (${deadline.academic_year} ${deadline.semester}) to ${scholars.length} scholar(s).`,
    );

    this.eventsGateway.emitToStaff('deadline:followup_sent', {
      deadlineId: deadline.deadline_id,
      count: results.length,
    });

    return {
      message: `Follow-up sent to ${results.length} scholar${results.length === 1 ? '' : 's'}.`,
      sent_count: results.length,
      results,
    };
  }

  async exemptScholar(staffUserId: number, dto: ExemptScholarDeadlineDto) {
    const [deadline, scholar] = await Promise.all([
      this.prisma.submissionDeadline.findUnique({
        where: { deadline_id: dto.deadline_id },
      }),
      this.prisma.scholarProfile.findUnique({
        where: { profile_id: dto.scholar_profile_id },
        select: { profile_id: true, first_name: true, last_name: true },
      }),
    ]);

    if (!deadline) {
      throw new NotFoundException(`Deadline ID ${dto.deadline_id} not found.`);
    }
    if (!scholar) {
      throw new NotFoundException(
        `Scholar profile ID ${dto.scholar_profile_id} not found.`,
      );
    }

    const exemption = await this.prisma.deadlineExemption.upsert({
      where: {
        deadline_id_scholar_profile_id: {
          deadline_id: dto.deadline_id,
          scholar_profile_id: dto.scholar_profile_id,
        },
      },
      create: {
        deadline_id: dto.deadline_id,
        scholar_profile_id: dto.scholar_profile_id,
        reason: dto.reason?.trim() || null,
        exempted_by_user_id: staffUserId,
      },
      update: {
        reason: dto.reason?.trim() || null,
        exempted_by_user_id: staffUserId,
      },
    });

    await this.auditService.log(
      staffUserId,
      'DEADLINE_EXEMPTION_SET',
      `Marked ${scholar.first_name} ${scholar.last_name} exempt for deadline #${dto.deadline_id}${dto.reason ? ` (${dto.reason.trim()})` : ''}.`,
    );

    this.eventsGateway.emitToAll('deadline:updated', {
      action: 'EXEMPTED',
      deadlineId: dto.deadline_id,
      scholarProfileId: dto.scholar_profile_id,
    });

    return exemption;
  }

  async removeExemption(
    staffUserId: number,
    deadlineId: number,
    scholarProfileId: number,
  ) {
    await this.prisma.deadlineExemption.deleteMany({
      where: {
        deadline_id: deadlineId,
        scholar_profile_id: scholarProfileId,
      },
    });

    await this.auditService.log(
      staffUserId,
      'DEADLINE_EXEMPTION_REMOVED',
      `Removed exemption for scholar profile #${scholarProfileId} on deadline #${deadlineId}.`,
    );

    this.eventsGateway.emitToAll('deadline:updated', {
      action: 'EXEMPTION_REMOVED',
      deadlineId,
      scholarProfileId,
    });

    return { message: 'Deadline exemption removed.' };
  }

  async getMyDeadlines(userId: number) {
    const scholar = await this.prisma.scholarProfile.findUnique({
      where: { user_id: userId },
      include: {
        user: { select: { email: true } },
        school: {
          select: { school_id: true, school_name: true },
        },
        school_grading_system: {
          select: { school_id: true, school_name: true },
        },
        prospectus: {
          include: {
            subjects: {
              select: { year_level: true, semester: true, status: true },
            },
          },
        },
        enrollments: {
          select: {
            enrollment_id: true,
            academic_year: true,
            semester: true,
            status: true,
            cor_document_id: true,
            soa_document_id: true,
          },
        },
        grade_reports: {
          select: {
            report_id: true,
            academic_year: true,
            semester: true,
            status: true,
            submitted_at: true,
          },
        },
      },
    });

    if (!scholar) {
      throw new NotFoundException('Scholar profile not found.');
    }

    const activeTerm = await this.settingsService.getAcademicTermStatus();
    const activeAy =
      normalizeAcademicYear(activeTerm.effective_academic_year) ||
      activeTerm.effective_academic_year;
    const activeSem =
      normalizeSemester(activeTerm.effective_semester) ||
      activeTerm.effective_semester;

    const termPairs: Array<{
      academic_year: string;
      semester: string;
      isSystemActiveTerm: boolean;
    }> = [
      {
        academic_year: activeAy,
        semester: activeSem,
        isSystemActiveTerm: true,
      },
    ];

    for (const e of scholar.enrollments || []) {
      if (!['APPROVED', 'PENDING_REVIEW'].includes(e.status)) continue;
      const eAy = normalizeAcademicYear(e.academic_year) || e.academic_year;
      const eSem = normalizeSemester(e.semester) || e.semester;
      if (!eAy || !eSem) continue;

      const hasSubmittedGrade = (scholar.grade_reports || []).some(
        (r) =>
          normalizeSemester(r.semester) === eSem &&
          academicYearsMatchForTerm(r.academic_year, eAy, eSem) &&
          r.status !== 'REJECTED',
      );
      if (hasSubmittedGrade) continue;

      const alreadyIncluded = termPairs.some(
        (tp) =>
          tp.semester === eSem &&
          academicYearsMatchForTerm(tp.academic_year, eAy, eSem),
      );
      if (!alreadyIncluded) {
        termPairs.push({
          academic_year: eAy,
          semester: eSem,
          isSystemActiveTerm: false,
        });
      }
    }

    const deadlines = await this.prisma.submissionDeadline.findMany({
      where: {
        is_active: true,
        OR: termPairs.map((tp) => ({
          academic_year: tp.academic_year,
          semester: tp.semester,
        })),
      },
      include: {
        school: {
          select: { school_id: true, school_name: true, school_code: true },
        },
      },
      orderBy: { due_date: 'asc' },
    });

    const deadlineIds = deadlines.map((d) => d.deadline_id);
    const exemptions =
      deadlineIds.length > 0
        ? await this.prisma.deadlineExemption.findMany({
            where: {
              scholar_profile_id: scholar.profile_id,
              deadline_id: { in: deadlineIds },
            },
          })
        : [];

    const now = new Date();
    const items: Array<Record<string, any>> = [];
    const seenDeadlineIds = new Set<number>();

    for (const tp of termPairs) {
      const scopedDeadlines = deadlines.filter(
        (d) =>
          normalizeSemester(d.semester) === tp.semester &&
          academicYearsMatchForTerm(d.academic_year, tp.academic_year, tp.semester),
      );

      for (const reqType of DEADLINE_REQUIREMENT_TYPES) {
        const effectiveDeadline = resolveEffectiveDeadline(
          scopedDeadlines,
          reqType,
          scholar,
        );
        if (
          !effectiveDeadline ||
          seenDeadlineIds.has(effectiveDeadline.deadline_id)
        ) {
          continue;
        }

        const exemption =
          exemptions.find(
            (e) => e.deadline_id === effectiveDeadline.deadline_id,
          ) ?? null;

        const evaluation = evaluateScholarRequirementStatus({
          deadline: effectiveDeadline,
          scholar,
          exemption,
          now,
        });

        if (
          !tp.isSystemActiveTerm &&
          ['NOT_APPLICABLE', 'CURRENTLY_ENROLLED'].includes(evaluation.status)
        ) {
          continue;
        }

        seenDeadlineIds.add(effectiveDeadline.deadline_id);
        items.push({
          deadline_id: effectiveDeadline.deadline_id,
          requirement_type: reqType,
          requirement_label: getRequirementLabel(reqType),
          action_path: getRequirementActionPath(reqType),
          academic_year: effectiveDeadline.academic_year,
          semester: effectiveDeadline.semester,
          due_date: effectiveDeadline.due_date.toISOString(),
          effective_due_date: evaluation.effective_due_date,
          grace_period_days: effectiveDeadline.grace_period_days,
          is_optional_term: effectiveDeadline.is_optional_term,
          title: effectiveDeadline.title ?? null,
          instructions: effectiveDeadline.instructions ?? null,
          status: evaluation.status,
          status_detail: evaluation.status_detail,
          days_remaining: evaluation.days_remaining,
          days_overdue: evaluation.days_overdue,
        });
      }
    }

    return {
      academic_year: activeTerm.effective_academic_year,
      semester: activeTerm.effective_semester,
      deadlines: items,
    };
  }
}
