import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  Matches,
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
  @Matches(/^[a-zA-ZÀ-ÿñÑ\s]+$/, {
    message: 'First name cannot contain numbers or special characters.',
  })
  first_name: string;

  @ApiProperty({ description: 'The last name of the scholar' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-zA-ZÀ-ÿñÑ\s]+$/, {
    message: 'Last name cannot contain numbers or special characters.',
  })
  last_name: string;

  @ApiProperty({
    description: 'The contact mobile phone number of the scholar',
    example: '09171234567',
  })
  @IsString()
  @IsNotEmpty()
  phone_number: string;
}
