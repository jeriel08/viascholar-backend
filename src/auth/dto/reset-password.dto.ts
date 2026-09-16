import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Secure signed password reset token' })
  @IsString()
  @IsNotEmpty({ message: 'Reset token is required.' })
  token: string;

  @ApiProperty({ example: 'NewSecurePassword123!' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long.' })
  @IsNotEmpty({ message: 'New password is required.' })
  new_password: string;
}
