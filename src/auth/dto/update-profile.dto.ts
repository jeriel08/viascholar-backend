import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsInt,
  Min,
  Max,
  Matches,
  MaxLength,
} from 'class-validator';

export class UpdateProfileDto {
  // Shared Profile Fields
  @ApiProperty({ description: 'The first name of the user' })
  @IsString()
  @IsOptional()
  @Matches(/\S/, { message: 'First name is required.' })
  @Matches(/^[a-zA-ZÀ-ÿñÑ\s]+$/, {
    message: 'First name cannot contain numbers or special characters.',
  })
  first_name?: string;

  @ApiProperty({
    description: 'The middle name of the user',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  @Matches(/^[a-zA-ZÀ-ÿñÑ\s]*$/, {
    message: 'Middle name cannot contain numbers or special characters.',
  })
  middle_name?: string;

  @ApiProperty({ description: 'The last name of the user' })
  @IsString()
  @IsOptional()
  @Matches(/\S/, { message: 'Last name is required.' })
  @Matches(/^[a-zA-ZÀ-ÿñÑ\s]+$/, {
    message: 'Last name cannot contain numbers or special characters.',
  })
  last_name?: string;

  @ApiProperty({
    description: 'The name suffix of the user (e.g., Jr., III)',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(30)
  suffix?: string;

  @ApiProperty({
    description: 'The biological sex of the user',
    required: false,
  })
  @IsString()
  @IsOptional()
  @MaxLength(30)
  sex?: string;

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
    description: 'The contact mobile phone number of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/\S/, { message: 'Phone number is required.' })
  @Matches(/^09\d{9}$/, {
    message:
      'Phone number must be an 11-digit Philippine mobile number starting with 09 (e.g., 0917 123 4567).',
  })
  phone_number?: string;

  @ApiProperty({
    description: 'The permanent/home address of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/\S/, { message: 'Permanent residence address is required.' })
  student_address?: string;

  @ApiProperty({
    description: 'The campus address of the school/university',
    required: false,
  })
  @IsString()
  @IsOptional()
  school_address?: string;

  @ApiProperty({
    description: 'The student number of the Scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/^\d{5,12}$/, {
    message:
      'Student number must be between 5 and 12 numerical digits (exclude dashes or special characters).',
  })
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
  @Matches(/\S/, { message: 'Title is required.' })
  title?: string;

  @ApiProperty({
    description: 'The department of the Staff member',
    required: false,
  })
  @IsString()
  @IsOptional()
  @Matches(/\S/, { message: 'Department is required.' })
  department?: string;
}
