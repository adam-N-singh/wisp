import assert from "node:assert/strict";
import { test } from "node:test";
import { base32Decode, base32Encode } from "../../src/shared/base32";
import { describeCron, isValidCron, nextCronRun } from "../../src/box/cron";

test("base32 matches RFC 4648, lowercase and unpadded", () => {
  assert.equal(base32Encode("foobar"), "mzxw6ytboi");
  assert.equal(base32Decode("mzxw6ytboi"), "foobar");
});

test("base32 round-trips unicode and rejects foreign characters", () => {
  for (const text of ["", "a", "account.github|user.roster", "émoji ✓ 漢字"]) assert.equal(base32Decode(base32Encode(text)), text);
  assert.equal(base32Decode("ABC!"), null);
});

test("cron validation", () => {
  assert.ok(isValidCron("0 9 * * 1-5"));
  assert.ok(isValidCron("*/15 * * * *"));
  assert.ok(isValidCron("@daily"));
  assert.ok(isValidCron("0 0 1 jan,jul *"));
  assert.ok(!isValidCron("61 * * * *"));
  assert.ok(!isValidCron("* * *"));
  assert.ok(!isValidCron("0 9 * * mon-funday"));
});

test("next run for weekday mornings skips the weekend", () => {
  const saturdayNoon = new Date(2026, 9, 24, 12, 0, 0).getTime(); // Sat 24 Oct 2026
  const next = new Date(nextCronRun("0 9 * * 1-5", saturdayNoon)!);
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
});

test("next run for intervals and day-of-month OR day-of-week", () => {
  const from = new Date(2026, 9, 22, 10, 7, 30).getTime();
  assert.equal(new Date(nextCronRun("*/15 * * * *", from)!).getMinutes(), 15);
  // "1st of the month OR Fridays": from Thu 22 Oct the next match is Fri 23 Oct.
  const next = new Date(nextCronRun("0 8 1 * 5", from)!);
  assert.equal(next.getDate(), 23);
});

test("cron descriptions", () => {
  assert.equal(describeCron("0 9 * * 1-5"), "Weekdays at 09:00");
  assert.equal(describeCron("0 8 * * *"), "Every day at 08:00");
  assert.equal(describeCron("*/15 * * * *"), "Every 15 minutes");
  assert.equal(describeCron("0 10 * * 1"), "Mondays at 10:00");
  assert.equal(describeCron("5 */2 * * *"), "Every 2 hours at :05");
});
