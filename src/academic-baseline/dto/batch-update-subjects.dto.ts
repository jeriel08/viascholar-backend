import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { UpdateProspectusSubjectDto } from './update-prospectus-subject.dto.js';

export class BatchUpdateSubjectsDto {
  @ApiPropertyOptional({
    example: '2023-2024',
    description: 'Curriculum catalog year',
  })
  @IsString()
  @IsOptional()
  curriculum_year?: string;

  @ApiPropertyOptional({ example: 'BSIT', description: 'Degree course code' })
  @IsString()
  @IsOptional()
  course_code?: string;

  @ApiPropertyOptional({
    example: 'Bachelor of Science in Information Technology',
    description: 'Degree program name',
  })
  @IsString()
  @IsOptional()
  course_name?: string;

  @ApiProperty({
    type: [UpdateProspectusSubjectDto],
    description: 'Array of prospectus subjects',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UpdateProspectusSubjectDto)
  subjects: UpdateProspectusSubjectDto[];
}
