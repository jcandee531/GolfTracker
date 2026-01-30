const express = require("express");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");
const PGA_SCOREBOARD_URL =
  process.env.PGA_SCOREBOARD_URL ||
  "https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard";
const REFRESH_INTERVAL_MINUTES = Number(
  process.env.REFRESH_INTERVAL_MINUTES || 30
);
const REFRESH_INTERVAL_MS = Math.max(1, REFRESH_INTERVAL_MINUTES) * 60 * 1000;
const DEFAULT_PURSE_USD = Number(process.env.DEFAULT_PURSE_USD || 8500000);
const PAYOUT_SCHEDULE_PATH =
  process.env.PAYOUT_SCHEDULE_PATH || path.join(DATA_DIR, "payouts.json");

const DEFAULT_PAYOUT_PCTS = [
  18, 10.9, 6.9, 4.9, 4.1, 3.6, 3.35, 3.1, 2.9, 2.7, 2.5, 2.3, 2.1, 1.9, 1.8,
  1.7, 1.6, 1.5, 1.4, 1.3, 1.2, 1.1, 1.05, 1, 0.95, 0.9, 0.86, 0.82, 0.78,
  0.74, 0.71, 0.68, 0.65, 0.62, 0.6, 0.58, 0.56, 0.54, 0.52, 0.5, 0.48,
  0.46, 0.44, 0.42, 0.4, 0.38, 0.36, 0.34, 0.32, 0.3, 0.29, 0.28, 0.27,
  0.26, 0.25, 0.24, 0.23, 0.22, 0.21, 0.2, 0.195, 0.19, 0.185, 0.18, 0.175,
  0.17, 0.165, 0.16, 0.155, 0.15
];

const storeDefaults = {
  selections: [],
  history: []
};

let store = { ...storeDefaults };
let payoutSchedule = [...DEFAULT_PAYOUT_PCTS];

let leaderboardCache = {
  event: null,
  players: [],
  playersById: new Map(),
  lastUpdated: null,
  status: "loading",
  error: null
};

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseScore(score) {
  if (!score || typeof score !== "string") {
    return null;
  }
  if (score === "E") {
    return 0;
  }
  const cleaned = score.replace(/[^\d+-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function estimateEarnings(position, purse, schedule) {
  if (!position || !purse || position < 1) {
    return 0;
  }
  const pct = schedule[position - 1];
  if (!pct) {
    return 0;
  }
  return Math.round(purse * (pct / 100));
}

function formatEventStatus(event) {
  if (!event) {
    return {
      id: "unknown",
      description: "Status unavailable",
      state: "unknown",
      completed: false
    };
  }
  return event.status?.type || event.status || {};
}

function computePositionDisplay(players) {
  const scoreCounts = new Map();
  players.forEach((player) => {
    const scoreKey = player.scoreDisplay || "--";
    scoreCounts.set(scoreKey, (scoreCounts.get(scoreKey) || 0) + 1);
  });

  players.forEach((player) => {
    if (!player.position) {
      player.positionDisplay = "--";
      return;
    }
    const scoreKey = player.scoreDisplay || "--";
    const isTie = scoreCounts.get(scoreKey) > 1;
    player.positionDisplay = isTie ? `T${player.position}` : `#${player.position}`;
  });
}

function normalizeCompetitors(competitors, eventInfo, purse, schedule) {
  const players = competitors
    .map((competitor) => {
      const position = safeNumber(competitor.order);
      const scoreDisplay = competitor.score || "E";
      return {
        id: competitor.id,
        name:
          competitor.athlete?.displayName ||
          competitor.athlete?.fullName ||
          "Unknown",
        shortName: competitor.athlete?.shortName || null,
        country: competitor.athlete?.flag?.alt || null,
        position,
        score: parseScore(scoreDisplay),
        scoreDisplay,
        status: eventInfo.statusDescription,
        projectedEarnings: estimateEarnings(position, purse, schedule),
        finalEarnings: eventInfo.isFinal
          ? estimateEarnings(position, purse, schedule)
          : null
      };
    })
    .sort((a, b) => (a.position || 9999) - (b.position || 9999));

  computePositionDisplay(players);
  return players;
}

function buildFallbackLeaderboard() {
  const event = {
    id: "sample-event",
    name: "Sample Invitational",
    shortName: "Sample Invitational",
    startDate: new Date().toISOString(),
    endDate: new Date().toISOString(),
    statusDescription: "Offline sample data",
    statusState: "offline",
    isFinal: false,
    purse: DEFAULT_PURSE_USD,
    purseEstimated: true
  };

  const competitors = [
    { id: "1", name: "Scottie Scheffler", score: "-10" },
    { id: "2", name: "Rory McIlroy", score: "-8" },
    { id: "3", name: "Jon Rahm", score: "-7" },
    { id: "4", name: "Viktor Hovland", score: "-6" },
    { id: "5", name: "Xander Schauffele", score: "-5" }
  ];

  const players = competitors.map((competitor, index) => ({
    id: competitor.id,
    name: competitor.name,
    shortName: null,
    country: null,
    position: index + 1,
    score: parseScore(competitor.score),
    scoreDisplay: competitor.score,
    status: event.statusDescription,
    projectedEarnings: estimateEarnings(index + 1, event.purse, payoutSchedule),
    finalEarnings: null,
    positionDisplay: `#${index + 1}`
  }));

  return {
    event,
    players
  };
}

async function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    await fsp.mkdir(DATA_DIR, { recursive: true });
  }
}

async function loadStore() {
  try {
    await ensureDataDir();
    if (!fs.existsSync(STORE_PATH)) {
      return { ...storeDefaults };
    }
    const raw = await fsp.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      selections: Array.isArray(parsed.selections) ? parsed.selections : [],
      history: Array.isArray(parsed.history) ? parsed.history : []
    };
  } catch (error) {
    console.warn("Failed to load store:", error.message);
    return { ...storeDefaults };
  }
}

async function saveStore() {
  await ensureDataDir();
  const payload = JSON.stringify(store, null, 2);
  await fsp.writeFile(STORE_PATH, payload, "utf8");
}

async function loadPayoutSchedule() {
  try {
    if (!fs.existsSync(PAYOUT_SCHEDULE_PATH)) {
      return [...DEFAULT_PAYOUT_PCTS];
    }
    const raw = await fsp.readFile(PAYOUT_SCHEDULE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((value) => Number(value) >= 0)) {
      return parsed.map((value) => Number(value));
    }
  } catch (error) {
    console.warn("Failed to load payout schedule:", error.message);
  }
  return [...DEFAULT_PAYOUT_PCTS];
}

function buildEventInfo(event) {
  if (!event) {
    return null;
  }
  const status = formatEventStatus(event);
  return {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    startDate: event.date,
    endDate: event.endDate,
    statusDescription: status.description || "Status unavailable",
    statusState: status.state || "unknown",
    isFinal: Boolean(status.completed),
    purse: DEFAULT_PURSE_USD,
    purseEstimated: true
  };
}

async function refreshLeaderboard() {
  try {
    const response = await fetch(PGA_SCOREBOARD_URL, {
      headers: {
        "User-Agent": "pga-earnings-tracker"
      }
    });
    if (!response.ok) {
      throw new Error(`Scoreboard request failed: ${response.status}`);
    }
    const data = await response.json();
    const event = data.events?.[0] || null;
    const competition = event?.competitions?.[0];
    const competitors = competition?.competitors || [];
    const eventInfo = buildEventInfo(event);
    const players = normalizeCompetitors(
      competitors,
      eventInfo || {
        statusDescription: "Status unavailable",
        isFinal: false
      },
      DEFAULT_PURSE_USD,
      payoutSchedule
    );

    leaderboardCache = {
      event: eventInfo,
      players,
      playersById: new Map(players.map((player) => [player.id, player])),
      lastUpdated: new Date().toISOString(),
      status: "ok",
      error: null
    };
    finalizeSelectionsIfNeeded();
  } catch (error) {
    console.warn("Leaderboard refresh failed:", error.message);
    if (!leaderboardCache.players.length) {
      const fallback = buildFallbackLeaderboard();
      leaderboardCache = {
        event: fallback.event,
        players: fallback.players,
        playersById: new Map(fallback.players.map((player) => [player.id, player])),
        lastUpdated: new Date().toISOString(),
        status: "fallback",
        error: error.message
      };
    } else {
      leaderboardCache.status = "error";
      leaderboardCache.error = error.message;
    }
  }
}

function finalizeSelectionsIfNeeded() {
  const event = leaderboardCache.event;
  if (!event || !event.isFinal) {
    return;
  }

  const now = new Date().toISOString();
  const remainingSelections = [];

  store.selections.forEach((selection) => {
    if (selection.eventId !== event.id) {
      remainingSelections.push(selection);
      return;
    }

    const player = leaderboardCache.playersById.get(selection.golferId);
    const finalPosition = player?.position || null;
    const finalEarnings =
      player?.finalEarnings ??
      player?.projectedEarnings ??
      estimateEarnings(finalPosition, event.purse, payoutSchedule);

    const historyItem = {
      id: selection.id,
      golferId: selection.golferId,
      golferName: selection.golferName,
      eventId: event.id,
      eventName: event.name,
      finalPosition,
      finalEarnings,
      eventEndDate: event.endDate,
      finalizedAt: now
    };

    if (!store.history.find((item) => item.id === selection.id)) {
      store.history.unshift(historyItem);
    }
  });

  store.selections = remainingSelections;
  saveStore().catch((error) => {
    console.warn("Failed to persist finalized selections:", error.message);
  });
}

function buildSelectionResponse(selection) {
  const player = leaderboardCache.playersById.get(selection.golferId);
  return {
    ...selection,
    currentPosition: player?.position || null,
    positionDisplay: player?.positionDisplay || "--",
    scoreDisplay: player?.scoreDisplay || "--",
    projectedEarnings: player?.projectedEarnings || 0,
    finalEarnings: player?.finalEarnings || null,
    event: leaderboardCache.event
  };
}

app.get("/api/status", (req, res) => {
  res.json({
    event: leaderboardCache.event,
    lastUpdated: leaderboardCache.lastUpdated,
    refreshIntervalMinutes: REFRESH_INTERVAL_MINUTES,
    dataSource: PGA_SCOREBOARD_URL,
    status: leaderboardCache.status,
    error: leaderboardCache.error
  });
});

app.get("/api/golfers", (req, res) => {
  const search = String(req.query.search || "").trim().toLowerCase();
  const limit = Number(req.query.limit || 8);
  let players = leaderboardCache.players;

  if (search) {
    players = players.filter((player) => {
      const full = player.name.toLowerCase();
      const shortName = (player.shortName || "").toLowerCase();
      return full.includes(search) || shortName.includes(search);
    });
  }

  res.json({
    players: players.slice(0, Math.max(1, limit))
  });
});

app.get("/api/selections", (req, res) => {
  const selections = store.selections.map(buildSelectionResponse);
  res.json({
    selections
  });
});

app.post("/api/selections", (req, res) => {
  const golferId = req.body?.golferId;
  if (!golferId) {
    return res.status(400).json({ error: "golferId is required" });
  }

  const event = leaderboardCache.event;
  if (!event) {
    return res.status(503).json({ error: "Event data not available yet" });
  }

  const player = leaderboardCache.playersById.get(String(golferId));
  if (!player) {
    return res.status(404).json({ error: "Golfer not found in current event" });
  }

  const alreadySaved = store.selections.find(
    (selection) =>
      selection.golferId === String(golferId) && selection.eventId === event.id
  );
  if (alreadySaved) {
    return res.json(buildSelectionResponse(alreadySaved));
  }

  const selection = {
    id: crypto.randomUUID(),
    golferId: String(golferId),
    golferName: player.name,
    eventId: event.id,
    eventName: event.name,
    createdAt: new Date().toISOString()
  };
  store.selections.push(selection);

  saveStore()
    .then(() => {
      res.status(201).json(buildSelectionResponse(selection));
    })
    .catch((error) => {
      console.warn("Failed to save selection:", error.message);
      res.status(500).json({ error: "Failed to save selection" });
    });
});

app.delete("/api/selections/:id", (req, res) => {
  const { id } = req.params;
  const index = store.selections.findIndex((item) => item.id === id);
  if (index === -1) {
    return res.status(404).json({ error: "Selection not found" });
  }
  store.selections.splice(index, 1);

  saveStore()
    .then(() => res.json({ ok: true }))
    .catch((error) => {
      console.warn("Failed to remove selection:", error.message);
      res.status(500).json({ error: "Failed to remove selection" });
    });
});

app.get("/api/history", (req, res) => {
  res.json({
    history: store.history
  });
});

app.get("/api/earnings", (req, res) => {
  const year = new Date().getFullYear();
  const total = store.history.reduce((sum, item) => {
    const dateValue = item.eventEndDate || item.finalizedAt;
    if (!dateValue) {
      return sum;
    }
    const itemYear = new Date(dateValue).getFullYear();
    return itemYear === year ? sum + (item.finalEarnings || 0) : sum;
  }, 0);

  res.json({
    year,
    total
  });
});

app.post("/api/refresh", async (req, res) => {
  await refreshLeaderboard();
  res.json({
    ok: true,
    status: leaderboardCache.status,
    lastUpdated: leaderboardCache.lastUpdated
  });
});

async function startServer() {
  store = await loadStore();
  payoutSchedule = await loadPayoutSchedule();
  await refreshLeaderboard();

  setInterval(refreshLeaderboard, REFRESH_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});
