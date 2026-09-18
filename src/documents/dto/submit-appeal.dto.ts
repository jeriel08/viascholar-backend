import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

export class SubmitAppealDto {
  @ApiProperty({
    description: 'Detailed explanation and justification for the academic second chance appeal',
    example: 'I faced unexpected medical circumstances during midterms. I have enrolled in academic tutoring to recover my standing.',
  })
  @IsString()
  @IsNotEmpty()
  appeal_notes: string;

  @ApiPropertyOptional({
    description: 'Optional supporting document ID (e.g. medical cert, letter from department head)',
    example: 42,
  })
  @IsNumber()
  @IsOptional()
  appeal_document_id?: number;
}
