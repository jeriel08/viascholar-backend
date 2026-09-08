import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueryMeetingsDto } from './dto/query-meetings.dto.js';

@Injectable()
export class MeetingsService {
  constructor(private prisma: PrismaService) {}

  // Staff lists scheduled interviews from the mirrored meetings table.
  async findAll(query: QueryMeetingsDto) {
    const where: Prisma.MeetingWhereInput = {};

    if (query.status) {
      where.status = query.status;
    }

    if (query.applicationId) {
      where.application_id = query.applicationId;
    }

    if (query.from || query.to) {
      where.scheduled_at = {};
      if (query.from) {
        const from = new Date(query.from);
        if (isNaN(from.getTime())) {
          throw new BadRequestException('Invalid from date provided.');
        }
        where.scheduled_at.gte = from;
      }
      if (query.to) {
        const to = new Date(query.to);
        if (isNaN(to.getTime())) {
          throw new BadRequestException('Invalid to date provided.');
        }
        where.scheduled_at.lte = to;
      }
    }

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

  // Staff views one scheduled interview in full.
  async findOne(meetingId: number) {
    return this.prisma.meeting.findUnique({
      where: { meeting_id: meetingId },
      include: {
        application: true,
        scholar_profile: true,
        employee: true,
      },
    });
  }
}
