import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class RegisterScholarDto {
  @ApiProperty({ description: 'The email address of the scholar' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'The password for the scholar account' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ description: 'The first name of the scholar' })
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ description: 'The last name of the scholar' })
  @IsString()
  @IsNotEmpty()
  last_name: string;

  @ApiProperty({
    description: 'The student number of the scholar',
    required: false,
  })
  @IsString()
  @IsOptional()
  student_number?: string;
}
