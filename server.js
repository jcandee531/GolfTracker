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
const SCHEDULE_REFRESH_MINUTES = Number(
  process.env.SCHEDULE_REFRESH_MINUTES || 360
);
const SCHEDULE_REFRESH_MS = Math.max(10, SCHEDULE_REFRESH_MINUTES) * 60 * 1000;

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
let storeWritePromise = Promise.resolve();

let leaderboardCache = {
  event: null,
  players: [],
  playersById: new Map(),
  lastUpdated: null,
  status: "loading",
  error: null
};

let scheduleCache = {
  year: null,
  events: [],
  eventsById: new Map(),
  roster: [],
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

function buildScoreboardUrl(params = {}) {
  const url = new URL(PGA_SCOREBOARD_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });
  return url.toString();
}

function getCurrentYear() {
  return new Date().getFullYear();
}

function normalizeEventName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const TWO_ENTRY_EVENT_TOKENS = [
  "playerschampionship",
  "theplayerschampionship",
  "masters",
  "themasters",
  "masterstournament",
  "usopen",
  "theusopen",
  "pgachampionship",
  "thepgachampionship",
  "britishopen",
  "theopenchampionship",
  "openchampionship"
];

function getEventEntryLimit(eventName) {
  const normalized = normalizeEventName(eventName);
  if (!normalized) {
    return 1;
  }
  const isMajor = TWO_ENTRY_EVENT_TOKENS.some((token) =>
    normalized.includes(token)
  );
  return isMajor ? 2 : 1;
}

function countEntriesForEvent(eventId, eventName) {
  const normalizedName = normalizeEventName(eventName);
  const eventMatches = (item) => {
    if (eventId && item.eventId && item.eventId === eventId) {
      return true;
    }
    if (normalizedName && item.eventName) {
      return normalizeEventName(item.eventName) === normalizedName;
    }
    return false;
  };

  const selectionCount = store.selections.filter(eventMatches).length;
  const historyCount = store.history.filter(eventMatches).length;
  return selectionCount + historyCount;
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

function normalizeScheduleCompetitors(competitors, eventInfo, purse, schedule) {
  const players = (competitors || [])
    .map((competitor) => {
      const position = safeNumber(competitor.order);
      const scoreDisplay = competitor.score || "E";
      const athlete = competitor.athlete || {};
      return {
        id: competitor.id,
        name:
          athlete.displayName ||
          athlete.fullName ||
          competitor.displayName ||
          "Unknown",
        shortName: athlete.shortName || competitor.shortName || null,
        country: athlete.flag?.alt || null,
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

function buildEventInfoFromSchedule(eventData) {
  if (!eventData) {
    return null;
  }
  return {
    id: eventData.id,
    name: eventData.name,
    shortName: eventData.shortName,
    startDate: eventData.startDate,
    endDate: eventData.endDate,
    statusDescription: eventData.statusDescription,
    statusState: eventData.statusState,
    isFinal: eventData.isFinal,
    entryLimit: eventData.entryLimit ?? getEventEntryLimit(eventData.name),
    purse: DEFAULT_PURSE_USD,
    purseEstimated: true
  };
}

function findPlayerByName(players, golferName) {
  if (!players || !golferName) {
    return null;
  }
  const lowered = golferName.trim().toLowerCase();
  return players.find(
    (player) => player.name.toLowerCase() === lowered
  );
}

function findSchedulePlayer(eventData, golferId, golferName) {
  if (!eventData) {
    return null;
  }
  if (golferId && eventData.playersById?.has(golferId)) {
    return eventData.playersById.get(golferId);
  }
  if (golferName) {
    const match = findPlayerByName(eventData.players, golferName);
    if (match) {
      return match;
    }
  }
  return null;
}

function buildHistoryKey(item) {
  return [
    (item.golferId || item.golferName || "").toLowerCase(),
    (item.eventId || item.eventName || "").toLowerCase(),
    item.eventEndDate || ""
  ].join("|");
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

function queueSaveStore() {
  storeWritePromise = storeWritePromise
    .catch(() => null)
    .then(() => saveStore());
  return storeWritePromise;
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

function buildScheduleEvent(event) {
  if (!event) {
    return null;
  }
  const status = formatEventStatus(event);
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors || [];
  const eventInfo = {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    startDate: event.date,
    endDate: event.endDate,
    statusDescription: status.description || "Status unavailable",
    statusState: status.state || "unknown",
    isFinal: Boolean(status.completed),
    hasField: competitors.length > 0,
    fieldCount: competitors.length,
    entryLimit: getEventEntryLimit(event.name)
  };

  const players = normalizeScheduleCompetitors(
    competitors,
    eventInfo,
    DEFAULT_PURSE_USD,
    payoutSchedule
  );

  const playersById = new Map();
  players.forEach((player) => {
    if (player.id) {
      playersById.set(player.id, player);
    }
  });

  return {
    ...eventInfo,
    players,
    playersById
  };
}

async function refreshSchedule(year = getCurrentYear()) {
  try {
    const url = buildScoreboardUrl({
      dates: `${year}0101-${year}1231`
    });
    const response = await fetch(url, {
      headers: {
        "User-Agent": "pga-earnings-tracker"
      }
    });
    if (!response.ok) {
      throw new Error(`Schedule request failed: ${response.status}`);
    }
    const data = await response.json();
    const events = (data.events || [])
      .map(buildScheduleEvent)
      .filter(Boolean)
      .sort(
        (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime()
      );

    const eventsById = new Map();
    const rosterMap = new Map();

    events.forEach((event) => {
      eventsById.set(event.id, event);
      event.players.forEach((player) => {
        const key = player.id || player.name.toLowerCase();
        if (!rosterMap.has(key)) {
          rosterMap.set(key, {
            id: player.id || null,
            name: player.name,
            shortName: player.shortName || null
          });
        }
      });
    });

    scheduleCache = {
      year,
      events,
      eventsById,
      roster: Array.from(rosterMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
      lastUpdated: new Date().toISOString(),
      status: "ok",
      error: null
    };
    finalizeSelectionsFromSchedule();
  } catch (error) {
    console.warn("Schedule refresh failed:", error.message);
    if (!scheduleCache.events.length) {
      scheduleCache = {
        year,
        events: [],
        eventsById: new Map(),
        roster: [],
        lastUpdated: new Date().toISOString(),
        status: "error",
        error: error.message
      };
    } else {
      scheduleCache.status = "error";
      scheduleCache.error = error.message;
    }
  }
}

async function ensureSchedule(year = getCurrentYear()) {
  const lastUpdated = scheduleCache.lastUpdated
    ? new Date(scheduleCache.lastUpdated).getTime()
    : 0;
  const isStale =
    !lastUpdated || Date.now() - lastUpdated > SCHEDULE_REFRESH_MS;
  if (scheduleCache.year !== year || isStale) {
    await refreshSchedule(year);
  }
}

function finalizeSelectionsIfNeeded() {
  const event = leaderboardCache.event;
  if (!event || !event.isFinal) {
    return;
  }

  const now = new Date().toISOString();
  const remainingSelections = [];
  const existingKeys = new Set(store.history.map(buildHistoryKey));

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

    const historyKey = buildHistoryKey(historyItem);
    if (!existingKeys.has(historyKey)) {
      store.history.unshift(historyItem);
      existingKeys.add(historyKey);
    }
  });

  store.selections = remainingSelections;
  queueSaveStore().catch((error) => {
    console.warn("Failed to persist finalized selections:", error.message);
  });
}

function finalizeSelectionsFromSchedule() {
  if (!scheduleCache.eventsById.size || !store.selections.length) {
    return;
  }
  const existingKeys = new Set(store.history.map(buildHistoryKey));
  const remainingSelections = [];
  const now = new Date().toISOString();

  store.selections.forEach((selection) => {
    const eventData = scheduleCache.eventsById.get(selection.eventId);
    if (!eventData || !eventData.isFinal) {
      remainingSelections.push(selection);
      return;
    }

    const player = findSchedulePlayer(
      eventData,
      selection.golferId,
      selection.golferName
    );
    if (!player || !player.position) {
      remainingSelections.push(selection);
      return;
    }

    const historyItem = {
      id: selection.id,
      golferId: selection.golferId || player.id || null,
      golferName: selection.golferName || player.name,
      eventId: eventData.id,
      eventName: eventData.name,
      finalPosition: player.position,
      finalEarnings: estimateEarnings(
        player.position,
        DEFAULT_PURSE_USD,
        payoutSchedule
      ),
      eventEndDate: eventData.endDate,
      finalizedAt: now
    };

    const historyKey = buildHistoryKey(historyItem);
    if (!existingKeys.has(historyKey)) {
      store.history.unshift(historyItem);
      existingKeys.add(historyKey);
    }
  });

  store.selections = remainingSelections;
  queueSaveStore().catch((error) => {
    console.warn("Failed to persist schedule selections:", error.message);
  });
}

function buildSelectionResponse(selection) {
  const currentEvent = leaderboardCache.event;
  let player = null;
  let eventInfo = null;

  if (currentEvent && selection.eventId === currentEvent.id) {
    player = leaderboardCache.playersById.get(selection.golferId);
    eventInfo = currentEvent;
  } else {
    const scheduleEvent = scheduleCache.eventsById.get(selection.eventId);
    player = findSchedulePlayer(
      scheduleEvent,
      selection.golferId,
      selection.golferName
    );
    eventInfo = buildEventInfoFromSchedule(scheduleEvent);
  }

  const statusNote =
    eventInfo?.isFinal && !player ? "Final results unavailable" : null;

  return {
    ...selection,
    currentPosition: player?.position || null,
    positionDisplay: player?.positionDisplay || "--",
    scoreDisplay: player?.scoreDisplay || "--",
    projectedEarnings: player ? player.projectedEarnings : null,
    finalEarnings: player ? player.finalEarnings : null,
    event: eventInfo,
    statusNote
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

app.get("/api/schedule", async (req, res) => {
  const year = Number(req.query.year || getCurrentYear());
  await ensureSchedule(year);
  const currentEventId = leaderboardCache.event?.id || null;

  const events = scheduleCache.events.map((event) => ({
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    startDate: event.startDate,
    endDate: event.endDate,
    statusDescription: event.statusDescription,
    statusState: event.statusState,
    isFinal: event.isFinal,
    hasField: event.hasField,
    fieldCount: event.fieldCount,
    entryLimit: event.entryLimit,
    isCurrent: currentEventId === event.id
  }));

  res.json({
    year,
    currentEventId,
    events,
    lastUpdated: scheduleCache.lastUpdated,
    status: scheduleCache.status,
    error: scheduleCache.error
  });
});

app.get("/api/schedule/:eventId/golfers", async (req, res) => {
  const year = Number(req.query.year || getCurrentYear());
  await ensureSchedule(year);
  const { eventId } = req.params;
  const eventData = scheduleCache.eventsById.get(eventId);
  if (!eventData) {
    return res.status(404).json({ error: "Tournament not found in schedule" });
  }

  const search = String(req.query.search || "").trim().toLowerCase();
  const limit = Number(req.query.limit || 8);
  let players = eventData.players;

  if (search) {
    players = players.filter((player) => {
      const full = player.name.toLowerCase();
      const shortName = (player.shortName || "").toLowerCase();
      return full.includes(search) || shortName.includes(search);
    });
  }

  res.json({
    event: {
      id: eventData.id,
      name: eventData.name,
      startDate: eventData.startDate,
      endDate: eventData.endDate,
      statusDescription: eventData.statusDescription,
      statusState: eventData.statusState,
      isFinal: eventData.isFinal,
      hasField: eventData.hasField,
      fieldCount: eventData.fieldCount,
      entryLimit: eventData.entryLimit
    },
    players: players.slice(0, Math.max(1, limit))
  });
});

app.get("/api/roster", async (req, res) => {
  const year = Number(req.query.year || getCurrentYear());
  await ensureSchedule(year);
  const search = String(req.query.search || "").trim().toLowerCase();
  const limit = Number(req.query.limit || 12);
  let players = scheduleCache.roster;

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

app.post("/api/selections", async (req, res) => {
  const golferId = req.body?.golferId ? String(req.body.golferId) : null;
  const golferName = req.body?.golferName
    ? String(req.body.golferName).trim()
    : null;
  const requestedEventId = req.body?.eventId
    ? String(req.body.eventId)
    : null;

  const currentEvent = leaderboardCache.event;
  const eventId = requestedEventId || currentEvent?.id;

  if (!eventId) {
    return res.status(400).json({ error: "eventId is required" });
  }

  await ensureSchedule(getCurrentYear());

  let eventInfo = null;
  let scheduleEvent = null;

  if (currentEvent && eventId === currentEvent.id) {
    eventInfo = currentEvent;
  } else {
    scheduleEvent = scheduleCache.eventsById.get(eventId);
    if (!scheduleEvent) {
      return res
        .status(404)
        .json({ error: "Tournament not found in schedule" });
    }
    eventInfo = buildEventInfoFromSchedule(scheduleEvent);
  }

  let player = null;
  if (currentEvent && eventId === currentEvent.id) {
    if (golferId) {
      player = leaderboardCache.playersById.get(golferId);
    }
    if (!player && golferName) {
      player = findPlayerByName(leaderboardCache.players, golferName);
    }
    if (!player) {
      return res.status(404).json({ error: "Golfer not found in current event" });
    }
  } else if (scheduleEvent) {
    player = findSchedulePlayer(scheduleEvent, golferId, golferName);
    if (!player && scheduleEvent.hasField) {
      return res
        .status(404)
        .json({ error: "Golfer not found in selected event" });
    }
  }

  const resolvedName = player?.name || golferName;
  if (!resolvedName) {
    return res.status(400).json({ error: "golferName is required" });
  }

  const entryLimit = getEventEntryLimit(eventInfo?.name);

  if (eventInfo?.isFinal) {
    if (!player || !player.position) {
      return res.status(400).json({
        error: "Final results are not available for that golfer"
      });
    }

    const historyItem = {
      id: crypto.randomUUID(),
      golferId: player.id || golferId || null,
      golferName: resolvedName,
      eventId: eventInfo.id,
      eventName: eventInfo.name,
      finalPosition: player.position,
      finalEarnings: estimateEarnings(
        player.position,
        eventInfo.purse || DEFAULT_PURSE_USD,
        payoutSchedule
      ),
      eventEndDate: eventInfo.endDate,
      finalizedAt: new Date().toISOString()
    };
    const historyKey = buildHistoryKey(historyItem);
    const existingHistory = store.history.find(
      (item) => buildHistoryKey(item) === historyKey
    );
    if (existingHistory) {
      return res.json({ type: "history", item: existingHistory });
    }

    const existingCount = countEntriesForEvent(eventInfo.id, eventInfo.name);
    if (existingCount >= entryLimit) {
      return res.status(400).json({
        error: `Entry limit reached for ${eventInfo.name}`
      });
    }

    store.history.unshift(historyItem);
    return queueSaveStore()
      .then(() => res.status(201).json({ type: "history", item: historyItem }))
      .catch((error) => {
        console.warn("Failed to save history:", error.message);
        res.status(500).json({ error: "Failed to save history" });
      });
  }

  const alreadySaved = store.selections.find((selection) => {
    if (selection.eventId !== eventId) {
      return false;
    }
    if (golferId && selection.golferId === golferId) {
      return true;
    }
    return (
      selection.golferName?.toLowerCase() === resolvedName.toLowerCase()
    );
  });

  if (alreadySaved) {
    return res.json({ type: "selection", selection: buildSelectionResponse(alreadySaved) });
  }

  const existingCount = countEntriesForEvent(eventInfo.id, eventInfo.name);
  if (existingCount >= entryLimit) {
    return res.status(400).json({
      error: `Entry limit reached for ${eventInfo.name}`
    });
  }

  const selection = {
    id: crypto.randomUUID(),
    golferId: player?.id || golferId || null,
    golferName: resolvedName,
    eventId: eventInfo.id,
    eventName: eventInfo.name,
    createdAt: new Date().toISOString()
  };
  store.selections.push(selection);

  queueSaveStore()
    .then(() => {
      res.status(201).json({ type: "selection", selection: buildSelectionResponse(selection) });
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

  queueSaveStore()
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
  await refreshSchedule(getCurrentYear());
  await refreshLeaderboard();

  setInterval(refreshLeaderboard, REFRESH_INTERVAL_MS);
  setInterval(() => refreshSchedule(getCurrentYear()), SCHEDULE_REFRESH_MS);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});
