import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeadlinesReminderScheduler } from './deadlines-reminder.scheduler.js';
import type { DeadlinesService } from './deadlines.service.js';

describe('DeadlinesReminderScheduler', () => {
  let deadlinesService: {
    processScheduledReminders: ReturnType<typeof vi.fn>;
  };
  let scheduler: DeadlinesReminderScheduler;

  beforeEach(() => {
    delete process.env.DEADLINE_REMINDER_HOUR_PHT;
    deadlinesService = {
      processScheduledReminders: vi.fn().mockResolvedValue({
        ran_at: new Date().toISOString(),
        evaluated_deadlines: 1,
        sent_count: 2,
        skipped_dedup_count: 0,
        breakdown: {
          BEFORE_3D: 1,
          DUE_TODAY: 1,
          AFTER_GRACE_1D: 0,
          STALLED_REVISION: 0,
        },
      }),
    };
    scheduler = new DeadlinesReminderScheduler(
      deadlinesService as unknown as DeadlinesService,
    );
  });

  it('skips before the configured Asia/Manila hour, runs once at/after target hour, and runs again the next day', async () => {
    // 07:30 AM PHT (23:30 UTC previous day) -> before 08:00 PHT
    const earlyMorning = new Date('2026-10-09T23:30:00.000Z');
    expect(await scheduler.tick(earlyMorning)).toBe(false);
    expect(deadlinesService.processScheduledReminders).not.toHaveBeenCalled();

    // 08:05 AM PHT on 2026-10-10 -> runs!
    const morningRun = new Date('2026-10-10T00:05:00.000Z');
    expect(await scheduler.tick(morningRun)).toBe(true);
    expect(deadlinesService.processScheduledReminders).toHaveBeenCalledTimes(1);
    expect(deadlinesService.processScheduledReminders).toHaveBeenCalledWith(
      morningRun,
    );

    // 14:00 PM PHT on same day (2026-10-10) -> deduplicated
    const afternoonTick = new Date('2026-10-10T06:00:00.000Z');
    expect(await scheduler.tick(afternoonTick)).toBe(false);
    expect(deadlinesService.processScheduledReminders).toHaveBeenCalledTimes(1);

    // 08:00 AM PHT on next day (2026-10-11) -> runs again
    const nextDay = new Date('2026-10-11T00:00:00.000Z');
    expect(await scheduler.tick(nextDay)).toBe(true);
    expect(deadlinesService.processScheduledReminders).toHaveBeenCalledTimes(2);
  });

  it('allows retry on the same day when the sweep throws an error', async () => {
    deadlinesService.processScheduledReminders.mockRejectedValueOnce(
      new Error('DB transient error'),
    );

    const morningRun = new Date('2026-10-10T00:05:00.000Z');
    expect(await scheduler.tick(morningRun)).toBe(false);

    const retryRun = new Date('2026-10-10T00:35:00.000Z');
    expect(await scheduler.tick(retryRun)).toBe(true);
    expect(deadlinesService.processScheduledReminders).toHaveBeenCalledTimes(2);
  });
});
