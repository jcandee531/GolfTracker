# PGA Golfer Earnings Tracker

This is a basic PGA golfer tracker that pulls the current tournament field,
lets you search and save golfers, and persists selections plus historical
earnings on disk. It refreshes leaderboard data every 30 minutes by default.

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Data persistence on Render

Attach a persistent disk and set `DATA_DIR` to that mount (for example
`/var/data`). The app stores selections and history in `store.json`.

## Configuration

Environment variables:

- `PORT`: Server port (default 3000)
- `DATA_DIR`: Directory for persisted data (default `./data`)
- `PGA_SCOREBOARD_URL`: PGA scoreboard source URL
- `REFRESH_INTERVAL_MINUTES`: Refresh interval in minutes (default 30)
- `DEFAULT_PURSE_USD`: Purse used for earnings projections (default 8,500,000)
- `PAYOUT_SCHEDULE_PATH`: Optional JSON array of payout percentages
  (default `./data/payouts.json` if present)

Projected earnings are estimates. Update `DEFAULT_PURSE_USD` or provide a
custom payout schedule to match the tournament you are tracking.

## Import historical results

You can upload past tournament results to keep a running total for the current
calendar year. The UI accepts CSV or JSON.

CSV headers (required):

```
golferName,eventName,eventEndDate,finalPosition,finalEarnings
```

Example:

```
golferName,eventName,eventEndDate,finalPosition,finalEarnings
Scottie Scheffler,The Players Championship,2026-03-16,1,4500000
Ludvig Aberg,The Players Championship,2026-03-16,2,2500000
```

JSON example:

```json
[
  {
    "golferName": "Scottie Scheffler",
    "eventName": "The Players Championship",
    "eventEndDate": "2026-03-16",
    "finalPosition": 1,
    "finalEarnings": 4500000
  }
]
```
