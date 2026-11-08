import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { JwtExceptionFilter } from './jwt-exception.filter.js';

const createResponseMock = () => {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });

  return { status, json };
};

const createHostMock = (response: ReturnType<typeof createResponseMock>) =>
  ({
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  }) as unknown as ArgumentsHost;

const withCause = (name: string) => {
  const exception = new UnauthorizedException('Unauthorized');
  (exception as unknown as { cause?: { name: string } }).cause = { name };
  return exception;
};

describe('JwtExceptionFilter', () => {
  let filter: JwtExceptionFilter;

  beforeEach(() => {
    filter = new JwtExceptionFilter();
  });

  it('maps TokenExpiredError to a TOKEN_EXPIRED response', () => {
    const response = createResponseMock();

    filter.catch(withCause('TokenExpiredError'), createHostMock(response));

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 401,
      errorCode: 'TOKEN_EXPIRED',
      message: 'Your session has expired. Please log in again.',
    });
  });

  it('maps JsonWebTokenError to a TOKEN_INVALID response', () => {
    const response = createResponseMock();

    filter.catch(withCause('JsonWebTokenError'), createHostMock(response));

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 401,
      errorCode: 'TOKEN_INVALID',
      message: 'Invalid authentication token.',
    });
  });

  it('falls back to the default UnauthorizedException payload', () => {
    const response = createResponseMock();

    filter.catch(
      new UnauthorizedException('Authentication required.'),
      createHostMock(response),
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 401,
        message: 'Authentication required.',
      }),
    );
  });

  it('wraps a string exception response in a statusCode object', () => {
    const response = createResponseMock();
    const exception = {
      getStatus: () => 401,
      getResponse: () => 'Custom unauthorized message',
    } as unknown as UnauthorizedException;

    filter.catch(exception, createHostMock(response));

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 401,
      message: 'Custom unauthorized message',
    });
  });
});
