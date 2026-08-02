import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';

export class UpdateProfileDto {
  // Shared Profile Fields
  @ApiProperty({ description: 'The first name of the user' })
  @IsString()
  @IsOptional()
  first_name?: string;

  @ApiProperty({ description: 'The last name of the user' })
  @IsString()
  @IsOptional()
  last_name?: string;

  @ApiProperty({ description: 'The bio of the user', required: false })
  @IsString()
  @IsOptional()
  bio?: string;

  @ApiProperty({ description: 'The avatar URL of the user', required: false })
  @IsString()
  @IsOptional()
  avatar_url?: string;

  @ApiProperty({ description: 'The banner URL of the user', required: false })
  @IsString()
  @IsOptional()
  banner_url?: string;

  // Scholar-Specific Fields
  @ApiProperty({
    description: 'The student number of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  student_number?: string;

  @ApiProperty({
    description: 'The course of study of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  course_of_study?: string;

  @ApiProperty({
    description: 'The name of the school of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  school_name?: string;

  @ApiProperty({
    description: 'The current year level of the Scholar',
    required: false,
  })
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  current_year_level?: number;

  @ApiProperty({
    description: 'The scholarship track of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  scholarship_track?: string;

  // Staff-Specific Fields (Employee)
  @ApiProperty({
    description: 'The title of the Staff member',
    required: false,
  })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({
    description: 'The department of the Staff member',
    required: false,
  })
  @IsString()
  @IsOptional()
  department?: string;
}
