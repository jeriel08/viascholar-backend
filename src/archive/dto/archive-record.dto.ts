import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const ARCHIVE_REASONS = [
  // Schools
  'SCHOOL_CLOSED',
  // Programs
  'PROGRAM_OUTDATED',
  'PROGRAM_REMOVED',
  // Scholars
  'GRADUATED',
  'FAILED_SECOND_CHANCE',
  'WITHDRAWN',
  'TERMINATED',
  // Applicants
  'APPLICATION_REJECTED',
  // Generic
  'OTHER',
] as const;

export type ArchiveReason = (typeof ARCHIVE_REASONS)[number];

export class ArchiveRecordDto {
  @ApiProperty({
    enum: ARCHIVE_REASONS,
    example: 'GRADUATED',
    description: 'Reason why the record is being archived',
  })
  @IsIn(ARCHIVE_REASONS as unknown as string[])
  archive_reason: ArchiveReason;

  @ApiPropertyOptional({
    example: 'Completed the scholarship program last June 2026.',
    description: 'Optional free-text notes for the archive record',
  })
  @IsString()
  @IsOptional()
  @MaxLength(2000)
  archive_notes?: string;
}
