import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

@Injectable()
export class AppCacheService {
  private readonly logger = new Logger(AppCacheService.name);
  private readonly keys = new Set<string>();

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  /**
   * Retrieve a value from the cache by key.
   */
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const val = (await this.cache.get(key)) as T | undefined;
      if (val === undefined) {
        this.keys.delete(key);
      }
      return val;
    } catch (err) {
      this.logger.warn(
        `Cache get error for key "${key}": ${(err as Error).message}`,
      );
      return undefined;
    }
  }

  /**
   * Set a value in the cache with an optional TTL in milliseconds.
   */
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      if (ttlMs !== undefined) {
        await this.cache.set(key, value, ttlMs);
      } else {
        await this.cache.set(key, value);
      }
      this.keys.add(key);
    } catch (err) {
      this.logger.warn(
        `Cache set error for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Delete a specific key from the cache.
   */
  async del(key: string): Promise<void> {
    try {
      await this.cache.del(key);
      this.keys.delete(key);
    } catch (err) {
      this.logger.warn(
        `Cache del error for key "${key}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Delete all keys starting with the specified prefix (e.g. "dashboard:", "dashboard:coordinator:").
   */
  async delPattern(prefix: string): Promise<void> {
    try {
      const matchingKeys = Array.from(this.keys).filter((k) =>
        k.startsWith(prefix),
      );
      await Promise.all(matchingKeys.map((k) => this.del(k)));
      this.logger.debug(
        `Invalidated ${matchingKeys.length} cache keys with prefix "${prefix}"`,
      );
    } catch (err) {
      this.logger.warn(
        `Cache delPattern error for prefix "${prefix}": ${(err as Error).message}`,
      );
    }
  }

  /**
   * Wrap an async computation with cache check and populate.
   * If `forceRefresh` is true, bypasses read from cache and overwrites with fresh data.
   */
  async wrap<T>(
    key: string,
    factory: () => Promise<T>,
    ttlMs?: number,
    forceRefresh = false,
  ): Promise<T> {
    if (!forceRefresh) {
      const cached = await this.get<T>(key);
      if (cached !== undefined && cached !== null) {
        return cached;
      }
    }
    const fresh = await factory();
    if (fresh !== undefined && fresh !== null) {
      await this.set(key, fresh, ttlMs);
    }
    return fresh;
  }

  /**
   * Clear all cached keys.
   */
  async reset(): Promise<void> {
    try {
      await this.cache.clear();
      this.keys.clear();
      this.logger.debug('AppCache completely cleared');
    } catch (err) {
      this.logger.warn(`Cache reset error: ${(err as Error).message}`);
    }
  }
}
