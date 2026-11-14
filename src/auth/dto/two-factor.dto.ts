import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches } from 'class-validator';
import {
  VALID_TWO_FACTOR_METHODS,
  type TwoFactorMethod,
} from '../user-settings.util.js';

export class SetupTwoFactorDto {
  @ApiProperty({
    description: 'Two-factor authentication method to configure',
    enum: VALID_TWO_FACTOR_METHODS,
  })
  @IsIn(VALID_TWO_FACTOR_METHODS)
  method: TwoFactorMethod;
}

export class VerifyTwoFactorDto {
  @ApiProperty({
    description: 'Two-factor authentication method being verified',
    enum: VALID_TWO_FACTOR_METHODS,
  })
  @IsIn(VALID_TWO_FACTOR_METHODS)
  method: TwoFactorMethod;

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
