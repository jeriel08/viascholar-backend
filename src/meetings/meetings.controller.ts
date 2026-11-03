import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { MeetingsService } from './meetings.service.js';
import { QueryMeetingsDto } from './dto/query-meetings.dto.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    email: string;
    role: Role;
  };
}

@ApiTags('Meetings')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR, Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary:
      'List scheduled meetings from the meetings table (Staff lists all, Scholar/Applicant lists their own)',
  })
  findAll(
    @Request() req: AuthenticatedRequest,
    @Query() query: QueryMeetingsDto,
  ) {
    return this.meetingsService.findAll(query, req.user);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR, Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary:
      'View one scheduled meeting in full (Staff views any, Scholar/Applicant views own)',
  })
  findOne(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.meetingsService.findOne(id, req.user);
  }
}