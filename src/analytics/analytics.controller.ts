import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/decorators/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { AnalyticsService } from './analytics.service.js';
import { AnalyticsQueryDto, ExplainChartDto } from './dto/analytics.dto.js';

@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('summary')
  @Roles(Role.GRANTOR, Role.COORDINATOR, Role.ADMIN)
  @ApiOperation({
    summary:
      'Get unified descriptive analytics (Mean, Std Dev, Compliance, Percentiles, Disbursements, Funnel)',
  })
  getDescriptiveAnalytics(@Query() query: AnalyticsQueryDto) {
    return this.analyticsService.getDescriptiveAnalytics(query);
  }

  @Post('explain')
  @Roles(Role.GRANTOR, Role.COORDINATOR, Role.ADMIN)
  @ApiOperation({
    summary:
      'Generate LLM / AI narrative explanation and statistical interpretation for a chart or metric',
  })
  explainChart(@Body() dto: ExplainChartDto) {
    return this.analyticsService.explainChartWithAi(dto);
  }
}
