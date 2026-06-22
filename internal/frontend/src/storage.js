import { DIFF_STYLE_SPLIT, DIFF_STYLE_STORAGE_KEY, DIFF_STYLE_UNIFIED } from "./constants.js";

export function readStorageValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be disabled.
    return null;
  }
}

export function writeStorageValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be disabled.
  }
}

export function readSavedDiffStyle() {
  const value = readStorageValue(DIFF_STYLE_STORAGE_KEY);
  if (value === DIFF_STYLE_SPLIT || value === DIFF_STYLE_UNIFIED) {
    return value;
  }
  return DIFF_STYLE_SPLIT;
}
