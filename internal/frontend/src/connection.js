import { requestJSON } from "./api.js";
import { els, state } from "./state.js";
import { readStorageValue, removeStorageValue, writeStorageValue } from "./storage.js";

const CHECK_INTERVAL_MS = 3000;
const CHECK_TIMEOUT_MS = 3000;
const COPY_CONFIRMATION_MS = 2000;
const COMMENTS_STORAGE_KEY = `review.comments.${state.token}`;

let checkTimer;
let copyResetTimer;
let pendingCheck;
let serverId;
let commentsVersion = 0;
let needsSync = false;
let disconnected = false;

export async function connectToServer() {
  let session;
  try {
    session = await requestJSON("/api/session");
  } catch (error) {
    connectionLost();
    throw error;
  }
  state.comments = Array.isArray(session.comments) ? session.comments : [];
  serverId = session.server_id;
  const cached = readStorageValue(COMMENTS_STORAGE_KEY);
  if (cached) {
    try {
      const comments = JSON.parse(cached);
      if (Array.isArray(comments)) {
        state.comments = comments;
        needsSync = true;
      }
    } catch {
      // A damaged browser cache must not prevent opening the review.
    }
  }
  writeStorageValue(COMMENTS_STORAGE_KEY, JSON.stringify(state.comments));
  els.restartCommand.value = session.restart_command;
  els.copyRestart.addEventListener("click", copyRestartCommand);
  els.retryConnection.addEventListener("click", checkConnection);
  window.addEventListener("online", checkConnection);
  window.addEventListener("focus", checkConnection);
  window.addEventListener("pagehide", () => {
    clearTimeout(checkTimer);
    resetCopyConfirmation();
  });
  void checkConnection();
  return session;
}

export function syncComments() {
  commentsVersion += 1;
  needsSync = true;
  writeStorageValue(COMMENTS_STORAGE_KEY, JSON.stringify(state.comments));
  return checkConnection();
}

export function connectionLost() {
  if (state.completed) {
    return;
  }
  needsSync = true;
  if (disconnected) {
    return;
  }
  disconnected = true;
  els.connectionMessage.textContent = "Server connection lost.";
  resetCopyConfirmation();
  els.connectionRecovery.hidden = !els.restartCommand.value;
}

export function completeConnection() {
  clearTimeout(checkTimer);
  resetCopyConfirmation();
  removeStorageValue(COMMENTS_STORAGE_KEY);
  els.connectionRecovery.hidden = true;
}

function checkConnection() {
  clearTimeout(checkTimer);
  if (state.completed) {
    return Promise.resolve();
  }
  if (pendingCheck) {
    return pendingCheck;
  }
  pendingCheck = checkAndSync().finally(() => {
    pendingCheck = undefined;
    if (!state.completed) {
      checkTimer = setTimeout(checkConnection, CHECK_INTERVAL_MS);
    }
  });
  return pendingCheck;
}

async function checkAndSync() {
  try {
    const health = await requestJSON("/api/health", { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    needsSync ||= health.server_id !== serverId;
    // Serialize saves so an older request cannot overwrite a newer comment edit.
    while (needsSync && !state.completed) {
      const version = commentsVersion;
      await requestJSON("/api/comments", {
        method: "PUT",
        body: JSON.stringify({ comments: state.comments }),
      });
      needsSync = version !== commentsVersion;
    }
    if (!state.completed) {
      serverId = health.server_id;
      disconnected = false;
      els.connectionRecovery.hidden = true;
    }
  } catch {
    connectionLost();
  }
}

async function copyRestartCommand() {
  try {
    await navigator.clipboard.writeText(els.restartCommand.value);
    resetCopyConfirmation();
    els.copyRestart.textContent = "Copied";
    copyResetTimer = setTimeout(resetCopyConfirmation, COPY_CONFIRMATION_MS);
  } catch {
    resetCopyConfirmation();
    els.restartCommand.focus();
    els.restartCommand.select();
    els.connectionMessage.textContent = "Select and copy the command below to restart the server.";
  }
}

function resetCopyConfirmation() {
  clearTimeout(copyResetTimer);
  els.copyRestart.textContent = "Copy restart command";
}
