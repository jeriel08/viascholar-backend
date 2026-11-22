import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DeadlinesService } from './deadlines.service.js';
import { getManilaDateParts } from './utils/deadline-compliance.util.js';

@Injectable()
export class DeadlinesReminderScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DeadlinesReminderScheduler.name);
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private lastRunDateKey: string | null = null;
  private isRunning = false;

  private readonly isEnabled: boolean;
  private readonly targetHourPht: number;

  constructor(private readonly deadlinesService: DeadlinesService) {
    this.isEnabled =
      process.env.DEADLINE_CRON_ENABLED !== 'false' &&
      process.env.NODE_ENV !== 'test';
    const rawHour = Number.parseInt(
      process.env.DEADLINE_REMINDER_HOUR_PHT || '8',
      10,
    );
    this.targetHourPht = Number.isFinite(rawHour)
      ? Math.min(23, Math.max(0, rawHour))
      : 8;
  }

  onModuleInit() {
    if (!this.isEnabled) {
      return;
    }

    this.startupTimer = setTimeout(() => {
      void this.tick();
    }, 30_000);
    this.startupTimer.unref?.();

    this.intervalTimer = setInterval(
      () => {
        void this.tick();
      },
      30 * 60 * 1000,
    );
    this.intervalTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  async tick(now = new Date()): Promise<boolean> {
    const { hour, dateKey } = getManilaDateParts(now);
    if (
      hour < this.targetHourPht ||
      this.lastRunDateKey === dateKey ||
      this.isRunning
    ) {
      return false;
    }

    this.isRunning = true;
    try {
      const summary = await this.deadlinesService.processScheduledReminders(now);
      this.lastRunDateKey = dateKey;
      this.logger.log(
        `Daily deadline reminder sweep (${dateKey}): evaluated=${summary.evaluated_deadlines}, sent=${summary.sent_count}, dedup_skipped=${summary.skipped_dedup_count}`,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Daily deadline reminder sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.isRunning = false;
    }
  }
}
