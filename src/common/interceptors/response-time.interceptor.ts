import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { requestCacheStorage } from '../cache/cache-context.js';

@Injectable()
export class ResponseTimeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { __perfStart?: number }>();
    const res = http.getResponse<Response>();

    const handlerStart = performance.now();
    const reqStart = req?.__perfStart;

    const writeTimingHeaders = () => {
      if (!res || res.headersSent) return;
      const now = performance.now();
      const handlerMs = now - handlerStart;
      const guardMs =
        typeof reqStart === 'number'
          ? Math.max(0, handlerStart - reqStart)
          : null;
      const totalMs =
        typeof reqStart === 'number' ? now - reqStart : handlerMs;

      res.setHeader('X-Response-Time', `${totalMs.toFixed(2)}ms`);
      res.setHeader('X-Handler-Time', `${handlerMs.toFixed(2)}ms`);
      if (guardMs !== null) {
        res.setHeader('X-Auth-Guard-Time', `${guardMs.toFixed(2)}ms`);
      }
      if (!res.getHeader('X-Cache')) {
        res.setHeader('X-Cache', 'BYPASS');
      }
    };

    return new Observable((observer) => {
      requestCacheStorage.run({ req, res, cacheStatus: 'BYPASS' }, () => {
        next
          .handle()
          .pipe(
            tap({
              next: () => {
                writeTimingHeaders();
              },
              error: () => {
                writeTimingHeaders();
              },
            }),
          )
          .subscribe(observer);
      });
    });
  }
}
