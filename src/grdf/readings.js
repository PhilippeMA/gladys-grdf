// -----------------------------------------------------------------------------
// Normalization of the GRDF readings (`relevés`).
//
// The API answers with one object per reading, with French field names, mixed
// types (numbers sometimes arrive as strings), nulls all over the place, and
// rows that carry no measurement at all (`Absence de Données`). Everything that
// deals with those quirks lives here, so the device code below only ever sees a
// clean list.
//
// Meters read daily (Gazpar, frequency `1M`/`MM`/`JJ`) produce one reading per
// gas day. Meters still read twice a year (`6M`) produce one lump reading per
// period; we keep it too, dated on the end of the period.
// -----------------------------------------------------------------------------

/** A finite number, or undefined (covers null, '', 'NaN', objects…). */
function toNumber(value) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** The `YYYY-MM-DD` part of a date-ish string, or undefined. */
function toDay(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : undefined;
}

/**
 * Turn the raw `releves` array of the GRDF response into clean readings,
 * sorted from oldest to newest, one per gas day.
 *
 * @param {unknown} releves the `releves` field of a PCE entry
 * @returns {Array<{
 *   day: string,
 *   energy?: number,
 *   volume?: number,
 *   endIndex?: number,
 *   conversionFactor?: number,
 *   temperature?: number,
 *   quality?: string,
 *   provisional: boolean,
 * }>}
 */
export function normalizeReadings(releves) {
  if (!Array.isArray(releves)) {
    return [];
  }

  /** @type {Map<string, object>} */
  const byDay = new Map();

  for (const releve of releves) {
    if (!releve || typeof releve !== 'object') {
      continue;
    }

    const day = toDay(releve.journeeGaziere) ?? toDay(releve.dateFinReleve);
    if (!day) {
      continue;
    }

    // GRDF fills the calendar with placeholder rows when the meter did not
    // report: they carry no measurement and must not become a state.
    if (releve.qualificationReleve === 'Absence de Données') {
      continue;
    }

    const energy = toNumber(releve.energieConsomme);
    const volume = toNumber(releve.volumeBrutConsomme);
    const endIndex = toNumber(releve.indexFin);
    if (energy === undefined && volume === undefined && endIndex === undefined) {
      continue;
    }

    // Later rows win: GRDF re-publishes a day when it corrects it.
    byDay.set(day, {
      day,
      energy,
      volume,
      endIndex,
      conversionFactor: toNumber(releve.coeffConversion),
      temperature: toNumber(releve.temperature),
      quality:
        typeof releve.qualificationReleve === 'string' ? releve.qualificationReleve : undefined,
      provisional: releve.status === 'Provisoire',
    });
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Fill the missing temperatures from the `meteo` endpoint (the readings
 * themselves often carry none).
 * @param {ReturnType<typeof normalizeReadings>} readings
 * @param {Record<string, unknown>} temperatures keyed by `YYYY-MM-DD`
 */
export function withTemperatures(readings, temperatures = {}) {
  return readings.map((reading) => {
    if (reading.temperature !== undefined) {
      return reading;
    }
    const temperature = toNumber(temperatures[reading.day]);
    return temperature === undefined ? reading : { ...reading, temperature };
  });
}
