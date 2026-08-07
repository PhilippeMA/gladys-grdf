// -----------------------------------------------------------------------------
// Date helpers around the "gas day".
//
// GRDF reports one reading per *journée gazière* (gas day), identified by a
// plain `YYYY-MM-DD` string. A gas day runs from 06:00 to 06:00 the next day,
// so it does not map exactly onto a calendar day.
//
// Gladys stores every state with an instant (`created_at`). We timestamp a gas
// day at 12:00 UTC: comfortably inside the calendar day it is named after, in
// every European timezone, so the daily consumption of the 5th shows up on the
// 5th of the chart and never slides to a neighbouring day.
// -----------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` of a Date, in UTC. */
export function formatDay(date) {
  return date.toISOString().slice(0, 10);
}

/** Parse a `YYYY-MM-DD` gas day, or return undefined when it is not one. */
export function parseDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return undefined;
  }
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `YYYY-MM-DD`, `count` days after `day` (a negative count goes back). */
export function addDays(day, count) {
  const date = parseDay(day);
  if (!date) {
    throw new TypeError(`Invalid day: ${day}`);
  }
  return formatDay(new Date(date.getTime() + count * MS_PER_DAY));
}

/** Instant at which the state of a gas day is recorded (12:00 UTC). */
export function gasDayTimestamp(day) {
  const date = parseDay(day);
  if (!date) {
    throw new TypeError(`Invalid gas day: ${day}`);
  }
  return new Date(date.getTime() + 12 * 60 * 60 * 1000);
}

/** Chronological comparison of two `YYYY-MM-DD` strings (they sort as text). */
export function isAfter(day, reference) {
  return day > reference;
}

/** Today, `YYYY-MM-DD` UTC. `now` is injectable so the tests stay stable. */
export function today(now = new Date()) {
  return formatDay(now);
}
