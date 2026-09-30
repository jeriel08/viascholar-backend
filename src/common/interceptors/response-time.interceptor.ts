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
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const start = performance.now();

    return new Observable((observer) => {
      requestCacheStorage.run({ req, res, cacheStatus: 'BYPASS' }, () => {
        next
          .handle()
          .pipe(
            tap({
              next: () => {
                if (!res.headersSent) {
                  const elapsed = (performance.now() - start).toFixed(2);
                  res.setHeader('X-Response-Time', `${elapsed}ms`);
                  if (!res.getHeader('X-Cache')) {
                    res.setHeader('X-Cache', 'BYPASS');
                  }
                }
              },
              error: () => {
                if (!res.headersSent) {
                  const elapsed = (performance.now() - start).toFixed(2);
                  res.setHeader('X-Response-Time', `${elapsed}ms`);
                }
              },
            }),
          )
          .subscribe(observer);
      });
    });
  }
}
