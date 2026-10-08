import { state } from "./state.js";

const REQUEST_TIMEOUT_MS = 15000;

export async function requestJSON(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Review-Token": state.token,
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json();
}

// Reads an NDJSON response. Long-running streams have no timeout; callers stop
// them through `signal`.
export async function streamJSONLines(path, { signal, onEvent }) {
  const response = await fetch(path, {
    headers: { "X-Review-Token": state.token },
    signal,
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffered += value;
    const lines = buffered.split("\n");
    buffered = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        onEvent(JSON.parse(line));
      }
    }
  }
  if (buffered.trim()) {
    onEvent(JSON.parse(buffered));
  }
}

async function responseErrorMessage(response) {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    return body.error || message;
  } catch {
    return message;
  }
}
