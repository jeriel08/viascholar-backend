import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSchoolDto {
  @ApiProperty({
    example: 'University of Mindanao (UM)',
    description: 'Official name of the academic institution',
  })
  @IsString()
  @IsNotEmpty()
  school_name: string;

  @ApiPropertyOptional({
    example: 'UM',
    description: 'Unique institution abbreviation or acronym',
  })
  @IsString()
  @IsOptional()
  school_code?: string;

  @ApiPropertyOptional({
    example: 'Bolton & Matina Campus, Davao City, 8000 Davao del Sur',
    description: 'Campus or main institution physical address',
  })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({
    example: 'admissions@umindanao.edu.ph',
    description: 'Official contact or admissions email',
  })
  @IsString()
  @IsOptional()
  contact_email?: string;

  @ApiPropertyOptional({
    example: '+63 82 227 5456',
    description: 'Official contact phone number',
  })
  @IsString()
  @IsOptional()
  contact_number?: string;

  @ApiPropertyOptional({
    example: 3,
    description: 'ID of the associated SchoolGradingSystem grading scale',
  })
  @IsInt()
  @IsOptional()
  grading_system_id?: number;

  @ApiPropertyOptional({
    example: 'NUMERIC_5_POINT',
    description: 'Standard grading scale template (NUMERIC_5_POINT, NUMERIC_4_POINT, or PERCENTAGE_100)',
  })
  @IsString()
  @IsOptional()
  grading_scale?: string;

  @ApiPropertyOptional({
    example: { '7.1': 'Unpaid Tuition', '7.2': 'Incomplete', '9.0': 'Dropped' },
    description: 'Special grade codes mapping (e.g. 7.1, 7.2, 9.0, INC, DRP)',
  })
  @IsOptional()
  special_codes?: Record<string, string>;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether this school is active and selectable by applicants',
  })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}

