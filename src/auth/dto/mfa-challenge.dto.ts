import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import {
  VALID_TWO_FACTOR_METHODS,
  type TwoFactorMethod,
} from '../user-settings.util.js';

export class SendMfaChallengeDto {
  @ApiProperty({ description: 'Signed MFA challenge token' })
  @IsString()
  @IsNotEmpty({ message: 'MFA session token is required.' })
  mfa_token: string;

  @ApiProperty({
    description: 'Delivery channel for verification code',
    enum: ['EMAIL_OTP', 'SMS_OTP'],
  })
  @IsIn(['EMAIL_OTP', 'SMS_OTP'])
  method: 'EMAIL_OTP' | 'SMS_OTP';
}

export class VerifyMfaChallengeDto {
  @ApiProperty({ description: 'Signed MFA challenge token' })
  @IsString()
  @IsNotEmpty({ message: 'MFA session token is required.' })
  mfa_token: string;

  @ApiProperty({ description: '6-digit verification code', example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, {
    message: 'Verification code must be a 6-digit number.',
  })
  code: string;

  @ApiPropertyOptional({
    description: 'MFA method being verified',
    enum: VALID_TWO_FACTOR_METHODS,
  })
  @IsIn(VALID_TWO_FACTOR_METHODS)
  @IsOptional()
  method?: TwoFactorMethod;

  @ApiPropertyOptional({
    description: 'Whether to trust this device for 30 days',
  })
  @IsBoolean()
  @IsOptional()
  remember_device?: boolean;
}
