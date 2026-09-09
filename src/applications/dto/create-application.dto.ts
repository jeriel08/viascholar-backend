import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateApplicationDto {
  @ApiProperty({
    example: 'Academic Track',
    description: 'Selected scholarship track',
  })
  @IsString()
  @IsNotEmpty()
  scholarship_track: string;

  @ApiProperty({
    example: '2023-00123',
    description: 'Official student/matriculation ID number from the school',
  })
  @IsString()
  @IsNotEmpty()
  student_number: string;

  @ApiProperty({
    example: '123 Main St, Brgy. Central, Davao City',
    description: 'Permanent/Home address of the student applicant',
  })
  @IsString()
  @IsNotEmpty()
  student_address: string;

  @ApiProperty({
    example: 'BS Information Technology',
    description: 'Course or degree program of the applicant',
  })
  @IsString()
  @IsNotEmpty()
  course_of_study: string;

  @ApiProperty({
    example: 'University of Mindanao',
    description: 'Name of the educational institution',
  })
  @IsString()
  @IsNotEmpty()
  school_name: string;

  @ApiProperty({
    example: 'Bolton St, Poblacion, Davao City, Davao del Sur',
    description: 'Campus address of the educational institution',
  })
  @IsString()
  @IsNotEmpty()
  school_address: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Current academic year level of the student (1 to 5: College, 6: Masteral, 7: Doctoral)',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  current_year_level?: number;

  @ApiPropertyOptional({
    example: '09171234567',
    description: 'Optional update to applicant mobile phone number',
  })
  @IsString()
  @IsOptional()
  phone_number?: string;

  @ApiPropertyOptional({
    example: 'Juan Dela Cruz',
    description: 'Name of a relative who is an employee of the organization',
  })
  @IsString()
  @IsOptional()
  relative_employee?: string;
}
