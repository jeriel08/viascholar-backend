import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RequestContractChangesDto {
  @ApiProperty({
    example:
      'My registered degree program is BS Computer Science, but the agreement indicates BS Information Technology. Please update it.',
    description:
      'Detailed explanation of the discrepancies or corrections needed in the contract draft',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10, {
    message: 'Reason must be at least 10 characters describing the changes needed.',
  })
  reason: string;
}
