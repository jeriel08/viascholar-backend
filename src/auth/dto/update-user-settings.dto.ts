import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import {
  VALID_TWO_FACTOR_METHODS,
  type TwoFactorMethod,
} from '../user-settings.util.js';

export class UpdateUserSettingsDto {
  @ApiPropertyOptional({
    description:
      'Receive email notifications for application and disbursement updates',
  })
  @IsBoolean()
  @IsOptional()
  emailNotifs?: boolean;

  @ApiPropertyOptional({
    description: 'Receive SMS alerts for time-sensitive reminders',
  })
  @IsBoolean()
  @IsOptional()
  smsNotifs?: boolean;

  @ApiPropertyOptional({
    description: 'Receive forum activity and digest notifications',
  })
  @IsBoolean()
  @IsOptional()
  forumDigest?: boolean;

  @ApiPropertyOptional({
    description: 'Enable two-factor authentication',
  })
  @IsBoolean()
  @IsOptional()
  twoFactor?: boolean;

  @ApiPropertyOptional({
    description: 'Preferred two-factor authentication method',
    enum: VALID_TWO_FACTOR_METHODS,
  })
  @IsIn(VALID_TWO_FACTOR_METHODS)
  @IsOptional()
  twoFactorMethod?: TwoFactorMethod;

  @ApiPropertyOptional({
    description: 'Allow other scholars to view forum activity and bio',
  })
  @IsBoolean()
  @IsOptional()
  publicProfile?: boolean;
}
