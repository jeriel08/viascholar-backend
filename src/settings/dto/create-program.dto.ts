import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateAcademicProgramDto {
  @ApiProperty({
    example: 'BSIT',
    description: 'Unique program or degree abbreviation/code',
  })
  @IsString()
  @IsNotEmpty()
  program_code: string;

  @ApiProperty({
    example: 'BS Information Technology',
    description: 'Full program name or strand title',
  })
  @IsString()
  @IsNotEmpty()
  program_name: string;

  @ApiPropertyOptional({
    example: 'College',
    description: 'Category (College, Senior High School, Vocational)',
  })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({
    example: 'Bachelor of Science in Information Technology',
    description: 'Detailed description or notes about the program',
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Whether this program is active and selectable by applicants',
  })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}

