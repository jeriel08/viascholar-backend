import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';

export class SendContactVerificationDto {
  @ApiProperty({
    description: 'Contact channel to verify',
    enum: ['EMAIL', 'PHONE'],
  })
  @IsIn(['EMAIL', 'PHONE'])
  channel: 'EMAIL' | 'PHONE';
}

export class VerifyContactVerificationDto {
  @ApiProperty({
    description: 'Contact channel being verified',
    enum: ['EMAIL', 'PHONE'],
  })
  @IsIn(['EMAIL', 'PHONE'])
  channel: 'EMAIL' | 'PHONE';

  @ApiProperty({
    description: '6-digit verification code',
    example: '123456',
  })
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'Verification code must be a 6-digit number.',
  })
  code: string;
}
