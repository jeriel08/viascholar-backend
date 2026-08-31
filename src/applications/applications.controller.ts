import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { CreateApplicationDto } from './dto/create-application.dto.js';
import { ApplicationsService } from './applications.service.js';
import { QueryApplicationsDto } from './dto/query-applications.dto.js';
import { UpdateApplicationStageDto } from './dto/update-stage.dto.js';
import { ScheduleInterviewDto } from './dto/schedule-interview.dto.js';
import { RequestRescheduleDto } from './dto/request-reschedule.dto.js';
import { RescheduleInterviewDto } from './dto/reschedule-interview.dto.js';

@ApiTags('Scholarship Applications')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Post()
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary: 'Submit or update scholarship application track (Scholar only)',
  })
  submitApplication(@Request() req, @Body() dto: CreateApplicationDto) {
    return this.applicationsService.submitApplication(req.user.user_id, dto);
  }

  @Get('me')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary: 'Get current scholar application status and stage timeline',
  })
  getMyApplication(@Request() req) {
    return this.applicationsService.getMyApplication(req.user.user_id);
  }

  @Post('me/request-reschedule')
  @Roles(Role.APPLICANT, Role.SCHOLAR)
  @ApiOperation({
    summary: 'Request interview rescheduling with a reason (Student only)',
  })
  requestReschedule(@Request() req, @Body() dto: RequestRescheduleDto) {
    return this.applicationsService.requestReschedule(req.user.user_id, dto);
  }

  @Get()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'List all scholarship applications with search & status filters',
  })
  findAll(@Query() query: QueryApplicationsDto) {
    return this.applicationsService.findAll(query);
  }

  @Post(':id/schedule-interview')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Schedule interview with automated Google Meet & Calendar invite (Staff only)',
  })
  scheduleInterview(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ScheduleInterviewDto,
  ) {
    return this.applicationsService.scheduleInterview(
      req.user.user_id,
      id,
      dto,
    );
  }

  @Patch(':id/reschedule-interview')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Reschedule existing interview and update calendar event (Staff only)',
  })
  rescheduleInterview(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RescheduleInterviewDto,
  ) {
    return this.applicationsService.rescheduleInterview(
      req.user.user_id,
      id,
      dto,
    );
  }

  @Patch(':id/stage')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Update application evaluation stage or status (Staff only)',
  })
  updateStage(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateApplicationStageDto,
  ) {
    return this.applicationsService.updateStage(
      req.user.user_id,
      id,
      dto,
      req.user.role,
    );
  }
}

