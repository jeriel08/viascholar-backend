import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class UpdatePostDto {
  @ApiPropertyOptional({
    example: 'How do I submit my Form 138 if grades are on separate sheets?',
    description: 'Updated title of the forum discussion',
  })
  @IsString()
  @IsOptional()
  @MinLength(3)
  title?: string;

  @ApiPropertyOptional({
    example:
      'Updated details about combining high school grade cards into one PDF before uploading.',
    description: 'Updated body content of the forum discussion',
  })
  @IsString()
  @IsOptional()
  @MinLength(5)
  content?: string;

  @ApiPropertyOptional({
    example: 'ACADEMIC',
    description:
      'Category tag (e.g. ACADEMIC, STIPENDS, GENERAL, ANNOUNCEMENT)',
  })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiPropertyOptional({
    example: [2, 5],
    description: 'User IDs of Coordinators and Grantors tagged in the post',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  tagged_user_ids?: number[];
}
