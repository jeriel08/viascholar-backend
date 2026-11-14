import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GoogleLoginDto {
  @ApiProperty({ description: 'Google ID token or Credential string' })
  @IsString()
  @IsNotEmpty({ message: 'Google credential is required.' })
  credential: string;

  @ApiPropertyOptional({
    description:
      'Optional trusted device token to skip MFA on remembered devices',
  })
  @IsString()
  @IsOptional()
  trusted_device_token?: string;
}
