import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Test, TestingModule } from '@nestjs/testing';
import { MeetingsController } from './meetings.controller.js';
import { MeetingsService } from './meetings.service.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { Role } from '../generated/prisma/enums.js';
import type { QueryMeetingsDto } from './dto/query-meetings.dto.js';

const makeRequest = (userId = 7, role: Role = Role.SCHOLAR) => ({
  user: { user_id: userId, email: 'scholar@example.com', role },
});

describe('MeetingsController', () => {
  let controller: MeetingsController;
  let serviceMock: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(async () => {
    serviceMock = {
      findAll: vi.fn(),
      findOne: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MeetingsController],
      providers: [
        {
          provide: MeetingsService,
          useValue: serviceMock,
        },
      ],
    }).compile();

    controller = module.get<MeetingsController>(MeetingsController);
  });

  it('is created by the Nest testing module', () => {
    expect(controller).toBeDefined();
  });

  it('delegates findAll with the query and authenticated user', async () => {
    const req = makeRequest();
    const query = { status: 'SCHEDULED' } as QueryMeetingsDto;
    serviceMock.findAll.mockResolvedValue({ data: [], total: 0 });

    const result = await controller.findAll(req, query);

    expect(serviceMock.findAll).toHaveBeenCalledWith(query, req.user);
    expect(result).toEqual({ data: [], total: 0 });
  });

  it('delegates findOne with the id and authenticated user', async () => {
    const req = makeRequest(2, Role.COORDINATOR);
    serviceMock.findOne.mockResolvedValue({ meeting_id: 12 });

    const result = await controller.findOne(req, 12);

    expect(serviceMock.findOne).toHaveBeenCalledWith(12, req.user);
    expect(result).toEqual({ meeting_id: 12 });
  });

  describe('authorization metadata', () => {
    const handlerFor = (name: string) => {
      const prototype = MeetingsController.prototype as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >;
      return prototype[name];
    };
    const rolesFor = (handler: (...args: any[]) => unknown) =>
      Reflect.getMetadata(ROLES_KEY, handler) as Role[] | undefined;

    it('permits findAll and findOne for all authenticated roles', () => {
      for (const name of ['findAll', 'findOne']) {
        expect(rolesFor(handlerFor(name))).toEqual([
          Role.ADMIN,
          Role.GRANTOR,
          Role.COORDINATOR,
          Role.SCHOLAR,
          Role.APPLICANT,
        ]);
      }
    });
  });
});
