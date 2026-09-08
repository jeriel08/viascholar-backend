import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { MeetingsService } from './meetings.service.js';
import { QueryMeetingsDto } from './dto/query-meetings.dto.js';

@ApiTags('Staff Meetings')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('meetings')
export class MeetingsController {
  constructor(private readonly meetingsService: MeetingsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'List scheduled interviews from the meetings table (Staff only)',
  })
  findAll(@Query() query: QueryMeetingsDto) {
    return this.meetingsService.findAll(query);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'View one scheduled interview in full (Staff only)',
  })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.meetingsService.findOne(id);
  }
}
