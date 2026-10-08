import { state } from "./state.js";

const REQUEST_TIMEOUT_MS = 15000;

export async function requestJSON(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const response = await fetch(path, {
    ...fetchOptions,
    headers: {
      "Content-Type": "application/json",
      "X-Review-Token": state.token,
      ...(fetchOptions.headers || {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json();
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
