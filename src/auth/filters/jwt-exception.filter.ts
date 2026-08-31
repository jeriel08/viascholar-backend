// src/auth/filters/jwt-exception.filter.ts
import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  UnauthorizedException,
} from '@nestjs/common';
import { Response } from 'express';

@Catch(UnauthorizedException)
export class JwtExceptionFilter implements ExceptionFilter {
  catch(exception: UnauthorizedException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Passport nests the original JWT error under exception.cause
    const cause = (exception as any).cause;
    const errorName = cause?.name as string | undefined;

    if (errorName === 'TokenExpiredError') {
      return response.status(401).json({
        statusCode: 401,
        errorCode: 'TOKEN_EXPIRED',
        message: 'Your session has expired. Please log in again.',
      });
    }

    if (errorName === 'JsonWebTokenError') {
      return response.status(401).json({
        statusCode: 401,
        errorCode: 'TOKEN_INVALID',
        message: 'Invalid authentication token.',
      });
    }

    // Default UnauthorizedException response
    const status = exception.getStatus();
    const exceptionResponse = exception.getResponse();

    return response.status(status).json(
      typeof exceptionResponse === 'string'
        ? { statusCode: status, message: exceptionResponse }
        : exceptionResponse,
    );
  }
}

