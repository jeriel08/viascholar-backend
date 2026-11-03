import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Role } from '../generated/prisma/enums.js';
import { QueryMeetingsDto } from './dto/query-meetings.dto.js';

@Injectable()
export class MeetingsService {
  constructor(private prisma: PrismaService) {}

  // Lists scheduled meetings. Staff lists all; Scholar/Applicant lists their own meetings.
  async findAll(
    query: QueryMeetingsDto,
    user?: { user_id: number; role: Role },
  ) {
    const conditions: Prisma.MeetingWhereInput[] = [];

    const isStaff =
      user &&
      ([Role.ADMIN, Role.GRANTOR, Role.COORDINATOR] as Role[]).includes(
        user.role,
      );

    if (!isStaff && user?.user_id) {
      // Find the scholar profile for the student
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { user_id: user.user_id },
        select: { profile_id: true },
      });

      if (!scholar) {
        return {
          data: [],
          total: 0,
          page: query.page ?? 1,
          limit: Math.min(query.limit ?? 50, 200),
        };
      }

      conditions.push({
        OR: [
          { scholar_profile_id: scholar.profile_id },
          { application: { scholar_profile_id: scholar.profile_id } },
        ],
      });
    }

    if (query.status) {
      conditions.push({ status: query.status });
    }

    if (query.applicationId) {
      conditions.push({ application_id: query.applicationId });
    }

    if (query.from || query.to) {
      const scheduledAtFilter: Prisma.DateTimeNullableFilter = {};
      if (query.from) {
        const from = new Date(query.from);
        if (isNaN(from.getTime())) {
          throw new BadRequestException('Invalid from date provided.');
        }
        scheduledAtFilter.gte = from;
      }
      if (query.to) {
        const to = new Date(query.to);
        if (isNaN(to.getTime())) {
          throw new BadRequestException('Invalid to date provided.');
        }
        scheduledAtFilter.lte = to;
      }
      conditions.push({ scheduled_at: scheduledAtFilter });
    }

    const where: Prisma.MeetingWhereInput =
      conditions.length > 0 ? { AND: conditions } : {};

    const page = query.page ?? 1;
    const limit = Math.min(query.limit ?? 50, 200);

    const [total, meetings] = await this.prisma.$transaction([
      this.prisma.meeting.count({ where }),
      this.prisma.meeting.findMany({
        where,
        orderBy: { scheduled_at: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          application: {
            select: { application_id: true, status: true, stage: true },
          },
          scholar_profile: {
            select: {
              profile_id: true,
              first_name: true,
              last_name: true,
              course_of_study: true,
              scholarship_track: true,
            },
          },
          employee: {
            select: {
              employee_id: true,
              first_name: true,
              last_name: true,
              title: true,
              // Who scheduled it — coordinator or grantor.
              user: { select: { role: true } },
            },
          },
        },
      }),
    ]);

    return {
      data: meetings,
      total,
      page,
      limit,
    };
  }

  // Views one scheduled meeting in full.
  async findOne(
    meetingId: number,
    user?: { user_id: number; role: Role },
  ) {
    const meeting = await this.prisma.meeting.findUnique({
      where: { meeting_id: meetingId },
      include: {
        application: true,
        scholar_profile: true,
        employee: {
          select: {
            employee_id: true,
            first_name: true,
            last_name: true,
            title: true,
            user: { select: { role: true } },
          },
        },
      },
    });

    if (!meeting) {
      throw new NotFoundException(`Meeting ID ${meetingId} not found.`);
    }

    const isStaff =
      user &&
      ([Role.ADMIN, Role.GRANTOR, Role.COORDINATOR] as Role[]).includes(
        user.role,
      );

    if (!isStaff && user?.user_id) {
      const scholar = await this.prisma.scholarProfile.findUnique({
        where: { user_id: user.user_id },
        select: { profile_id: true },
      });

      const isOwner =
        (scholar && meeting.scholar_profile_id === scholar.profile_id) ||
        (scholar &&
          meeting.application?.scholar_profile_id === scholar.profile_id);

      if (!isOwner) {
        throw new ForbiddenException(
          'You do not have permission to view this meeting.',
        );
      }
    }

    return meeting;
  }
}