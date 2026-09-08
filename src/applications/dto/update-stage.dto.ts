import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsDateString,
  IsBoolean,
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
    example: 'https://meet.google.com/abc-defg-hij',
    description: 'Google Meet or video meeting link',
  })
  @IsString()
  @IsOptional()
  interview_meeting_link?: string;

  @ApiPropertyOptional({
    description: 'Google Calendar Event ID',
  })
  @IsString()
  @IsOptional()
  interview_calendar_event_id?: string;

  @ApiPropertyOptional({
    description: 'Reason provided if reschedule was requested/performed',
  })
  @IsString()
  @IsOptional()
  reschedule_reason?: string;

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

  @ApiPropertyOptional({
    example: true,
    description:
      'Explicit confirmation flag to proceed if no meeting has occurred yet',
  })
  @IsBoolean()
  @IsOptional()
  confirm_without_meeting?: boolean;
}
