import {
  IsOptional,
  IsString,
  IsNumber,
  IsObject,
  IsArray,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AnalyticsQueryDto {
  @IsOptional()
  @IsString()
  groupBy?: 'school' | 'track' | 'course' | 'term';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  schoolId?: number;

  @IsOptional()
  @IsString()
  track?: string;

  @IsOptional()
  @IsString()
  course?: string;

  @IsOptional()
  @IsString()
  academicYear?: string;
}

export class ExplainChartDto {
  @IsString()
  chartType: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsObject()
  metrics: Record<string, any>;

  @IsOptional()
  @IsArray()
  dataPoints?: any[];
}
