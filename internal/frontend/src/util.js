import { FALLBACK_ROOT_FONT_SIZE } from "./constants.js";

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function rem(value) {
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return value * (Number.isFinite(rootSize) ? rootSize : FALLBACK_ROOT_FONT_SIZE);
}

export function afterNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

export function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable;
}

export function stopDiffEvents(node) {
  for (const eventName of ["click", "pointerdown", "keydown"]) {
    node.addEventListener(eventName, (event) => event.stopPropagation());
  }
}
