import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsDateString,
} from 'class-validator';
import { ApplicationStatus } from '../../generated/prisma/enums.js';

export class UpdateApplicationStageDto {
  @ApiProperty({ enum: ApplicationStatus, example: 'UNDER_REVIEW' })
  @IsEnum(ApplicationStatus)
  @IsNotEmpty()
  status: ApplicationStatus;

  @ApiProperty({
    example: 'Under Review',
    description: 'Label for UI stage tracker',
  })
  @IsString()
  @IsNotEmpty()
  stage: string;

  @ApiPropertyOptional({
    example: '2026-08-15T10:00:00Z',
    description: 'Scheduled interview date',
  })
  @IsDateString()
  @IsOptional()
  interview_at?: string;

  @ApiPropertyOptional({
    example: 'Applicant meets GWA threshold requirements.',
  })
  @IsString()
  @IsOptional()
  provider_notes?: string;

  @ApiPropertyOptional({
    example: 'GWA did not meet the mandatory 90% threshold.',
  })
  @IsString()
  @IsOptional()
  rejection_reason?: string;
}
