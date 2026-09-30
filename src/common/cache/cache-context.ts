import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response } from 'express';

export interface RequestCacheContext {
  req: Request;
  res: Response;
  cacheStatus?: 'HIT' | 'MISS' | 'BYPASS';
}

export const requestCacheStorage = new AsyncLocalStorage<RequestCacheContext>();
