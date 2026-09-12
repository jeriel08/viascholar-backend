import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class CreateSchoolGradingDto {
  @ApiProperty({
    example: 'University of Mindanao',
    description: 'Name of the educational institution',
  })
  @IsString()
  @IsNotEmpty()
  school_name: string;

  @ApiProperty({ example: 'UM_SCALE', description: 'Grading scale identifier' })
  @IsString()
  @IsNotEmpty()
  grading_scale: string;

  @ApiProperty({
    example: 2.0,
    description: 'Minimum passing mark (e.g., 2.0 or 75.0)',
  })
  @IsNumber()
  passing_grade: number;

  @ApiProperty({
    example: 4.0,
    description: 'Highest possible grade (e.g., 4.0 or 100.0)',
  })
  @IsNumber()
  highest_grade: number;

  @ApiProperty({
    example: 1.0,
    description: 'Failing mark boundary (e.g., 1.0 or 74.0)',
  })
  @IsNumber()
  failing_grade: number;

  @ApiPropertyOptional({
    example: 1.0,
    description: 'Minimum grade on transcript (e.g., 1.0 or 50.0)',
  })
  @IsNumber()
  @IsOptional()
  min_grade?: number;

  @ApiPropertyOptional({
    example: 5.0,
    description: 'Maximum grade on transcript (e.g., 5.0 or 100.0)',
  })
  @IsNumber()
  @IsOptional()
  max_grade?: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether this grading scale is verified by staff',
  })
  @IsOptional()
  is_verified?: boolean;

  @ApiPropertyOptional({
    example: {
      '1.0': 'FAILED',
      '7.1': 'NOT_FULLY_PAID',
      '7.2': 'LACKING_REQUIREMENTS',
      '9.0': 'DROPPED',
    },
    description: 'Custom non-standard grade status codes',
  })
  @IsObject()
  @IsOptional()
  special_codes?: Record<string, string>;

  @ApiPropertyOptional({
    example: '1.0 is Failed, 2.0 is 75-79 (Passing), 4.0 is 95-99.',
  })
  @IsString()
  @IsOptional()
  notes?: string;
}
