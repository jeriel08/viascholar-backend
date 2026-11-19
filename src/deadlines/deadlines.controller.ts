import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Role } from '../generated/prisma/enums.js';
import {
  CreateDeadlineDto,
  ExemptScholarDeadlineDto,
  SendDeadlineFollowUpDto,
  UpdateDeadlineDto,
} from './dto/deadline.dto.js';
import { DeadlinesService } from './deadlines.service.js';

interface AuthenticatedRequest {
  user: {
    user_id: number;
    email: string;
    role: Role;
  };
}

@ApiTags('Submission Deadlines & Tracking')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('deadlines')
export class DeadlinesController {
  constructor(private readonly deadlinesService: DeadlinesService) {}

  @Get('compliance')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Get scholar submission compliance status (submitted, missing, overdue, contacted) for active deadlines',
  })
  getCompliance(
    @Query('academic_year') academic_year?: string,
    @Query('semester') semester?: string,
    @Query('requirement_type') requirement_type?: string,
    @Query('status') status?: string,
    @Query('school_id') school_id?: string,
    @Query('search') search?: string,
  ) {
    return this.deadlinesService.getCompliance({
      academic_year,
      semester,
      requirement_type,
      status,
      school_id: school_id ? Number(school_id) : undefined,
      search,
    });
  }

  @Post('follow-up')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Coordinator/staff sends a follow-up reminder to scholar(s) via direct chat, email, and/or notification',
  })
  sendFollowUp(
    @Request() req: AuthenticatedRequest,
    @Body() dto: SendDeadlineFollowUpDto,
  ) {
    return this.deadlinesService.sendFollowUp(req.user.user_id, dto);
  }

  @Post('exemptions')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Mark a scholar as exempt / not enrolled for a specific deadline so they are not flagged overdue',
  })
  exemptScholar(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ExemptScholarDeadlineDto,
  ) {
    return this.deadlinesService.exemptScholar(req.user.user_id, dto);
  }

  @Delete('exemptions/:deadlineId/:scholarProfileId')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'Remove a scholar deadline exemption' })
  removeExemption(
    @Request() req: AuthenticatedRequest,
    @Param('deadlineId', ParseIntPipe) deadlineId: number,
    @Param('scholarProfileId', ParseIntPipe) scholarProfileId: number,
  ) {
    return this.deadlinesService.removeExemption(
      req.user.user_id,
      deadlineId,
      scholarProfileId,
    );
  }

  @Get('me')
  @Roles(Role.SCHOLAR, Role.APPLICANT)
  @ApiOperation({
    summary:
      'Scholar gets active submission deadlines and their compliance state',
  })
  getMyDeadlines(@Request() req: AuthenticatedRequest) {
    return this.deadlinesService.getMyDeadlines(req.user.user_id);
  }

  @Get()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'List configured submission deadlines' })
  listDeadlines(
    @Query('academic_year') academic_year?: string,
    @Query('semester') semester?: string,
    @Query('requirement_type') requirement_type?: string,
    @Query('only_active') only_active?: string,
  ) {
    return this.deadlinesService.listDeadlines({
      academic_year,
      semester,
      requirement_type,
      only_active: only_active === 'true',
    });
  }

  @Post()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'Create a submission deadline for a term' })
  createDeadline(
    @Request() req: AuthenticatedRequest,
    @Body() dto: CreateDeadlineDto,
  ) {
    return this.deadlinesService.createDeadline(req.user.user_id, dto);
  }

  @Patch(':id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'Update a configured submission deadline' })
  updateDeadline(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDeadlineDto,
  ) {
    return this.deadlinesService.updateDeadline(req.user.user_id, id, dto);
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'Delete a submission deadline' })
  deleteDeadline(
    @Request() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.deadlinesService.deleteDeadline(req.user.user_id, id);
  }
}
