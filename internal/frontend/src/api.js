import { state } from "./state.js";

export async function requestJSON(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Review-Token": state.token,
      ...(options.headers || {}),
    },
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
