import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Role } from '../../generated/prisma/enums.js';
import { ApiProperty } from '@nestjs/swagger';

export class CreateStaffDto {
  @ApiProperty({ description: 'The email address of the staff' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({ description: 'The password for the staff account' })
  @IsString()
  @MinLength(8)
  password: string;

  @ApiProperty({ description: 'The role of the staff' })
  @IsEnum(Role)
  @IsNotEmpty()
  role: Role; // ADMIN or EMPLOYEE

  @ApiProperty({ description: 'The first name of the staff' })
  @IsString()
  @IsNotEmpty()
  first_name: string;

  @ApiProperty({ description: 'The last name of the staff' })
  @IsString()
  @IsNotEmpty()
  last_name: string;

  @ApiProperty({ description: 'The title of the staff', required: false })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({ description: 'The department of the staff', required: false })
  @IsString()
  @IsOptional()
  department?: string;
}
