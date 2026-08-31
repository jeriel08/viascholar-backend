import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateApplicationDto {
  @ApiProperty({
    example: 'Academic Track',
    description: 'Selected scholarship track',
  })
  @IsString()
  @IsNotEmpty()
  scholarship_track: string;

  @ApiPropertyOptional({ example: 'BS Information Technology' })
  @IsString()
  @IsOptional()
  course_of_study?: string;

  @ApiPropertyOptional({ example: 'University of Mindanao' })
  @IsString()
  @IsOptional()
  school_name?: string;

  @ApiPropertyOptional({
    example: 'Juan Dela Cruz',
    description: 'Name of a relative who is an employee of the organization',
  })
  @IsString()
  @IsOptional()
  relative_employee?: string;
}
