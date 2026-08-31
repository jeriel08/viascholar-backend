import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class ScheduleInterviewDto {
  @ApiProperty({
    example: '2026-09-15T10:00:00.000Z',
    description: 'Scheduled date and time for the interview (ISO string)',
  })
  @IsDateString()
  @IsNotEmpty()
  interview_at: string;

  @ApiPropertyOptional({
    example: 45,
    description: 'Interview duration in minutes (default 45)',
  })
  @IsInt()
  @Min(15)
  @Max(180)
  @IsOptional()
  duration_minutes?: number;

  @ApiPropertyOptional({
    example: 'Please prepare your academic background overview.',
    description: 'Notes or instructions for the applicant',
  })
  @IsString()
  @IsOptional()
  provider_notes?: string;

  @ApiPropertyOptional({
    example: 'https://meet.google.com/abc-defg-hij',
    description:
      'Optional manual meeting link. If omitted, Google Meet link is automatically created via Google Calendar API.',
  })
  @IsString()
  @IsOptional()
  manual_meeting_link?: string;
}
