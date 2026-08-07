import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReadings, withTemperatures } from '../src/grdf/readings.js';

/** A reading as GRDF returns it. */
function releve(overrides = {}) {
  return {
    dateDebutReleve: '2026-08-01T06:00:00+02:00',
    dateFinReleve: '2026-08-02T06:00:00+02:00',
    journeeGaziere: '2026-08-01',
    indexDebut: 12000,
    indexFin: 12004,
    volumeBrutConsomme: 4,
    energieConsomme: 44.5,
    coeffConversion: 11.12,
    temperature: null,
    natureReleve: 'Informative Journalier',
    qualificationReleve: 'Mesuré',
    status: 'Définitive',
    ...overrides,
  };
}

test('normalizeReadings maps the French fields onto clean readings', () => {
  const [reading] = normalizeReadings([releve()]);
  assert.deepEqual(reading, {
    day: '2026-08-01',
    energy: 44.5,
    volume: 4,
    endIndex: 12004,
    conversionFactor: 11.12,
    temperature: undefined,
    quality: 'Mesuré',
    provisional: false,
  });
});

test('normalizeReadings tolerates numbers sent as strings', () => {
  const [reading] = normalizeReadings([
    releve({ energieConsomme: '44.5', volumeBrutConsomme: '4', temperature: '18.2' }),
  ]);
  assert.equal(reading.energy, 44.5);
  assert.equal(reading.volume, 4);
  assert.equal(reading.temperature, 18.2);
});

test('normalizeReadings drops the days GRDF has no data for', () => {
  const readings = normalizeReadings([
    releve({ journeeGaziere: '2026-08-01' }),
    releve({
      journeeGaziere: '2026-08-02',
      qualificationReleve: 'Absence de Données',
      energieConsomme: null,
      volumeBrutConsomme: null,
      indexFin: null,
    }),
  ]);
  assert.deepEqual(
    readings.map((reading) => reading.day),
    ['2026-08-01'],
  );
});

test('normalizeReadings drops a row carrying no measurement at all', () => {
  const readings = normalizeReadings([
    releve({ energieConsomme: null, volumeBrutConsomme: null, indexFin: null }),
  ]);
  assert.deepEqual(readings, []);
});

test('normalizeReadings keeps a row that only has one of the three measurements', () => {
  const readings = normalizeReadings([releve({ energieConsomme: null, indexFin: null })]);
  assert.equal(readings.length, 1);
  assert.equal(readings[0].volume, 4);
  assert.equal(readings[0].energy, undefined);
});

test('normalizeReadings falls back on the end of the period when there is no gas day', () => {
  // Meters read twice a year produce one lump reading, with no `journeeGaziere`.
  const [reading] = normalizeReadings([
    releve({ journeeGaziere: null, dateFinReleve: '2026-08-02T06:00:00+02:00' }),
  ]);
  assert.equal(reading.day, '2026-08-02');
});

test('normalizeReadings sorts by day and keeps the latest version of a day', () => {
  const readings = normalizeReadings([
    releve({ journeeGaziere: '2026-08-03', energieConsomme: 30 }),
    releve({ journeeGaziere: '2026-08-01', energieConsomme: 10 }),
    // GRDF re-publishes a day when it corrects an estimate.
    releve({ journeeGaziere: '2026-08-01', energieConsomme: 12, qualificationReleve: 'Corrigé' }),
  ]);
  assert.deepEqual(
    readings.map((reading) => [reading.day, reading.energy]),
    [
      ['2026-08-01', 12],
      ['2026-08-03', 30],
    ],
  );
});

test('normalizeReadings flags a provisional reading', () => {
  const [reading] = normalizeReadings([releve({ status: 'Provisoire' })]);
  assert.equal(reading.provisional, true);
});

test('normalizeReadings survives a missing or malformed payload', () => {
  assert.deepEqual(normalizeReadings(undefined), []);
  assert.deepEqual(normalizeReadings(null), []);
  assert.deepEqual(normalizeReadings('nope'), []);
  assert.deepEqual(normalizeReadings([null, 42, {}]), []);
});

test('withTemperatures only fills the missing temperatures', () => {
  const readings = [
    { day: '2026-08-01', temperature: undefined },
    { day: '2026-08-02', temperature: 20 },
    { day: '2026-08-03', temperature: undefined },
  ];
  const filled = withTemperatures(readings, { '2026-08-01': '18.4', '2026-08-02': 99 });
  assert.deepEqual(
    filled.map((reading) => reading.temperature),
    [18.4, 20, undefined],
  );
});

test('withTemperatures accepts an empty or missing meteo payload', () => {
  const readings = [{ day: '2026-08-01', temperature: undefined }];
  assert.deepEqual(withTemperatures(readings), readings);
  assert.deepEqual(withTemperatures(readings, {}), readings);
});
