import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class GradeItemDto {
  @ApiProperty({ example: 'IT 24' })
  @IsString()
  @IsNotEmpty()
  subject_code: string;

  @ApiPropertyOptional({ example: 'Capstone Project 2' })
  @IsString()
  @IsOptional()
  subject_name?: string;

  @ApiProperty({ example: 3.0 })
  @IsNumber()
  units: number;

  @ApiProperty({ example: 3.5 })
  @IsNumber()
  grade: number;
}
