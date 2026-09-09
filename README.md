# citsviewer

Live map viewer for the ETSI ITS-G5 C-ITS messages decoded by
[mqtt-bridge](https://github.com/emente/mqtt-bridge) into MySQL/MariaDB.
Plain PHP + [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/) --
no build step, no framework, no Composer dependencies.

- **`api.php`** -- read-only JSON endpoint: latest known station positions
  (from the `stations` table), active/recently-expired DENM hazards (from
  `denm_events`), and bridge device telemetry (from `devices` /
  `device_stats`), with an `expired_hours` query param to widen the window
  beyond just currently-live items.
- **`index.html`** / **`app.js`** / **`style.css`** -- the map itself:
  polls `api.php` every few seconds, renders vehicles/RSUs/hazards, and a
  side panel with per-station and per-device detail popups.
- **`seed.php`** -- dev utility to fill/clear dummy stations and hazards
  (tagged with `device_id = 'seed-dummy'`, never touching real bridge
  data) so the map has something to show before real traffic arrives.
  `seed.php?action=fill[&count=12]` / `seed.php?action=clear`.
- **`env.php`** -- tiny dependency-free `.env` loader shared by `api.php`
  and `seed.php`.

## Setup

Copy `.env.example` to `.env` and fill in the same MySQL/MariaDB
credentials used by `mqtt-bridge` (they read the same `its_bridge`
database):

```bash
cp .env.example .env
```

Then just serve this directory with PHP (the `mysqli` extension must be
enabled) -- no build step needed.
