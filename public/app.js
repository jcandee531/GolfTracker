const searchInput = document.getElementById("golfer-search");
const searchResults = document.getElementById("search-results");
const preview = document.getElementById("selection-preview");
const savedGolfers = document.getElementById("saved-golfers");
const historyRows = document.getElementById("history-rows");
const totalEarnings = document.getElementById("total-earnings");
const eventName = document.getElementById("event-name");
const eventDates = document.getElementById("event-dates");
const eventStatus = document.getElementById("event-status");
const lastUpdated = document.getElementById("last-updated");
const refreshNow = document.getElementById("refresh-now");
const statusMessage = document.getElementById("status-message");
const eventSelect = document.getElementById("event-select");
const eventMeta = document.getElementById("event-meta");

let selectedPlayer = null;
let selectedEvent = null;
let scheduleEvents = [];
let refreshTimer = null;
let refreshIntervalMinutes = 30;

function setStatusMessage(message, isError = false) {
  statusMessage.textContent = message || "";
  statusMessage.classList.toggle("error", Boolean(isError));
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString();
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function loadStatus() {
  try {
    const data = await fetchJson("/api/status");
    refreshIntervalMinutes = data.refreshIntervalMinutes || 30;

    if (data.event) {
      eventName.textContent = data.event.name || "Current PGA event";
      eventDates.textContent = `${formatDate(data.event.startDate)} - ${formatDate(
        data.event.endDate
      )}`;
      eventStatus.textContent = data.event.statusDescription || "Status unknown";
    } else {
      eventName.textContent = "Event data unavailable";
      eventDates.textContent = "";
      eventStatus.textContent = "No event";
    }

    lastUpdated.textContent = data.lastUpdated
      ? `Last updated ${formatDate(data.lastUpdated)}`
      : "Awaiting first update";

    if (data.status === "fallback") {
      setStatusMessage(
        "Using fallback data. Configure the PGA data source for live updates.",
        false
      );
    } else if (data.error) {
      setStatusMessage(`Update issue: ${data.error}`, true);
    } else {
      setStatusMessage("");
    }

    setupAutoRefresh();
  } catch (error) {
    setStatusMessage(`Status error: ${error.message}`, true);
  }
}

function setupAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  refreshTimer = setInterval(loadAll, refreshIntervalMinutes * 60 * 1000);
}

async function loadSelections() {
  const data = await fetchJson("/api/selections");
  renderSelections(data.selections || []);
}

async function loadHistory() {
  const data = await fetchJson("/api/history");
  renderHistory(data.history || []);
}

async function loadTotals() {
  const data = await fetchJson("/api/earnings");
  totalEarnings.textContent = formatCurrency(data.total || 0);
}

function renderSearchResults(players, query) {
  searchResults.innerHTML = "";
  const allowManual = selectedEvent && !selectedEvent.hasField;
  const trimmedQuery = query?.trim();

  if (allowManual && trimmedQuery) {
    const manualItem = document.createElement("div");
    manualItem.className = "search-item";
    manualItem.innerHTML = `
      <span>Use "${trimmedQuery}"</span>
      <span class="muted">Manual entry</span>
    `;
    manualItem.addEventListener("click", () =>
      selectPlayer({ id: null, name: trimmedQuery, manual: true })
    );
    searchResults.appendChild(manualItem);
  }

  if (!players.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No matching golfers.";
    searchResults.appendChild(empty);
    searchResults.classList.add("active");
    return;
  }

  players.forEach((player) => {
    const item = document.createElement("div");
    item.className = "search-item";
    item.innerHTML = `
      <span>${player.name}</span>
      <span class="muted">${player.positionDisplay || "--"}</span>
    `;
    item.addEventListener("click", () => selectPlayer(player));
    searchResults.appendChild(item);
  });
  searchResults.classList.add("active");
}

function clearSearchResults() {
  searchResults.innerHTML = "";
  searchResults.classList.remove("active");
}

function selectPlayer(player) {
  selectedPlayer = player;
  searchInput.value = player.name;
  clearSearchResults();
  renderPreview(player);
}

function renderPreview(player) {
  if (!player) {
    preview.innerHTML = "";
    return;
  }

  const finalEarnings =
    player.finalEarnings !== null && player.finalEarnings !== undefined
      ? formatCurrency(player.finalEarnings)
      : "--";
  const projectedEarnings =
    player.projectedEarnings !== null && player.projectedEarnings !== undefined
      ? formatCurrency(player.projectedEarnings)
      : "--";
  const eventLabel = selectedEvent?.name || "Current event";
  const eventStatusLabel = selectedEvent?.statusDescription || "Status unknown";

  preview.innerHTML = `
    <div class="preview-card">
      <div>
        <h3>${player.name}</h3>
        <p class="muted">${eventLabel} · ${eventStatusLabel}</p>
        <p class="muted">Position: ${
          player.positionDisplay || "--"
        } | Score ${player.scoreDisplay || "--"}</p>
      </div>
      <div class="preview-meta">
        <span class="badge">Projected ${projectedEarnings}</span>
        <span class="badge">Final ${finalEarnings}</span>
      </div>
      <button id="save-golfer">Save golfer</button>
    </div>
  `;

  const saveButton = document.getElementById("save-golfer");
  saveButton.addEventListener("click", () => saveSelection(player));
}

async function saveSelection(player) {
  try {
    if (!selectedEvent) {
      setStatusMessage("Select a tournament before saving.", true);
      return;
    }
    const golferName = player?.name || searchInput.value.trim();
    if (!golferName) {
      setStatusMessage("Enter a golfer name before saving.", true);
      return;
    }
    const payload = {
      eventId: selectedEvent.id,
      golferName
    };
    if (player?.id) {
      payload.golferId = player.id;
    }
    const response = await fetchJson("/api/selections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    selectedPlayer = null;
    preview.innerHTML = "";
    searchInput.value = "";
    setStatusMessage(
      response.type === "history"
        ? "Added to historical selections."
        : "Saved to your golfer list.",
      false
    );
    await loadSelections();
    await loadHistory();
    await loadTotals();
  } catch (error) {
    setStatusMessage(`Save failed: ${error.message}`, true);
  }
}

function renderSelections(selections) {
  savedGolfers.innerHTML = "";
  if (!selections.length) {
    savedGolfers.innerHTML = `<div class="empty">No saved golfers yet.</div>`;
    return;
  }

  selections.forEach((selection) => {
    const card = document.createElement("div");
    card.className = "golfer-card";
    const finalText =
      selection.finalEarnings !== null && selection.finalEarnings !== undefined
        ? formatCurrency(selection.finalEarnings)
        : "--";
    const eventStatus = selection.event?.statusDescription || "Status unknown";
    const eventDates = selection.event
      ? formatDateRange(selection.event.startDate, selection.event.endDate)
      : "--";
    const statusNote = selection.statusNote
      ? `<p class="muted">${selection.statusNote}</p>`
      : "";
    const projectedText =
      selection.projectedEarnings !== null &&
      selection.projectedEarnings !== undefined
        ? formatCurrency(selection.projectedEarnings)
        : "--";

    card.innerHTML = `
      <div>
        <h3>${selection.golferName}</h3>
        <p class="muted">${selection.eventName || "Event"} · ${eventStatus}</p>
        <p class="muted">${eventDates}</p>
        ${statusNote}
      </div>
      <div class="preview-meta">
        <span>Position ${selection.positionDisplay || "--"}</span>
        <span>Score ${selection.scoreDisplay || "--"}</span>
      </div>
      <div class="preview-meta">
        <span>Projected ${projectedText}</span>
        <span>Final ${finalText}</span>
      </div>
      <button class="ghost" data-id="${selection.id}">Remove</button>
    `;
    card.querySelector("button").addEventListener("click", async () => {
      await removeSelection(selection.id);
    });
    savedGolfers.appendChild(card);
  });
}

async function removeSelection(id) {
  try {
    await fetchJson(`/api/selections/${id}`, { method: "DELETE" });
    await loadSelections();
    await loadTotals();
  } catch (error) {
    setStatusMessage(`Remove failed: ${error.message}`, true);
  }
}

function renderHistory(history) {
  historyRows.innerHTML = "";
  if (!history.length) {
    historyRows.innerHTML = `<div class="empty">No historical selections yet.</div>`;
    return;
  }

  history.forEach((item) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <span>${item.golferName}</span>
      <span>${item.eventName || "--"}</span>
      <span>${item.finalPosition ? `#${item.finalPosition}` : "--"}</span>
      <span>${formatCurrency(item.finalEarnings || 0)}</span>
    `;
    historyRows.appendChild(row);
  });
}

function formatShortDate(value) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric"
  });
}

function formatDateRange(startDate, endDate) {
  if (!startDate && !endDate) {
    return "--";
  }
  return `${formatShortDate(startDate)} - ${formatShortDate(endDate)}`;
}

function eventStatusTag(event) {
  if (event.isCurrent) {
    return "Current";
  }
  if (event.isFinal) {
    return "Final";
  }
  if (event.statusState === "in") {
    return "Live";
  }
  return "Upcoming";
}

function formatEventLabel(event) {
  return `[${eventStatusTag(event)}] ${event.name} (${formatShortDate(
    event.startDate
  )})`;
}

function setSelectedEvent(event) {
  selectedEvent = event;
  selectedPlayer = null;
  preview.innerHTML = "";
  clearSearchResults();

  if (!event) {
    eventMeta.textContent = "No schedule data available.";
    return;
  }

  const fieldText = event.hasField
    ? `${event.fieldCount} golfers`
    : "Field not posted yet";
  eventMeta.textContent = `${event.statusDescription} · ${formatDateRange(
    event.startDate,
    event.endDate
  )} · ${fieldText}`;
  searchInput.placeholder = event.hasField
    ? "Search golfers by name"
    : "Type a golfer name for this tournament";
}

function renderEventOptions(events) {
  eventSelect.innerHTML = "";
  events.forEach((event) => {
    const option = document.createElement("option");
    option.value = event.id;
    option.textContent = formatEventLabel(event);
    eventSelect.appendChild(option);
  });
}

async function loadSchedule() {
  try {
    const data = await fetchJson("/api/schedule");
    const previousId = selectedEvent?.id;
    scheduleEvents = data.events || [];
    renderEventOptions(scheduleEvents);

    if (!scheduleEvents.length) {
      setSelectedEvent(null);
      return;
    }

    const selectedId = previousId || data.currentEventId;
    const selected =
      scheduleEvents.find((event) => event.id === selectedId) ||
      scheduleEvents[0];
    eventSelect.value = selected.id;
    setSelectedEvent(selected);
  } catch (error) {
    setStatusMessage(`Schedule failed: ${error.message}`, true);
  }
}

let searchTimeout;
searchInput.addEventListener("input", () => {
  const query = searchInput.value.trim();
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  if (query.length < 2) {
    clearSearchResults();
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
      if (!selectedEvent) {
        setStatusMessage("Select a tournament to search golfers.", true);
        return;
      }
      let endpoint = `/api/golfers?search=${encodeURIComponent(query)}`;
      if (!selectedEvent.isCurrent && selectedEvent.hasField) {
        endpoint = `/api/schedule/${selectedEvent.id}/golfers?search=${encodeURIComponent(
          query
        )}`;
      } else if (!selectedEvent.hasField) {
        endpoint = `/api/roster?search=${encodeURIComponent(query)}`;
      }
      const data = await fetchJson(endpoint);
      renderSearchResults(data.players || [], query);
    } catch (error) {
      setStatusMessage(`Search failed: ${error.message}`, true);
    }
  }, 250);
});

document.addEventListener("click", (event) => {
  if (!searchResults.contains(event.target) && event.target !== searchInput) {
    clearSearchResults();
  }
});

eventSelect.addEventListener("change", () => {
  const event = scheduleEvents.find((item) => item.id === eventSelect.value);
  setSelectedEvent(event || null);
});

refreshNow.addEventListener("click", async () => {
  try {
    await fetchJson("/api/refresh", { method: "POST" });
    await loadAll();
  } catch (error) {
    setStatusMessage(`Refresh failed: ${error.message}`, true);
  }
});

async function loadAll() {
  await loadStatus();
  await loadSchedule();
  await loadSelections();
  await loadHistory();
  await loadTotals();
}

loadAll().catch((error) => {
  setStatusMessage(`Startup failed: ${error.message}`, true);
});
