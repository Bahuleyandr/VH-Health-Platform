/**
 * THE CALENDAR-DATE RAIL.
 *
 * A Postgres `DATE` is a calendar day. It has no time and no zone, and it is
 * NOT an instant — but it materialises as one anyway: the pg driver hands
 * `SELECT '2026-09-06'::date` back as the JS Date 2026-09-06T00:00:00.000Z on a
 * UTC session, and Prisma's model delegates do the same. So `new Date(row.day)`
 * is a perfectly usable Date object that silently means "05:30 that morning, on
 * the ward" — and comparing it to `Date.now()` is wrong by the facility's
 * offset for 5h30m of every day.
 *
 * That is not a hypothetical. It shipped three times:
 *
 *   1. an expired ABDM/HIU key accepted for up to 5h30m,
 *   2. an expired ABHA enrolment OTP accepted for up to 5h30m,
 *   3. PR #1022 — an outside lab report dated TODAY ranked BEHIND an older one
 *      between 18:30Z and 24:00Z, because the day it named looked future.
 *
 * The first two were timestamptz and were fixed with the absolute-instant twin
 * (`(EXTRACT(EPOCH FROM col) * 1000)::bigint`, src/utils/dbInstant.js). THAT
 * FIX IS WRONG HERE. An epoch twin of a DATE just re-freezes the same arbitrary
 * midnight — it makes the wrong instant portable instead of removing it. A
 * calendar day is only ever comparable to another calendar day.
 *
 * SO: one rail, two ends.
 *
 *   const day   = calendarDateMs(row.expiry_date);      // the DATE, as a day
 *   const today = calendarDayStartMs(new Date());       // the WARD's today
 *   if (!Number.isFinite(day) || day < today) { ... }   // expired
 *
 * Both ends resolve through the SAME zone, so the comparison is a comparison of
 * days however the two values arrived. The alternative — and it is equally
 * correct — is not to bring the question into JS at all:
 *
 *   WHERE expiry_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
 *
 * NULL HANDLING IS THE CALLER'S, and it is deliberately not the same
 * everywhere — exactly as src/utils/dbInstant.js argues for instants.
 * `calendarDateMs` returns NaN, never 0, because `Number(null)` is 0 and 0
 * reads as 1970, i.e. "long ago", which silently expires everything with a NULL
 * date. An AUTHORISATION gate must therefore deny on NaN
 * (`!Number.isFinite(day) || day < today`); a capability field whose NULL means
 * "no expiry configured" may permit it (`Number.isFinite(day) && day < today`).
 * PR #881 got that inversion wrong on abdm_consents.expiry_date and #882
 * restored the deny branch; the same trap is here.
 *
 * THE ZONE IS A PARAMETER, and today it has exactly one value.
 * `FACILITY_CALENDAR_ZONE` is the platform's single-region default. The `zone`
 * argument is the multi-region SEAM, designed here and not yet rolled out: no
 * caller passes it, no tenant configures it, and giving each facility its own
 * ward day is a separate change with its own migration (a facility-level zone
 * column) and its own backfill question about what every stored comparison
 * meant before it. Parameterised now so that change is a wiring job rather than
 * a hunt for hardcoded offsets — which is precisely what the three defects
 * above cost.
 *
 * IANA ZONE, NOT A FIXED OFFSET. Asia/Kolkata has no DST, so `+05:30` would be
 * exact for it — but it would be exact only for it, and a fixed offset is not a
 * zone the seam above could ever be widened to. The offset is resolved through
 * Intl AT THE INSTANT IN QUESTION, so a DST zone gets the offset that was
 * actually in force on that day.
 *
 * Relatives worth knowing: `istDateString` in src/utils/dateUtils.js is the
 * same ward-day key for display and ledger keys, and `clinicalDate` in
 * services/clinical/bloodborneMarkerRules.js is the same idea inside the
 * serology rules. Neither is a comparison rail; this module is.
 */

/**
 * The facility's calendar zone. One value today — see the zone note above.
 */
export const FACILITY_CALENDAR_ZONE = 'Asia/Kolkata';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const MS_PER_DAY = 86_400_000;

/**
 * How far `zone` is ahead of UTC at a given instant, in milliseconds.
 *
 * Formats the instant IN the zone, reads the wall-clock fields back as if they
 * were UTC, and takes the difference. That is the offset that was actually in
 * force then, which is why a DST zone needs no special case.
 */
function zoneOffsetMs(instantMs, zone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const field = (type) => Number(parts.find((part) => part.type === type)?.value);
  // hourCycle h23 still renders midnight as '24' in some ICU versions.
  const hour = field('hour') % 24;
  const asIfUtc = Date.UTC(
    field('year'), field('month') - 1, field('day'), hour, field('minute'), field('second'),
  );
  return asIfUtc - instantMs;
}

/**
 * The Y-M-D a DATE column value names, as a string, or '' if it names none.
 *
 * Accepts BOTH shapes the same column arrives in, because they mean the same
 * thing: the driver-materialised Date (always UTC midnight of the day — its Y-M-D
 * must therefore be read in UTC, never with getFullYear()) and the plain
 * 'YYYY-MM-DD' string a request body or a ::text cast carries.
 */
export function calendarDateIso(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : '';
  }
  const match = ISO_DATE.exec(String(value).trim());
  return match ? match[0].slice(0, 10) : '';
}

/**
 * Midnight of the calendar day `value` names, in `zone`, as epoch milliseconds.
 *
 * NaN — never 0 — when `value` names no day. See the null-handling note above:
 * 0 is a finite instant that reads as 1970, so a bare truthiness or isFinite
 * slip turns a missing date into an expired one.
 *
 * @param {Date|string|null|undefined} value a DATE column value
 * @param {string} [zone] IANA zone; the facility default
 * @returns {number} epoch ms, or NaN
 */
export function calendarDateMs(value, zone = FACILITY_CALENDAR_ZONE) {
  const iso = calendarDateIso(value);
  if (!iso) return NaN;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  const utcGuess = Date.UTC(year, month - 1, day);
  // Round-trip guards a date that overflowed its month (2026-02-31), which
  // Date.UTC would silently roll forward.
  const roundTrip = new Date(utcGuess);
  if (roundTrip.getUTCFullYear() !== year
    || roundTrip.getUTCMonth() !== month - 1
    || roundTrip.getUTCDate() !== day) {
    return NaN;
  }
  // Two passes: the first offset is read at UTC midnight, which can fall on the
  // wrong side of a DST transition; the second is read at the instant the first
  // produced, which is the one being asked about.
  const first = utcGuess - zoneOffsetMs(utcGuess, zone);
  return utcGuess - zoneOffsetMs(first, zone);
}

/**
 * The calendar day `instant` falls on in `zone`, as 'YYYY-MM-DD'.
 *
 * This is the ONLY legitimate way to turn the clock into something a DATE may
 * be compared with. `instant` is the process clock (or a database one) — that
 * part is fine; what is never fine is comparing it to a DATE without coming
 * through here first.
 */
export function calendarDayOf(instant, zone = FACILITY_CALENDAR_ZONE) {
  const ms = instant instanceof Date ? instant.getTime() : Number(instant);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

/**
 * Midnight of the calendar day `instant` falls on, in `zone`, as epoch ms.
 *
 * The right-hand side of every DATE comparison: `calendarDayStartMs(new Date())`
 * is "the start of the ward's today", which is what `expiry_date < today` has
 * to mean.
 */
export function calendarDayStartMs(instant, zone = FACILITY_CALENDAR_ZONE) {
  const day = calendarDayOf(instant, zone);
  return day ? calendarDateMs(day, zone) : NaN;
}

/**
 * Whole calendar days from the DATE `value` to the day `instant` falls on.
 *
 * Positive when the date is in the past, negative when it is in the future,
 * NaN when either end is unusable. Both ends are reduced to a ward day first,
 * so the answer never depends on the time of day either one carried.
 */
export function calendarDaysSince(value, instant, zone = FACILITY_CALENDAR_ZONE) {
  const from = calendarDateMs(value, zone);
  const to = calendarDayStartMs(instant, zone);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return NaN;
  return Math.round((to - from) / MS_PER_DAY);
}

/**
 * Whole calendar days from the day `instant` falls on to the DATE `value`.
 * Positive when the date is still ahead — "days remaining".
 */
export function calendarDaysUntil(value, instant, zone = FACILITY_CALENDAR_ZONE) {
  const days = calendarDaysSince(value, instant, zone);
  return Number.isFinite(days) ? -days : NaN;
}

export default {
  FACILITY_CALENDAR_ZONE,
  calendarDateIso,
  calendarDateMs,
  calendarDayOf,
  calendarDayStartMs,
  calendarDaysSince,
  calendarDaysUntil,
};
