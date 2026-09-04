import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SignContractDto {
  @ApiPropertyOptional({
    example: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...',
    description:
      'Base64-encoded signature image (PNG data URL) from frontend canvas pad',
  })
  @IsString()
  @IsOptional()
  signature_base64?: string;
}
