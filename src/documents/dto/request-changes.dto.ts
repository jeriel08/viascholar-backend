// src/documents/dto/request-changes.dto.ts
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RequestChangesDto {
  @ApiProperty({
    example: 'Grades for 2nd semester are unreadable. Please re-upload.',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}
