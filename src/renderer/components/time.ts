// When something happened, as the transcript's timestamp rows say it.
export const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const yearDayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "Today 3:42 PM", "Yesterday 3:42 PM", then the date ("Oct 21 3:42 PM", with the year when it isn't this one). */
export function timestampLabel(ms: number, now = Date.now()): string {
  const time = timeFormat.format(ms);
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  return `${(new Date(ms).getFullYear() === new Date(now).getFullYear() ? dayFormat : yearDayFormat).format(ms)} ${time}`;
}
