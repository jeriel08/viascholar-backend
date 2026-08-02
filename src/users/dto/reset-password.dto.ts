import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    example: 'NewSecurePassword123!',
    description: 'New password for the target user',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  new_password: string;
}
