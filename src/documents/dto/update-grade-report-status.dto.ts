import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { GradeReportStatus } from '../../generated/prisma/enums.js';

export class UpdateGradeReportStatusDto {
  @ApiProperty({
    enum: GradeReportStatus,
    example: 'APPROVED',
    description: 'New review status for the grade report',
  })
  @IsEnum(GradeReportStatus)
  @IsNotEmpty()
  status: GradeReportStatus;

  @ApiPropertyOptional({
    example: 'Student submitted medical certificate for incomplete mark; approved for disbursement.',
    description: 'Remarks or justification for the status override',
  })
  @IsString()
  @IsOptional()
  remarks?: string;
}
