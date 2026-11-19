// India-time helpers. The bot posts once per slot (10:00 and 19:00 IST) and deletes at most 3 videos per day,
// so a run that is retried or started twice does nothing the second time.
const IST_OFFSET_MS = 330 * 60_000;
const HOUR_MS = 3_600_000;

function istMidnightMs(now: Date): number {
  const local = new Date(now.getTime() + IST_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

function istHour(now: Date): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** Start of the current posting slot: 19:00 IST (evening), 10:00 IST (morning), or yesterday's 19:00 IST before 10:00. */
export function currentPostSlotStart(now: Date): Date {
  const midnight = istMidnightMs(now);
  const hour = istHour(now);
  const offsetHours = hour >= 19 ? 19 : hour >= 10 ? 10 : -5;
  return new Date(midnight + offsetHours * HOUR_MS - IST_OFFSET_MS);
}

/** Midnight at the start of today in India. */
export function istDayStart(now: Date): Date {
  return new Date(istMidnightMs(now) - IST_OFFSET_MS);
}
