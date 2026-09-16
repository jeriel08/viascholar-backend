import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class ForgotPasswordDto {
  @ApiProperty({ example: 'student@example.com' })
  @IsEmail({}, { message: 'Please provide a valid email address.' })
  @IsNotEmpty({ message: 'Email address is required.' })
  email: string;
}
