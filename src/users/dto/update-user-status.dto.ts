import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateUserStatusDto {
  @ApiProperty({
    example: false,
    description: 'Set account to active (true) or disabled (false)',
  })
  @IsBoolean()
  @IsNotEmpty()
  is_active: boolean;
}
