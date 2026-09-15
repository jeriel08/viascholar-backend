import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SettingsService } from './settings.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { CreateSchoolGradingDto } from './dto/create-school-grading.dto.js';
import { UpdateSchoolGradingDto } from './dto/update-school-grading.dto.js';

@ApiTags('Settings & School Grading')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get current global settings (Grade threshold)' })
  getSettings() {
    return this.settingsService.getSettings();
  }

  @Patch()
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Update global settings (Admin & Grantor)' })
  updateSettings(@Request() req, @Body() dto: UpdateSettingsDto) {
    return this.settingsService.updateSettings(req.user.user_id, dto);
  }

  @Get('schools')
  @ApiOperation({ summary: 'Get all configured school grading systems' })
  getSchoolGradings() {
    return this.settingsService.getSchoolGradings();
  }

  @Post('schools')
  @Roles(
    Role.ADMIN,
    Role.GRANTOR,
    Role.COORDINATOR,
    Role.SCHOLAR,
    Role.APPLICANT,
  )
  @ApiOperation({
    summary: 'Add or propose a school grading system configuration',
  })
  createSchoolGrading(@Request() req, @Body() dto: CreateSchoolGradingDto) {
    return this.settingsService.createSchoolGrading(
      req.user.user_id,
      dto,
      req.user.role,
    );
  }

  @Patch('schools/:id/verify')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary:
      'Coordinator/Staff verifies a student-proposed school grading scale',
  })
  verifySchoolGrading(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.settingsService.verifySchoolGrading(req.user.user_id, id);
  }

  @Delete('schools/:id')
  @Roles(Role.ADMIN, Role.GRANTOR)
  @ApiOperation({ summary: 'Delete a school grading system configuration' })
  deleteSchoolGrading(@Request() req, @Param('id', ParseIntPipe) id: number) {
    return this.settingsService.deleteSchoolGrading(req.user.user_id, id);
  }

  @Patch('schools/:id')
  @Roles(Role.ADMIN, Role.GRANTOR, Role.COORDINATOR)
  @ApiOperation({
    summary: 'Update an existing school grading system configuration',
  })
  updateSchoolGrading(
    @Request() req,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSchoolGradingDto,
  ) {
    return this.settingsService.updateSchoolGrading(req.user.user_id, id, dto);
  }
}
