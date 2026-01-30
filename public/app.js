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

let selectedPlayer = null;
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

function renderSearchResults(players) {
  searchResults.innerHTML = "";
  if (!players.length) {
    searchResults.innerHTML = `<div class="empty">No matching golfers.</div>`;
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

  preview.innerHTML = `
    <div class="preview-card">
      <div>
        <h3>${player.name}</h3>
        <p class="muted">Current position: ${
          player.positionDisplay || "--"
        } | Score ${player.scoreDisplay || "--"}</p>
      </div>
      <div class="preview-meta">
        <span class="badge">Projected ${formatCurrency(
          player.projectedEarnings || 0
        )}</span>
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
    await fetchJson("/api/selections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ golferId: player.id })
    });
    selectedPlayer = null;
    preview.innerHTML = "";
    searchInput.value = "";
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

    card.innerHTML = `
      <div>
        <h3>${selection.golferName}</h3>
        <p class="muted">${selection.eventName || "Current event"}</p>
      </div>
      <div class="preview-meta">
        <span>Position ${selection.positionDisplay || "--"}</span>
        <span>Score ${selection.scoreDisplay || "--"}</span>
      </div>
      <div class="preview-meta">
        <span>Projected ${formatCurrency(selection.projectedEarnings || 0)}</span>
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
      <span>${formatDate(item.finalizedAt)}</span>
    `;
    historyRows.appendChild(row);
  });
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
      const data = await fetchJson(
        `/api/golfers?search=${encodeURIComponent(query)}`
      );
      renderSearchResults(data.players || []);
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
  await loadSelections();
  await loadHistory();
  await loadTotals();
}

loadAll().catch((error) => {
  setStatusMessage(`Startup failed: ${error.message}`, true);
});
