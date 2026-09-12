import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class SelectSchoolDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'ID of an existing SchoolGradingSystem in the database',
  })
  @IsNumber()
  @IsOptional()
  school_id?: number;

  @ApiPropertyOptional({
    example: 'The University of Mindanao',
    description:
      'Name of the school if proposing/registering a new institution not yet listed',
  })
  @IsString()
  @IsOptional()
  new_school_name?: string;

  @ApiPropertyOptional({
    example: 'UM_SCALE',
    description: 'Scale identifier (e.g., UM_SCALE, NUMERIC_4_POINT, NUMERIC_5_POINT, PERCENTAGE_100)',
  })
  @IsString()
  @IsOptional()
  grading_scale?: string;

  @ApiPropertyOptional({
    example: 2.0,
    description: 'Passing mark boundary (e.g., 2.0, 75.0, 3.0)',
  })
  @IsNumber()
  @IsOptional()
  passing_grade?: number;

  @ApiPropertyOptional({
    example: 4.0,
    description: 'Highest possible mark (e.g., 4.0, 100.0, 1.0)',
  })
  @IsNumber()
  @IsOptional()
  highest_grade?: number;

  @ApiPropertyOptional({
    example: 1.0,
    description: 'Failing mark boundary (e.g., 1.0, 50.0, 5.0)',
  })
  @IsNumber()
  @IsOptional()
  failing_grade?: number;

  @ApiPropertyOptional({
    example: 1.0,
    description: 'Minimum grade on transcript',
  })
  @IsNumber()
  @IsOptional()
  min_grade?: number;

  @ApiPropertyOptional({
    example: 4.0,
    description: 'Maximum grade on transcript',
  })
  @IsNumber()
  @IsOptional()
  max_grade?: number;

  @ApiPropertyOptional({
    example: {
      '1.0': 'FAILED',
      '7.1': 'NOT_FULLY_PAID',
      '7.2': 'LACKING_REQUIREMENTS',
      '9.0': 'DROPPED',
    },
    description: 'Non-standard status codes for the institution',
  })
  @IsObject()
  @IsOptional()
  special_codes?: Record<string, string>;

  @ApiPropertyOptional({
    example: '1.0 is Failed, 2.0 is Passing (75-79), 4.0 is Highest (95-100)',
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
