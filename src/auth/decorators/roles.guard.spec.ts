import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { ROLES_KEY } from './roles.decorator.js';
import { Role } from '../../generated/prisma/enums.js';

const createReflectorMock = () => ({
  getAllAndOverride: vi.fn(),
});

const createContextMock = (request: unknown) => {
  const handler = vi.fn();
  const controllerClass = vi.fn();

  return {
    handler,
    controllerClass,
    context: {
      getHandler: () => handler,
      getClass: () => controllerClass,
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext,
  };
};

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: ReturnType<typeof createReflectorMock>;

  beforeEach(() => {
    reflector = createReflectorMock();
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows requests to endpoints without role metadata', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const { context, handler, controllerClass } = createContextMock({
      user: { role: Role.SCHOLAR },
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(ROLES_KEY, [
      handler,
      controllerClass,
    ]);
  });

  it('allows a user whose role is in the required list', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN, Role.COORDINATOR]);
    const { context } = createContextMock({
      user: { role: Role.COORDINATOR },
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a user whose role is not allowed', () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    const { context } = createContextMock({
      user: { role: Role.SCHOLAR },
    });

    expect(() => guard.canActivate(context)).toThrow(
      new ForbiddenException(
        'You do not have permission to access this resource.',
      ),
    );
  });
});
