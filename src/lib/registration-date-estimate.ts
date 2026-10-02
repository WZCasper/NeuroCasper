// Telegram's Bot API does not expose an account's registration date in any
// field of any endpoint (see the User object: id, is_bot, first_name,
// last_name, username, language_code, is_premium,
// added_to_attachment_menu -- no date of any kind). This module estimates
// it instead, using the well-documented fact that Telegram numeric user
// IDs are assigned roughly sequentially over time, by linearly
// interpolating between known (userId -> registration date) reference
// points collected and published by a third party.
//
// Dataset and algorithm: WizardLoop/CreationDate
// https://github.com/WizardLoop/CreationDate (MIT License, retrieved for
// this project as of its 2025-11-11 data snapshot -- 212 points spanning
// 2013-08-14 through 2025-11-11). That project's own accuracy.md
// describes the result as "usually within weeks" for IDs that fall
// between two known points, and explicitly warns "This project provides
// high-quality estimates, not official data. Dates should not be treated
// as legally or technically authoritative" -- this module inherits that
// same caveat and is not a source of truth about anyone's real
// registration date. The interpolation logic below (interpolate /
// estimateRegistrationDate) is a direct TypeScript port of that project's
// own src/python/estimate.py, including its exact boundary handling
// (ID at or before the first point returns that point's date verbatim;
// an ID past the last point extrapolates from the final pair, clamped to
// "not later than right now" since an account cannot have registered in
// the future).
//
// Known limitation, inherited from the source dataset rather than
// introduced here: after sorting the 212 points by ID (ascending), their
// dates are NOT perfectly monotonic -- roughly 40% of consecutive pairs
// have the later-ID point dated slightly EARLIER than the point before
// it (real-world observations collected from varied sources are noisy).
// This can make a handful of individual estimates a few weeks off in
// either direction for IDs that fall in one of those pairs. This module
// does not attempt to smooth or correct that -- doing so would mean
// substituting a self-devised, unverified adjustment for an algorithm
// that is otherwise a faithful, auditable port of a cited public source.
// Given the estimate is already surfaced to users as an approximation
// (see formatApproximateRegistrationDate below), and the effect is
// measured in weeks rather than months or years, this is judged an
// acceptable trade-off rather than a defect to silently paper over.

/** [telegramUserId, "YYYY-MM-DD"], sorted ascending by ID. Copied verbatim
 * from WizardLoop/CreationDate's data/tg_points.json (see module doc
 * comment above for provenance, license, and the dataset's known
 * non-monotonicity). Do not hand-edit -- regenerate from that project's
 * data file if it publishes a newer snapshot. */
const REFERENCE_POINTS: ReadonlyArray<readonly [number, string]> = [
  [0, "2013-08-14"],
  [2768409, "2013-11-01"],
  [7679610, "2013-12-31"],
  [11538514, "2014-02-01"],
  [15835244, "2014-02-20"],
  [23646077, "2014-02-26"],
  [38015510, "2014-03-01"],
  [44634663, "2014-05-06"],
  [46145305, "2014-05-15"],
  [54845238, "2014-09-20"],
  [63263518, "2014-10-27"],
  [101260938, "2015-03-06"],
  [101323197, "2015-03-13"],
  [103151531, "2015-06-03"],
  [103258382, "2015-05-27"],
  [109393468, "2015-08-08"],
  [111220210, "2015-04-21"],
  [112594714, "2015-08-15"],
  [116812045, "2015-07-23"],
  [122600695, "2015-07-24"],
  [124872445, "2015-08-17"],
  [125828524, "2015-10-05"],
  [130029930, "2015-09-03"],
  [133909606, "2015-10-07"],
  [143445125, "2015-12-01"],
  [148670295, "2016-01-08"],
  [152079341, "2016-01-22"],
  [157242073, "2015-11-06"],
  [171295414, "2016-03-09"],
  [181783990, "2016-04-10"],
  [222021233, "2016-06-08"],
  [225034354, "2016-06-18"],
  [278941742, "2016-09-10"],
  [285253072, "2016-10-18"],
  [294851037, "2016-11-19"],
  [297621225, "2016-12-16"],
  [328594461, "2017-01-28"],
  [337808429, "2017-02-21"],
  [341546272, "2017-02-22"],
  [352940995, "2017-02-24"],
  [369669043, "2017-03-31"],
  [400169472, "2017-07-31"],
  [805158066, "2019-07-15"],
  [1974255900, "2021-10-12"],
  [5022636255, "2021-12-10"],
  [5031711230, "2021-12-06"],
  [5045293264, "2022-01-13"],
  [5047148663, "2022-04-05"],
  [5070164216, "2022-01-19"],
  [5106451106, "2022-03-05"],
  [5124771193, "2022-02-22"],
  [5144324763, "2022-04-06"],
  [5149590651, "2022-01-22"],
  [5153900870, "2022-03-22"],
  [5155903109, "2022-03-22"],
  [5159326926, "2022-06-16"],
  [5166844465, "2022-05-09"],
  [5169485538, "2022-03-01"],
  [5170390109, "2022-02-28"],
  [5177789190, "2022-01-24"],
  [5179102906, "2022-03-12"],
  [5196353812, "2022-02-15"],
  [5207110227, "2022-02-03"],
  [5210565134, "2022-02-09"],
  [5244529493, "2022-04-19"],
  [5259159476, "2022-05-06"],
  [5260388619, "2022-03-02"],
  [5268253519, "2022-03-22"],
  [5271530336, "2022-04-30"],
  [5288930461, "2022-01-27"],
  [5308260177, "2022-04-25"],
  [5340744210, "2022-10-26"],
  [5349830748, "2022-04-29"],
  [5351497367, "2022-05-24"],
  [5363536419, "2022-08-01"],
  [5394432429, "2022-05-23"],
  [5396515972, "2022-04-21"],
  [5428357996, "2022-07-11"],
  [5433708969, "2022-05-28"],
  [5434011049, "2022-06-29"],
  [5442755368, "2022-07-23"],
  [5451256696, "2022-08-06"],
  [5468433192, "2022-07-20"],
  [5468950164, "2022-07-14"],
  [5472518401, "2022-11-02"],
  [5488407539, "2022-05-29"],
  [5505809357, "2022-05-27"],
  [5515826405, "2022-10-03"],
  [5519218712, "2022-08-14"],
  [5542245357, "2022-07-07"],
  [5546930145, "2022-07-24"],
  [5558980075, "2022-10-30"],
  [5559594088, "2022-11-10"],
  [5567880858, "2023-01-25"],
  [5595045952, "2022-10-23"],
  [5596032583, "2022-06-16"],
  [5598262640, "2022-06-11"],
  [5601951167, "2022-10-02"],
  [5627539474, "2022-12-02"],
  [5681900282, "2022-10-17"],
  [5694365966, "2022-08-28"],
  [5705427359, "2022-10-06"],
  [5721138769, "2022-09-23"],
  [5735455201, "2022-10-07"],
  [5738347976, "2023-04-25"],
  [5744374534, "2022-10-10"],
  [5765259845, "2022-10-30"],
  [5795660441, "2022-11-06"],
  [5802659303, "2023-03-21"],
  [5804028268, "2023-03-05"],
  [5806925457, "2023-01-12"],
  [5815100469, "2022-12-29"],
  [5839137822, "2022-12-16"],
  [5854845236, "2023-04-27"],
  [5859861622, "2022-11-19"],
  [5862080962, "2022-12-13"],
  [5869978651, "2023-03-24"],
  [5891297818, "2023-05-04"],
  [5904140174, "2023-05-20"],
  [5931294587, "2022-11-19"],
  [5964221956, "2023-01-09"],
  [5983753471, "2022-12-23"],
  [5994561143, "2023-05-16"],
  [6000582627, "2023-05-30"],
  [6001287799, "2023-05-10"],
  [6074830852, "2023-05-01"],
  [6108395402, "2023-05-18"],
  [6135597783, "2023-05-24"],
  [6175817126, "2023-05-07"],
  [6180394472, "2023-05-29"],
  [6188508923, "2023-06-22"],
  [6254094947, "2023-02-27"],
  [6271031786, "2023-02-12"],
  [6277658932, "2023-03-17"],
  [6326011828, "2023-07-07"],
  [6401027363, "2023-11-25"],
  [6451891234, "2023-12-02"],
  [6513268158, "2023-12-02"],
  [6514802524, "2023-11-16"],
  [6523424924, "2023-08-02"],
  [6536173556, "2024-01-11"],
  [6545049031, "2023-12-19"],
  [6559717847, "2024-02-25"],
  [6606876583, "2024-03-17"],
  [6651640269, "2024-05-18"],
  [6670760749, "2024-01-14"],
  [6684986493, "2023-09-25"],
  [6703731755, "2024-05-05"],
  [6715889959, "2024-02-05"],
  [6720229740, "2024-03-17"],
  [6732829831, "2024-02-11"],
  [6749492866, "2023-11-22"],
  [6765129195, "2023-11-02"],
  [6827058708, "2023-11-06"],
  [6829119388, "2023-12-02"],
  [6854829938, "2024-02-01"],
  [6872061796, "2024-05-25"],
  [6903333095, "2024-01-31"],
  [6926984452, "2024-01-09"],
  [6947316117, "2023-12-15"],
  [7002435197, "2024-04-06"],
  [7078066115, "2024-09-08"],
  [7085776398, "2024-05-10"],
  [7104310277, "2024-04-19"],
  [7224009547, "2024-08-02"],
  [7242296450, "2024-05-29"],
  [7243375923, "2024-08-25"],
  [7254607307, "2024-06-10"],
  [7273085448, "2024-11-21"],
  [7280136256, "2024-07-04"],
  [7293965553, "2024-06-16"],
  [7342300216, "2025-01-16"],
  [7357703634, "2024-09-10"],
  [7363299295, "2024-07-25"],
  [7409259451, "2024-06-20"],
  [7450316621, "2024-12-02"],
  [7458668365, "2024-08-02"],
  [7591351660, "2025-03-21"],
  [7664959631, "2024-12-19"],
  [7708562823, "2025-05-10"],
  [7747102337, "2024-11-06"],
  [7793034911, "2024-09-23"],
  [7817256746, "2025-06-18"],
  [7825518194, "2025-01-16"],
  [7829910989, "2025-05-11"],
  [7831448272, "2024-11-11"],
  [7832006200, "2024-09-19"],
  [7834356221, "2025-09-01"],
  [7852083588, "2025-06-02"],
  [7870888707, "2025-06-08"],
  [7899152800, "2025-04-08"],
  [7912577935, "2025-09-15"],
  [7915901421, "2025-07-07"],
  [7964511972, "2025-03-26"],
  [8017192943, "2025-10-05"],
  [8044853035, "2025-03-20"],
  [8096742229, "2025-08-31"],
  [8117852491, "2025-10-14"],
  [8135088730, "2025-03-05"],
  [8173852075, "2025-02-21"],
  [8179125032, "2025-07-09"],
  [8200159552, "2025-09-12"],
  [8209194945, "2025-10-26"],
  [8238766847, "2025-07-31"],
  [8325327280, "2025-10-13"],
  [8343786378, "2025-08-08"],
  [8369442459, "2025-08-08"],
  [8384648263, "2025-10-23"],
  [8393200797, "2025-10-25"],
  [8461579295, "2025-09-11"],
  [8480708838, "2025-11-05"],
  [8559682245, "2025-11-11"],
];

const firstReferencePointCandidate = REFERENCE_POINTS[0];
if (!firstReferencePointCandidate) {
  // Can only happen if REFERENCE_POINTS above is ever hand-edited down to
  // empty -- fail loudly at module load rather than silently producing
  // nonsense dates for every call. TypeScript's control-flow narrowing
  // doesn't carry this guarantee across the function boundary below, so
  // the checked value is re-bound to its own explicitly-typed constant
  // (FIRST_REFERENCE_POINT) rather than relied on via the original
  // possibly-undefined binding.
  throw new Error("registration-date-estimate: REFERENCE_POINTS must not be empty");
}
const FIRST_REFERENCE_POINT: readonly [number, string] = firstReferencePointCandidate;

const LAST_TWO_REFERENCE_POINTS: readonly [readonly [number, string], readonly [number, string]] = [
  REFERENCE_POINTS[REFERENCE_POINTS.length - 2]!,
  REFERENCE_POINTS[REFERENCE_POINTS.length - 1]!,
];
const LAST_REFERENCE_ID = LAST_TWO_REFERENCE_POINTS[1][0];

function parseIsoDateAsUtcMillis(isoDate: string): number {
  // New Date("YYYY-MM-DD") is specified to parse as UTC midnight, matching
  // how the reference dataset's dates are stored (calendar dates with no
  // time-of-day component).
  return new Date(isoDate).getTime();
}

function interpolate(userId: number, id1: number, date1: string, id2: number, date2: string, now: number): number {
  if (id1 === id2) return parseIsoDateAsUtcMillis(date1);

  const t1 = parseIsoDateAsUtcMillis(date1);
  const t2 = parseIsoDateAsUtcMillis(date2);
  const ratio = (userId - id1) / (id2 - id1);
  const estimatedMillis = t1 + (t2 - t1) * ratio;

  // An account cannot have registered in the future.
  return Math.min(estimatedMillis, now);
}

export interface RegistrationEstimate {
  /** The estimated date itself, as a UTC-midnight Date. */
  date: Date;
  /** True when userId falls beyond the last reference point, meaning
   * this estimate is an extrapolation rather than an interpolation
   * between two known points -- accuracy is not bounded by the source
   * dataset's own "usually within weeks" claim in this case, and
   * degrades further the more the ID exceeds LAST_REFERENCE_ID. */
  extrapolated: boolean;
}

/** Estimates when a Telegram account with the given numeric user ID was
 * registered. See this module's top-of-file doc comment for the method,
 * its source, and its known limitations -- this is always an
 * approximation, never a confirmed fact. */
export function estimateRegistrationDate(userId: number): RegistrationEstimate {
  const now = Date.now();
  const points = REFERENCE_POINTS;

  if (userId <= FIRST_REFERENCE_POINT[0]) {
    return { date: new Date(parseIsoDateAsUtcMillis(FIRST_REFERENCE_POINT[1])), extrapolated: false };
  }

  for (let i = 0; i < points.length - 1; i++) {
    const point1 = points[i];
    const point2 = points[i + 1];
    // Both are guaranteed defined: i ranges over valid indices of `points`
    // and i+1 <= points.length - 1 by the loop bound above.
    if (!point1 || !point2) continue;
    const [id1, date1] = point1;
    const [id2, date2] = point2;
    if (id1 <= userId && userId <= id2) {
      return { date: new Date(interpolate(userId, id1, date1, id2, date2, now)), extrapolated: false };
    }
  }

  const [id1, date1] = LAST_TWO_REFERENCE_POINTS[0];
  const [id2, date2] = LAST_TWO_REFERENCE_POINTS[1];
  return { date: new Date(interpolate(userId, id1, date1, id2, date2, now)), extrapolated: userId > LAST_REFERENCE_ID };
}

const RU_MONTHS_GENITIVE = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

/** Renders a RegistrationEstimate as a short Russian phrase for use in a
 * welcome message, always prefixed with "≈" and, when the estimate falls
 * past the source dataset's last reference point, with an extra explicit
 * note that this particular estimate is even less certain than usual --
 * see RegistrationEstimate.extrapolated. Never presented as a confirmed
 * fact. */
export function formatApproximateRegistrationDate(estimate: RegistrationEstimate): string {
  const d = estimate.date;
  const day = d.getUTCDate();
  const month = RU_MONTHS_GENITIVE[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const base = `≈ ${day} ${month} ${year}`;
  return estimate.extrapolated ? `${base} (очень грубая оценка, данных за этот период мало)` : base;
}
