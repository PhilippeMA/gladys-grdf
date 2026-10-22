# Changelog

All notable changes to this integration are documented here. The Release
workflow moves the `[Unreleased]` section under the released version.

## [Unreleased]

### Fixed

- A GRDF that cannot be reached is now reported as such — "GRDF refused the
  connection (ECONNREFUSED)", "did not accept the connection in time", "could
  not be resolved (DNS)" — instead of a bare `TypeError: fetch failed`, and
  retried within the pass. A connection problem is not a refused login, and the
  message now says so rather than sending the user to check their password.

## [1.2.0] - 2026-10-20

### Added

- Energy cost tracking. The daily consumption is now published through the
  Gladys dated-consumption API instead of the states path: Gladys derives a
  cost feature from it, attaches it to the meter and prices it against the
  energy contract the user configures. Requires **Gladys 5.2.0 or later**.

### Changed

- The meter index is now a volume sensor (m³) instead of an energy index.
  Gladys treats an energy index as a cumulative **energy** reading: it derived
  a half-hourly consumption and a cost from the deltas of our cubic metres and
  hung them under the main electric meter, billing gas volume at the
  electricity price.
- The daily consumption is now stamped by Gladys at the local midnight of the
  gas day, instead of noon UTC by the integration: the core owns the instant of
  an interval. Days already imported keep their old timestamp; no day ends up
  with two values, since the cursor never goes back on its own.
- SDK 0.12 → 0.15, Node 22 minimum, refreshed CI and release workflows from
  the official template.

### Upgrading

Gladys does not update the features of a device that is already created — a
re-publication of the discovery list only refreshes its params. A meter added
before this version therefore keeps its index declared as an energy index, and
its consumption on the states path: it keeps working, but gains no cost sensor,
and on Gladys 5.2 its cubic metres may show up as a consumption under the main
electric meter. Deleting the device and adding it back from the Discovery tab
gives the new definition — at the price of its history, which is re-imported
over the window configured in **History to import**.

### Fixed

- `/data` is now created owned by the `node` user in the image. Docker gives a
  new volume the owner of the image's directory, so `/data` was root-owned and
  the integration could not write its synchronization cursor: it fell back to
  memory and re-imported the history window on every restart.

[Unreleased]: https://github.com/PhilippeMA/gladys-grdf/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/PhilippeMA/gladys-grdf/releases/tag/v1.2.0
