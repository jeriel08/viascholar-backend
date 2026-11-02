import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
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
    example: '202300123',
    description: 'Official student/matriculation ID number from the school',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{5,12}$/, {
    message:
      'Student number must be between 5 and 12 numerical digits (exclude dashes or special characters).',
  })
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
    description:
      'Current academic year level of the student (1 to 5: College, 6: Masteral, 7: Doctoral)',
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
    example: 'Juan P. Dela Cruz',
    description: 'Name of a relative who is an employee of the organization',
  })
  @IsString()
  @IsOptional()
  @ValidateIf(
    (o) =>
      typeof o.relative_employee === 'string' &&
      o.relative_employee.trim().length > 0,
  )
  @Matches(/^[a-zA-ZÀ-ÿñÑ\s\.\-']+$/, {
    message:
      'Relative employee name can only contain letters, spaces, and periods (e.g. for middle initials).',
  })
  relative_employee?: string;
}
