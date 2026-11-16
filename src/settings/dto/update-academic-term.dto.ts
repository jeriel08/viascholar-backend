import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export class UpdateAcademicTermDto {
  @ApiPropertyOptional({
    example: 7,
    description:
      'Recurring calendar month (1-12) when a new Academic Year automatically starts (default: 7 = July)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  ay_rollover_month?: number;

  @ApiPropertyOptional({
    example: true,
    description:
      'When true, start-of-term enrollment uploads from outdated school years are rejected. Turn false for multi-year simulation/testing.',
  })
  @IsOptional()
  @IsBoolean()
  strict_active_term_policy?: boolean;

  @ApiPropertyOptional({
    example: '2026-2027',
    nullable: true,
    description:
      'Optional manual active Academic Year override (YYYY-YYYY). Pass null or empty string to clear.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @Matches(/^\d{4}-\d{4}$/, {
    message: 'manual_academic_year must be in YYYY-YYYY format (e.g. 2026-2027).',
  })
  manual_academic_year?: string | null;

  @ApiPropertyOptional({
    example: '1st Semester',
    nullable: true,
    description: 'Optional manual active semester override. Pass null or empty string to clear.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @IsIn(['1st Semester', '2nd Semester', 'Summer', '3rd Trimester'])
  manual_semester?: string | null;

  @ApiPropertyOptional({
    example: '2027-05-31',
    nullable: true,
    description:
      'Optional expiration date (YYYY-MM-DD) for manual override; system reverts automatically to calendar calculation afterward.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsDateString()
  manual_override_expires_at?: string | null;
}
