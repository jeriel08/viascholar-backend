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

export class RescheduleInterviewDto {
  @ApiProperty({
    example: '2026-09-18T14:00:00.000Z',
    description: 'New scheduled date and time for the interview (ISO string)',
  })
  @IsDateString()
  @IsNotEmpty()
  new_interview_at: string;

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
    example: 'Rescheduled per student request.',
    description: 'Updated provider notes or reason for reschedule',
  })
  @IsString()
  @IsOptional()
  reschedule_notes?: string;

  @ApiPropertyOptional({
    example: 'https://meet.google.com/xyz-uvwx-rst',
    description: 'Optional manual meeting link if changing room',
  })
  @IsString()
  @IsOptional()
  manual_meeting_link?: string;
}
