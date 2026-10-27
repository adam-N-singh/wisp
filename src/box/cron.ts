// Five-field cron (minute hour day-of-month month day-of-week) in local time,
// with lists, ranges, steps, month/day names and @hourly/@daily/@weekly/@monthly.
// Day-of-month and day-of-week combine with OR when both are restricted, as in
// Vixie cron.

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const MACROS: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *" };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(text: string, min: number, max: number, names: string[] | null, nameBase: number): Set<number> {
  const out = new Set<number>();
  const value = (token: string) => {
    const lower = token.toLowerCase();
    if (names != null) {
      const index = names.indexOf(lower);
      if (index >= 0) return index + nameBase;
    }
    const number = Number(token);
    if (!Number.isInteger(number)) throw new Error(`invalid cron value "${token}"`);
    return number;
  };
  for (const part of text.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText == null ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step "${part}"`);
    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      start = value(a);
      end = value(b);
    } else {
      start = value(range);
      end = stepText == null ? start : max;
    }
    if (start < min || end > max || start > end) throw new Error(`cron value out of range "${part}"`);
    for (let n = start; n <= end; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expression: string): CronFields {
  const normalized = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) throw new Error("cron needs 5 fields: minute hour day-of-month month day-of-week");
  const weekdays = parseField(parts[4], 0, 7, WEEKDAYS, 0);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes: parseField(parts[0], 0, 59, null, 0),
    hours: parseField(parts[1], 0, 23, null, 0),
    days: parseField(parts[2], 1, 31, null, 0),
    months: parseField(parts[3], 1, 12, MONTHS, 1),
    weekdays,
    daysRestricted: parts[2] !== "*",
    weekdaysRestricted: parts[4] !== "*",
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/** First matching minute strictly after `from` (ms epoch), searching up to ~5 years. */
export function nextCronRun(expression: string, from: number): number | null {
  const fields = parseCron(expression);
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = from + 5 * 366 * 24 * 3600 * 1000;
  while (date.getTime() <= limit) {
    if (!fields.months.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    const dayOk = fields.daysRestricted && fields.weekdaysRestricted
      ? fields.days.has(date.getDate()) || fields.weekdays.has(date.getDay())
      : fields.days.has(date.getDate()) && fields.weekdays.has(date.getDay());
    if (!dayOk) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!fields.hours.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!fields.minutes.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date.getTime();
  }
  return null;
}

/** Short English description, e.g. "Every day at 09:00" or "Every 15 minutes". */
export function describeCron(expression: string): string {
  const normalized = MACROS[expression.trim().toLowerCase()] ?? expression.trim();
  const [minute, hour, dom, month, dow] = normalized.split(/\s+/);
  const pad = (n: string) => n.padStart(2, "0");
  if (/^\*\/\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every ${minute.slice(2)} minutes`;
  if (/^\d+$/.test(minute) && hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every hour at :${pad(minute)}`;
  if (/^\d+$/.test(minute) && /^\*\/\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") return `Every ${hour.slice(2)} hours at :${pad(minute)}`;
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const time = `${pad(hour)}:${pad(minute)}`;
    if (dom === "*" && month === "*" && dow === "*") return `Every day at ${time}`;
    if (dom === "*" && month === "*" && dow === "1-5") return `Weekdays at ${time}`;
    if (dom === "*" && month === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
      const names = dow.split(",").map((d) => ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"][Number(d)]);
      return `${names.join(", ")} at ${time}`;
    }
    if (/^\d+$/.test(dom) && month === "*" && dow === "*") return `Monthly on day ${dom} at ${time}`;
  }
  return `Cron ${normalized}`;
}
