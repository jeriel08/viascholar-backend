import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Test, TestingModule } from '@nestjs/testing';
import { AcademicBaselineService } from './academic-baseline.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CloudinaryService } from '../cloudinary/cloudinary.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { EventsGateway } from '../events/events.gateway.js';
import { ProspectusOcrService } from './prospectus-ocr.service.js';

describe('AcademicBaselineService', () => {
  let service: AcademicBaselineService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      scholarProfile: {
        findUnique: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      scholarProspectus: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      prospectusSubject: {
        findMany: jest.fn(),
        create: jest.fn(),
        createMany: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
      scholarDocument: {
        create: jest.fn(),
        update: jest.fn(),
      },
      schoolGradingSystem: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcademicBaselineService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: CloudinaryService, useValue: { uploadBuffer: jest.fn() } },
        { provide: SettingsService, useValue: { evaluateStudentGrade: jest.fn() } },
        { provide: EventsGateway, useValue: { emitToUser: jest.fn(), emitToStaff: jest.fn() } },
        { provide: ProspectusOcrService, useValue: { normalizeSubjectCode: jest.fn((c: string) => c.replace(/\s+/g, '').toUpperCase()) } },
      ],
    }).compile();

    service = module.get<AcademicBaselineService>(AcademicBaselineService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
