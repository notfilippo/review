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

// Diff lines live in Pierre's shadow roots, out of reach of querySelector.
export function queryDeep(root, selector, matches = []) {
  if (root instanceof Element) {
    if (root.matches(selector)) {
      matches.push(root);
    }
    if (root.shadowRoot) {
      queryDeep(root.shadowRoot, selector, matches);
    }
  }
  for (const child of root.children || []) {
    queryDeep(child, selector, matches);
  }
  return matches;
}

export function closestAcrossShadow(element, selector) {
  let node = element;
  while (node) {
    const match = node.closest(selector);
    if (match) {
      return match;
    }
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : undefined;
  }
  return undefined;
}
