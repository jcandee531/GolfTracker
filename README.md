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
- `SCHEDULE_REFRESH_MINUTES`: Schedule refresh interval (default 360)
- `DEFAULT_PURSE_USD`: Purse used for earnings projections (default 8,500,000)
- `PAYOUT_SCHEDULE_PATH`: Optional JSON array of payout percentages
  (default `./data/payouts.json` if present)
- `EVENT_PURSE_PATH`: Optional JSON map of event purses
  (default `./data/event-purses.json` if present)

Projected earnings are estimates. Update `DEFAULT_PURSE_USD` or provide a
custom payout schedule to match the tournament you are tracking.

To use accurate per-tournament purses, create `event-purses.json` like:

```json
{
  "defaultPurse": 8500000,
  "events": {
    "401811930": 9000000,
    "The Masters": 18000000,
    "U.S. Open": 20000000
  }
}
```

## Selecting past and upcoming tournaments

Use the tournament dropdown to choose any event from this year's PGA schedule.
When you pick a completed tournament, the golfer is added directly to the
historical results table. Upcoming events are saved in your selections so you
can revisit them once the field is published or the event is in progress.
