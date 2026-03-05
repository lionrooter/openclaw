/**
 * Delivery Token Expansion
 *
 * Expands date/time template tokens in cron job delivery target strings.
 * This allows cron jobs to use dynamic topics like:
 *
 *   "stream:04💻 coding-loop:topic:overnight/{date}"
 *   "stream:02🦞 clawdy-loop:topic:standup/{date}"
 *   "stream:13🔧 infrastructure-loop:topic:maintenance/{week}"
 *
 * Supported tokens:
 *   {date}      → 2026-03-04           (ISO date)
 *   {week}      → 2026-W10             (ISO week)
 *   {month}     → 2026-03              (year-month)
 *   {weekday}   → tue                  (3-letter lowercase day)
 *   {time}      → 09-00                (HH-MM, safe for topic names)
 *   {datetime}  → 2026-03-04T09-00     (date + time)
 *
 * If no tokens are present, the string is returned unchanged (zero overhead).
 */

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/**
 * Get the ISO week number for a date.
 * ISO 8601: week starts Monday, week 1 contains the first Thursday of the year.
 */
function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Make Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Set to nearest Thursday
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/**
 * Expand delivery tokens in a target string.
 *
 * @param value - The delivery target string (e.g., "stream:...:topic:overnight/{date}")
 * @param now - Optional Date for testing; defaults to current time
 * @returns The expanded string with all tokens replaced
 */
export function expandDeliveryTokens(value: string, now?: Date): string {
  // Fast path: no tokens present
  if (!value.includes("{")) {
    return value;
  }

  const d = now ?? new Date();
  const isoDate = d.toISOString().slice(0, 10); // 2026-03-04
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");

  return value
    .replace(/\{date\}/g, isoDate)
    .replace(/\{week\}/g, `${d.getFullYear()}-W${String(isoWeekNumber(d)).padStart(2, "0")}`)
    .replace(/\{month\}/g, isoDate.slice(0, 7))
    .replace(/\{weekday\}/g, WEEKDAYS[d.getDay()] ?? "unknown")
    .replace(/\{time\}/g, `${hours}-${minutes}`)
    .replace(/\{datetime\}/g, `${isoDate}T${hours}-${minutes}`);
}
