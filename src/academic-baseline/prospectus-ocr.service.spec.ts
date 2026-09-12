import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { ProspectusOcrService } from './prospectus-ocr.service';
import { OpenRouterVisionExtractorService } from '../documents/extractors/openrouter-vision-extractor.service';

describe('ProspectusOcrService', () => {
  let service: ProspectusOcrService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProspectusOcrService,
        {
          provide: OpenRouterVisionExtractorService,
          useValue: {
            extractProspectusData: jest.fn(),
            extractData: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ProspectusOcrService>(ProspectusOcrService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should normalize subject codes for robust fuzzy matching', () => {
    expect(service.normalizeSubjectCode('IT 101')).toBe('IT101');
    expect(service.normalizeSubjectCode('cce - 102')).toBe('CCE102');
    expect(service.normalizeSubjectCode('IT 1a')).toBe('IT1A');
    expect(service.normalizeSubjectCode('PAHF I')).toBe('PAHF1');
    expect(service.normalizeSubjectCode('NSTP II')).toBe('NSTP2');
  });

  it('should normalize semester strings accurately', () => {
    expect(service.normalizeSemester('1st Sem')).toBe('1st Semester');
    expect(service.normalizeSemester('Second Semester')).toBe('2nd Semester');
    expect(service.normalizeSemester('Summer Term 2024')).toBe('Summer');
    expect(service.normalizeSemester('Midyear')).toBe('Summer');
  });

  it('should normalize year level values correctly', () => {
    expect(service.normalizeYearLevel(1)).toBe(1);
    expect(service.normalizeYearLevel('1st Year')).toBe(1);
    expect(service.normalizeYearLevel('Second Year')).toBe(2);
    expect(service.normalizeYearLevel('3rd')).toBe(3);
    expect(service.normalizeYearLevel('4th Year')).toBe(4);
  });
});
