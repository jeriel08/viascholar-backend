import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { ArchiveService } from './archive.service.js';
import { ArchiveRecordDto } from './dto/archive-record.dto.js';
import { QueryArchiveDto } from './dto/query-archive.dto.js';

@ApiTags('Archive')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('archive')
export class ArchiveController {
  constructor(private readonly archiveService: ArchiveService) {}

  @Get()
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'List archived scholars, applicants, schools, or programs with filters',
  })
  listArchived(@Query() query: QueryArchiveDto) {
    return this.archiveService.listArchived(query);
  }

  @Get('summary')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({ summary: 'Get archived record counts grouped by type/reason' })
  getSummary() {
    return this.archiveService.getArchiveSummary();
  }

  // ==========================================
  // SCHOOLS
  // ==========================================

  @Patch('schools/:id')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Archive a school institution (Admin & Grantor)' })
  archiveSchool(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchiveRecordDto,
  ) {
    return this.archiveService.archiveSchool(req.user.user_id, id, dto);
  }

  @Patch('schools/:id/restore')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Restore an archived school institution' })
  restoreSchool(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.archiveService.restoreSchool(req.user.user_id, id);
  }

  // ==========================================
  // PROGRAMS
  // ==========================================

  @Patch('programs/:id')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Archive an academic program (Admin & Grantor)' })
  archiveProgram(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchiveRecordDto,
  ) {
    return this.archiveService.archiveProgram(req.user.user_id, id, dto);
  }

  @Patch('programs/:id/restore')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Restore an archived academic program' })
  restoreProgram(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.archiveService.restoreProgram(req.user.user_id, id);
  }

  // ==========================================
  // SCHOLARS
  // ==========================================

  @Patch('scholars/:id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Archive a scholar (graduated, failed second chance, withdrawn, terminated)',
  })
  archiveScholar(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchiveRecordDto,
  ) {
    return this.archiveService.archiveScholar(req.user.user_id, id, dto);
  }

  @Patch('scholars/:id/restore')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Restore an archived scholar' })
  restoreScholar(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.archiveService.restoreScholar(req.user.user_id, id);
  }

  // ==========================================
  // APPLICANTS
  // ==========================================

  @Patch('applicants/:id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Archive an applicant (e.g. rejected applications)',
  })
  archiveApplicant(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ArchiveRecordDto,
  ) {
    return this.archiveService.archiveApplicant(req.user.user_id, id, dto);
  }

  @Patch('applicants/:id/restore')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Restore an archived applicant' })
  restoreApplicant(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.archiveService.restoreApplicant(req.user.user_id, id);
  }
}
