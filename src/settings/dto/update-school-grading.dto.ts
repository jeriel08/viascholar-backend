import { PartialType } from '@nestjs/swagger';
import { CreateSchoolGradingDto } from './create-school-grading.dto.js';

export class UpdateSchoolGradingDto extends PartialType(
  CreateSchoolGradingDto,
) {}
