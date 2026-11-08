import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import { ExplainChartDto } from './dto/analytics.dto.js';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      getDescriptiveAnalytics: vi.fn(),
      explainChartWithAi: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AnalyticsController],
      providers: [
        {
          provide: AnalyticsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<AnalyticsController>(AnalyticsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates the analytics query to the service', async () => {
    const expected = { financialAspect: { totalScholarsCount: 3 } };
    serviceMock.getDescriptiveAnalytics.mockResolvedValue(expected);

    const query = { academicYear: '2025-2026' };
    const result = await controller.getDescriptiveAnalytics(query, 'true');

    expect(serviceMock.getDescriptiveAnalytics).toHaveBeenCalledWith(
      query,
      true,
    );
    expect(result).toBe(expected);
  });

  it('treats a missing or non-true refresh value as false', async () => {
    await controller.getDescriptiveAnalytics({}, undefined);
    await controller.getDescriptiveAnalytics({}, 'TRUE');

    expect(serviceMock.getDescriptiveAnalytics).toHaveBeenNthCalledWith(
      1,
      {},
      false,
    );
    expect(serviceMock.getDescriptiveAnalytics).toHaveBeenNthCalledWith(
      2,
      {},
      false,
    );
  });

  it('delegates chart explanations to the service', async () => {
    const dto = {
      chartType: 'ACADEMIC_STANDING',
      metrics: {},
    } as ExplainChartDto;
    const expected = { summary: 'S' };
    serviceMock.explainChartWithAi.mockResolvedValue(expected);

    const result: unknown = await controller.explainChart(dto);

    expect(serviceMock.explainChartWithAi).toHaveBeenCalledWith(dto);
    expect(result).toBe(expected);
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = AnalyticsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('restricts analytics endpoints to staff roles', () => {
      for (const name of ['getDescriptiveAnalytics', 'explainChart']) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.GRANTOR,
          Role.COORDINATOR,
          Role.ADMIN,
        ]);
      }
    });
  });
});
