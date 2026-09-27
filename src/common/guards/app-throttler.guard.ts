import { ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Only apply rate limiting to HTTP requests.
    // WebSockets and RPC contexts do not have HTTP response headers (res.header),
    // which would cause ThrottlerGuard.setResponseHeader to throw a TypeError.
    if (context.getType() !== 'http') {
      return true;
    }
    return super.canActivate(context);
  }

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    return super.shouldSkip(context);
  }
}
