import type { WorkDays } from "../../server/db/schema/types.ts";

const damascusFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Damascus", year: "numeric", month: "2-digit", day: "2-digit",
  weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function damascusTime(now: Date) {
  const parts = Object.fromEntries(damascusFormat.formatToParts(now).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday.toLowerCase() as keyof WorkDays,
    seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
  };
}

function seconds(value: unknown) {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 3600 + minute * 60;
}

/** SRS §5.9.3: one same-day interval, inclusive endpoints, Damascus closure date. */
export function openWindow(provider: {
  workDays: WorkDays; todayClosed: boolean; todayClosedDate: string | null;
}, now: Date): { start: string; end: string } | null {
  const time = damascusTime(now);
  if (provider.todayClosed && provider.todayClosedDate === time.date) return null;
  const day = provider.workDays?.[time.weekday];
  if (!day || day.enabled !== true) return null;
  const start = seconds(day.start), end = seconds(day.end);
  if (start === null || end === null || start >= end) return null;
  return time.seconds >= start && time.seconds <= end ? { start: day.start, end: day.end } : null;
}