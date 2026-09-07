import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { GradeReportStatus } from '../../generated/prisma/enums.js';

export class QueryGradeReportsDto {
  @ApiPropertyOptional({
    enum: GradeReportStatus,
    description:
      'Filter by grade report status (PENDING, APPROVED, FLAGGED, REJECTED)',
  })
  @IsEnum(GradeReportStatus)
  @IsOptional()
  status?: GradeReportStatus;

  @ApiPropertyOptional({
    example: '2025-2026',
    description: 'Filter by academic year',
  })
  @IsString()
  @IsOptional()
  academic_year?: string;

  @ApiPropertyOptional({
    example: '1st Semester',
    description: 'Filter by semester',
  })
  @IsString()
  @IsOptional()
  semester?: string;

  @ApiPropertyOptional({
    example: 'Jeriel',
    description: 'Search by student name or student number',
  })
  @IsString()
  @IsOptional()
  search?: string;
}
