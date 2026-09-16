import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleLoginDto {
  @ApiProperty({ description: 'Google ID token or Credential string' })
  @IsString()
  @IsNotEmpty({ message: 'Google credential is required.' })
  credential: string;
}
