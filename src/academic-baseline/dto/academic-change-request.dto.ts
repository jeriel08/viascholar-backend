import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export type AcademicChangeType = 'PROGRAM_SHIFT' | 'SCHOOL_TRANSFER' | 'BOTH';

export class CreateAcademicChangeRequestDto {
  @ApiProperty({ enum: ['PROGRAM_SHIFT', 'SCHOOL_TRANSFER', 'BOTH'] })
  @IsIn(['PROGRAM_SHIFT', 'SCHOOL_TRANSFER', 'BOTH'])
  change_type!: AcademicChangeType;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  requested_program_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  requested_course_of_study?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  requested_school_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  requested_school_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(15)
  effective_academic_year?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  effective_semester?: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(10, { message: 'Please provide a brief explanation (at least 10 characters).' })
  @MaxLength(2000)
  reason!: string;
}

export class ReviewAcademicChangeRequestDto {
  @ApiProperty({ enum: ['APPROVED', 'DENIED'] })
  @IsIn(['APPROVED', 'DENIED'])
  decision!: 'APPROVED' | 'DENIED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1500)
  decision_notes?: string;
}
