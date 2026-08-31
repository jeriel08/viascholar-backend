import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class GradeItemDto {
  @ApiPropertyOptional({
    example: 'IT 24',
    description: 'Subject code (optional for high school Form 138)',
  })
  @IsString()
  @IsOptional()
  subject_code?: string;

  @ApiPropertyOptional({
    example: 'Capstone Project 2',
    description: 'Subject descriptive title',
  })
  @IsString()
  @IsOptional()
  subject_name?: string;

  @ApiPropertyOptional({
    example: 3.0,
    description:
      'Subject credit units. Defaults to 1.0 if omitted (e.g. for High School Form 138)',
  })
  @IsNumber()
  @IsOptional()
  units?: number;

  @ApiProperty({
    example: 89.0,
    description: 'Grade earned in the subject',
  })
  @IsNumber()
  @IsNotEmpty()
  grade: number;
}
