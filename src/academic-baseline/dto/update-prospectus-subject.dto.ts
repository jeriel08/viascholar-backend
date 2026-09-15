import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class UpdateProspectusSubjectDto {
  @ApiPropertyOptional({
    example: 12,
    description: 'Subject ID if updating existing subject',
  })
  @IsNumber()
  @IsOptional()
  subject_id?: number;

  @ApiProperty({ example: 'CCE 102', description: 'Course or subject code' })
  @IsString()
  @IsNotEmpty()
  subject_code: string;

  @ApiProperty({
    example: 'Computer Programming 1',
    description: 'Descriptive title of the subject',
  })
  @IsString()
  @IsNotEmpty()
  descriptive_title: string;

  @ApiProperty({ example: 3.0, description: 'Credit units' })
  @IsNumber()
  units: number;

  @ApiProperty({ example: 1, description: 'Year level (1, 2, 3, 4)' })
  @IsNumber()
  year_level: number;

  @ApiProperty({
    example: '1st Semester',
    description: 'Semester (1st Semester, 2nd Semester, Summer)',
  })
  @IsString()
  @IsNotEmpty()
  semester: string;

  @ApiPropertyOptional({
    example: ['CCE 101'],
    description: 'List of prerequisite subject codes',
  })
  @IsArray()
  @IsOptional()
  prerequisites?: string[];

  @ApiPropertyOptional({
    example: 'UNTAKEN',
    description: 'Status: UNTAKEN, CREDITED, ENROLLED, PASSED, FAILED',
  })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({
    example: 3.5,
    description: 'Historical grade if credited',
  })
  @IsNumber()
  @IsOptional()
  grade?: number;

  @ApiPropertyOptional({
    example: '1st Year - 1st Sem',
    description: 'Term when the course was finished/credited',
  })
  @IsString()
  @IsOptional()
  credited_term?: string;

  @ApiPropertyOptional({ description: 'Additional remarks or notes' })
  @IsString()
  @IsOptional()
  remarks?: string;
}
