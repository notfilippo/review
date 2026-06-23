import { MAX_SEARCH_MATCHES } from "./constants.js";
import { renderDiffs, setCurrentPath } from "./diff-view.js";
import { setIconButton } from "./icons.js";
import { els, state } from "./state.js";
import { afterNextPaint, stopDiffEvents } from "./util.js";

const LINE_OUTLINE_SHADOW = "inset 0 0 0 2px var(--accent-2)";
const LINE_OUTLINE_BACKGROUND = "color-mix(in srgb, var(--accent-2) 16%, transparent)";
const CURRENT_LINE_OUTLINE_BACKGROUND = "color-mix(in srgb, var(--accent-2) 28%, transparent)";
const TEXT_HIGHLIGHT_BACKGROUND = "color-mix(in srgb, var(--accent-2) 28%, transparent)";
const CURRENT_TEXT_HIGHLIGHT_BACKGROUND = "color-mix(in srgb, var(--accent-2) 48%, transparent)";
const SEARCH_SIDE_SELECTOR = "[data-additions], [data-deletions], [data-unified]";
const DEFAULT_COLLAPSED_CONTEXT_THRESHOLD = 1;

let renderedLineHighlights = [];
let highlightMarkers = [];
let diffObserver;
let indexedExpandedContext = "";

export function setupSearch() {
  setIconButton(els.searchToggle, "Search", "Search diff");
  setIconButton(els.searchPrev, "ArrowUp", "Previous search result");
  setIconButton(els.searchNext, "ArrowDown", "Next search result");
  setIconButton(els.searchClose, "X", "Close search");
  stopDiffEvents(els.codeSearch);

  els.searchInput.addEventListener("input", () => {
    setSearchQuery(els.searchInput.value);
  });
  els.searchInput.addEventListener("keydown", handleSearchInputKeyDown);
  els.searchToggle.addEventListener("click", () => {
    setSearchOpen(!state.search.open);
  });
  els.searchPrev.addEventListener("click", () => moveSearch(-1));
  els.searchNext.addEventListener("click", () => moveSearch(1));
  els.searchClose.addEventListener("click", () => setSearchOpen(false));
  observeDiffMutations();
  syncSearchControls();
}

function handleSearchShortcut(event) {
  if (event.defaultPrevented || !isFindShortcut(event)) {
    return false;
  }
  const selectedText = selectedSearchText();
  event.preventDefault();
  setSearchOpen(true);
  if (selectedText) {
    els.searchInput.value = selectedText;
    setSearchQuery(selectedText);
  }
  return true;
}

export function handleSearchKey(event) {
  if (handleSearchShortcut(event)) {
    return true;
  }
  if (event.defaultPrevented || event.key !== "Escape" || !state.search.open) {
    return false;
  }

  event.preventDefault();
  if (state.search.query.length > 0) {
    els.searchInput.value = "";
    setSearchQuery("");
  } else {
    setSearchOpen(false);
  }
  return true;
}

export function refreshSearchResults() {
  if (state.search.query.length === 0) {
    syncSearchControls();
    return;
  }
  setSearchQuery(state.search.query, { preserveCurrent: true });
}

function handleSearchInputKeyDown(event) {
  if (isFindShortcut(event)) {
    event.preventDefault();
    focusSearchInput();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    moveSearch(event.shiftKey ? -1 : 1);
    return;
  }
  if (event.key === "Escape") {
    if (els.searchInput.value.length > 0) {
      event.preventDefault();
      els.searchInput.value = "";
      setSearchQuery("");
      return;
    }
    event.preventDefault();
    setSearchOpen(false);
  }
}

function isFindShortcut(event) {
  const key = event.key.toLowerCase();
  return (event.metaKey || event.ctrlKey) && !event.altKey && key === "f";
}

function focusSearchInput() {
  els.searchInput.focus();
  els.searchInput.select();
}

function selectedSearchText() {
  for (const selection of pageSelections()) {
    const text = normalizeSelectedText(selection?.toString());
    if (text) {
      return text;
    }
  }
  return selectedRenderedLineText();
}

function* pageSelections() {
  yield window.getSelection?.();
  yield document.getSelection?.();
  for (const root of openShadowRoots(els.diff)) {
    yield root.getSelection?.();
  }
}

function* openShadowRoots(node) {
  if (!(node instanceof Element)) {
    return;
  }
  if (node.shadowRoot) {
    yield node.shadowRoot;
    for (const child of node.shadowRoot.querySelectorAll("*")) {
      yield* openShadowRoots(child);
    }
  }
  for (const child of node.children) {
    yield* openShadowRoots(child);
  }
}

function selectedRenderedLineText() {
  const lines = queryDeep(els.diff, "[data-line][data-selected-line]")
    .map((element) => normalizeSelectedText(element.textContent))
    .filter(Boolean);
  return lines.join("\n").trim();
}

function normalizeSelectedText(text) {
  return String(text || "").trim();
}

function setSearchOpen(open) {
  state.search.open = open;
  syncSearchControls();
  if (open) {
    focusSearchInput();
    scheduleCurrentSearchHighlight();
  } else {
    els.searchInput.blur();
    clearRenderedSearchHighlight();
  }
}

function setSearchQuery(query, options = {}) {
  const { jump = true, preserveCurrent = false } = options;
  const previous = preserveCurrent ? currentSearchMatch() : undefined;
  state.search.query = query;
  clearRenderedSearchHighlight();

  if (query.length === 0) {
    state.search.matches = [];
    state.search.currentIndex = -1;
    state.search.truncated = false;
    indexedExpandedContext = "";
    syncSearchControls();
    return;
  }

  const result = collectMatches(query);
  state.search.matches = result.matches;
  state.search.currentIndex = nextCurrentSearchIndex(result.matches, previous);
  state.search.truncated = result.truncated;
  indexedExpandedContext = expandedContextSignature();
  syncSearchControls();
  if (jump) {
    jumpToCurrentSearchMatch();
  } else {
    scheduleCurrentSearchHighlight();
  }
}

function nextCurrentSearchIndex(matches, previous) {
  if (matches.length === 0) {
    return -1;
  }
  if (!previous) {
    return 0;
  }
  const index = matches.findIndex((match) => sameSearchMatch(match, previous));
  return index === -1 ? 0 : index;
}

function sameSearchMatch(left, right) {
  return left.path === right.path
    && left.side === right.side
    && left.lineNumber === right.lineNumber
    && left.startColumn === right.startColumn
    && left.endColumn === right.endColumn;
}

function moveSearch(delta) {
  const count = state.search.matches.length;
  if (count === 0) {
    syncSearchControls();
    return;
  }
  state.search.currentIndex = nextSearchIndex(delta, count);
  syncSearchControls();
  jumpToCurrentSearchMatch();
}

function nextSearchIndex(delta, count) {
  if (state.search.currentIndex < 0) {
    return delta < 0 ? count - 1 : 0;
  }
  return (state.search.currentIndex + delta + count) % count;
}

function jumpToCurrentSearchMatch() {
  const match = currentSearchMatch();
  if (!match || !state.codeView) {
    clearRenderedSearchHighlight();
    return;
  }

  if (state.collapsedFiles.has(match.path)) {
    state.collapsedFiles.delete(match.path);
    renderDiffs();
  }

  if (match.hidden && expandHiddenSearchMatch(match)) {
    setSearchQuery(state.search.query, { preserveCurrent: true });
    return;
  }

  setCurrentPath(match.path, { scrollDiff: false, selectTree: true });
  state.codeView.scrollTo({
    type: "line",
    id: match.path,
    lineNumber: match.lineNumber,
    side: match.side,
    align: "center",
    behavior: "instant",
  });
  scheduleCurrentSearchHighlight();
}

function currentSearchMatch() {
  return state.search.matches[state.search.currentIndex];
}

function expandHiddenSearchMatch(match) {
  if (match.expandIndex == null || !match.expandDirection || !match.expandLineCount) {
    return false;
  }
  const item = state.codeView?.idToItem?.get(match.path);
  const expandHunk = item?.instance?.expandHunk;
  if (typeof expandHunk !== "function") {
    return false;
  }
  expandHunk(match.expandIndex, match.expandDirection, match.expandLineCount);
  return true;
}

function collectMatches(query) {
  const needle = query.toLowerCase();
  const matches = [];

  for (const file of state.files) {
    for (const line of searchLinesForFile(file)) {
      const haystack = line.text.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        matches.push({
          ...line,
          startColumn: index,
          endColumn: index + query.length,
        });
        if (matches.length >= MAX_SEARCH_MATCHES) {
          return { matches, truncated: true };
        }
        index = haystack.indexOf(needle, index + query.length);
      }
    }
  }

  return { matches, truncated: false };
}

function* searchLinesForFile(file) {
  const seen = new Set();
  let hasHunkLines = false;
  const expandedContext = expandedContextForFile(file);
  for (const [hunkIndex, hunk] of (file.hunks || []).entries()) {
    let deletionLine = hunk.deletionStart;
    let additionLine = hunk.additionStart;

    yield* searchLeadingContext(file, hunk, hunkIndex, expandedContext, seen);

    for (const content of hunk.hunkContent || []) {
      if (content.type === "context") {
        hasHunkLines ||= content.lines > 0;
        yield* searchLineRange(
          file,
          "additions",
          additionLine,
          file.additionLines,
          content.additionLineIndex,
          content.lines,
          seen,
        );
        deletionLine += content.lines;
        additionLine += content.lines;
      } else if (content.type === "change") {
        hasHunkLines ||= content.deletions > 0 || content.additions > 0;
        yield* searchLineRange(
          file,
          "deletions",
          deletionLine,
          file.deletionLines,
          content.deletionLineIndex,
          content.deletions,
          seen,
        );
        yield* searchLineRange(
          file,
          "additions",
          additionLine,
          file.additionLines,
          content.additionLineIndex,
          content.additions,
          seen,
        );
        deletionLine += content.deletions;
        additionLine += content.additions;
      }
    }
  }

  yield* searchTrailingContext(file, expandedContext, seen);

  if (hasHunkLines) {
    return;
  }

  const hasAdditions = hasSearchableLines(file.additionLines);
  const lines = hasAdditions ? file.additionLines : file.deletionLines || [];
  const side = hasAdditions ? "additions" : "deletions";
  yield* searchSideLines(file, side, lines, seen);
}

function hasSearchableLines(lines) {
  return lines?.length > 0;
}

function expandedContextForFile(file) {
  if (file.isPartial !== false) {
    return undefined;
  }
  const item = state.codeView?.idToItem?.get(file.reviewId);
  const instance = item?.instance;
  return {
    expandedHunks: instance?.options?.expandUnchanged === true
      ? true
      : instance?.hunksRenderer?.getExpandedHunksMap?.(),
    collapsedContextThreshold: instance?.options?.collapsedContextThreshold
      ?? DEFAULT_COLLAPSED_CONTEXT_THRESHOLD,
  };
}

function expandedContextSignature() {
  const fileSignatures = [];
  for (const file of state.files) {
    const expandedContext = expandedContextForFile(file);
    if (!expandedContext) {
      continue;
    }
    fileSignatures.push([
      file.reviewId,
      expandedContext.collapsedContextThreshold,
      expandedHunksSignature(expandedContext.expandedHunks),
    ].join(":"));
  }
  return fileSignatures.join("|");
}

function expandedHunksSignature(expandedHunks) {
  if (expandedHunks === true) {
    return "*";
  }
  return [...(expandedHunks || [])]
    .map(([hunkIndex, region]) => [
      hunkIndex,
      region?.fromStart || 0,
      region?.fromEnd || 0,
    ].join(","))
    .sort()
    .join(";");
}

function* searchLeadingContext(file, hunk, hunkIndex, expandedContext, seen) {
  if (!expandedContext) {
    return;
  }
  const rangeSize = Math.max(hunk.collapsedBefore || 0, 0);
  const region = expandedRegion(rangeSize, hunkIndex, expandedContext);
  const startLine = hunk.additionStart - rangeSize;
  const sourceIndex = hunk.additionLineIndex - rangeSize;

  yield* searchLineRange(
    file,
    "additions",
    startLine,
    file.additionLines,
    sourceIndex,
    region.fromStart,
    seen,
  );

  const hiddenCount = rangeSize - region.fromStart - region.fromEnd;
  const hiddenOptions = hiddenLineOptionsFor(hiddenRangeExpansion(
    hunkIndex,
    rangeSize,
    region.fromStart,
    region.fromEnd,
    hunkIndex === 0 ? "down" : undefined,
  ));
  yield* searchLineRange(
    file,
    "additions",
    startLine + region.fromStart,
    file.additionLines,
    sourceIndex + region.fromStart,
    hiddenCount,
    seen,
    hiddenOptions,
  );

  yield* searchLineRange(
    file,
    "additions",
    hunk.additionStart - region.fromEnd,
    file.additionLines,
    hunk.additionLineIndex - region.fromEnd,
    region.fromEnd,
    seen,
  );
}

function* searchTrailingContext(file, expandedContext, seen) {
  if (!expandedContext) {
    return;
  }
  const finalHunk = file.hunks?.at(-1);
  if (!finalHunk || !hasSearchableLines(file.additionLines) || !hasSearchableLines(file.deletionLines)) {
    return;
  }
  const rangeSize = trailingContextRangeSize(file, finalHunk);
  const expandedLines = trailingExpandedCount(rangeSize, file.hunks.length, expandedContext);
  const startLine = finalHunk.additionStart + finalHunk.additionCount;
  const sourceIndex = finalHunk.additionLineIndex + finalHunk.additionCount;

  yield* searchLineRange(
    file,
    "additions",
    startLine,
    file.additionLines,
    sourceIndex,
    expandedLines,
    seen,
  );
  const hiddenOptions = hiddenLineOptionsFor(hiddenRangeExpansion(
    file.hunks.length,
    rangeSize,
    expandedLines,
    0,
    "up",
  ));
  yield* searchLineRange(
    file,
    "additions",
    startLine + expandedLines,
    file.additionLines,
    sourceIndex + expandedLines,
    rangeSize - expandedLines,
    seen,
    hiddenOptions,
  );
}

function trailingContextRangeSize(file, finalHunk) {
  const additionRemaining = file.additionLines.length
    - (finalHunk.additionLineIndex + finalHunk.additionCount);
  const deletionRemaining = file.deletionLines.length
    - (finalHunk.deletionLineIndex + finalHunk.deletionCount);
  return Math.max(Math.min(additionRemaining, deletionRemaining), 0);
}

function trailingExpandedCount(rangeSize, hunkIndex, expandedContext) {
  const normalizedRangeSize = Math.max(rangeSize, 0);
  if (normalizedRangeSize === 0) {
    return 0;
  }
  if (
    expandedContext.expandedHunks === true
    || normalizedRangeSize <= expandedContext.collapsedContextThreshold
  ) {
    return normalizedRangeSize;
  }
  return clampExpandedCount(
    expandedContext.expandedHunks?.get(hunkIndex)?.fromStart,
    normalizedRangeSize,
  );
}

function expandedRegion(rangeSize, hunkIndex, expandedContext) {
  const normalizedRangeSize = Math.max(rangeSize, 0);
  if (normalizedRangeSize === 0) {
    return { fromStart: 0, fromEnd: 0 };
  }
  if (
    expandedContext.expandedHunks === true
    || normalizedRangeSize <= expandedContext.collapsedContextThreshold
  ) {
    return { fromStart: normalizedRangeSize, fromEnd: 0 };
  }

  const region = expandedContext.expandedHunks?.get(hunkIndex);
  const fromStart = clampExpandedCount(region?.fromStart, normalizedRangeSize);
  const fromEnd = clampExpandedCount(region?.fromEnd, normalizedRangeSize);
  if (fromStart + fromEnd >= normalizedRangeSize) {
    return { fromStart: normalizedRangeSize, fromEnd: 0 };
  }
  return { fromStart, fromEnd };
}

function clampExpandedCount(value, rangeSize) {
  return Math.min(Math.max(value || 0, 0), rangeSize);
}

function* searchSideLines(file, side, lines, seen) {
  for (let index = 0; index < (lines?.length || 0); index += 1) {
    yield* searchLineOnce(file, side, index + 1, lines[index], seen);
  }
}

function* searchLineRange(
  file,
  side,
  startLine,
  sourceLines,
  sourceIndex,
  count,
  seen,
  optionsForOffset = emptyLineOptions,
) {
  for (let offset = 0; offset < count; offset += 1) {
    yield* searchLineOnce(
      file,
      side,
      startLine + offset,
      sourceLines?.[sourceIndex + offset],
      seen,
      optionsForOffset(offset),
    );
  }
}

function emptyLineOptions() {
  return undefined;
}

function hiddenRangeExpansion(expandIndex, rangeSize, fromStart, fromEnd, direction) {
  return {
    expandIndex,
    direction,
    rangeSize,
    fromStart,
    fromEnd,
  };
}

function hiddenLineOptionsFor(expansion) {
  return (offset) => {
    const absoluteOffset = expansion.fromStart + offset;
    const fromStartLineCount = absoluteOffset + 1;
    const fromEndLineCount = expansion.rangeSize - absoluteOffset;
    const fromStartExpansion = Math.max(fromStartLineCount - expansion.fromStart, 1);
    const fromEndExpansion = Math.max(fromEndLineCount - expansion.fromEnd, 1);
    const expandDirection = expansion.direction
      ?? (fromStartExpansion <= fromEndExpansion ? "up" : "down");
    return {
      hidden: true,
      expandIndex: expansion.expandIndex,
      expandDirection,
      expandLineCount: expandDirection === "up" ? fromStartExpansion : fromEndExpansion,
    };
  };
}

function* searchLineOnce(file, side, lineNumber, text, seen, options = {}) {
  const key = `${side}:${lineNumber}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  yield searchLine(file, side, lineNumber, text, options);
}

function searchLine(file, side, lineNumber, text, options = {}) {
  return {
    path: file.reviewId,
    fileName: file.name,
    side,
    lineNumber,
    text: trimLineEnding(String(text ?? "")),
    ...options,
  };
}

function trimLineEnding(text) {
  return text.replace(/\r?\n$/, "");
}

function syncSearchControls() {
  const count = state.search.matches.length;
  const hasMatches = count > 0;
  const current = currentSearchMatch();

  els.codeSearch.dataset.open = state.search.open ? "true" : "false";
  els.searchToggle.setAttribute("aria-pressed", String(state.search.open));
  els.searchPrev.disabled = !hasMatches;
  els.searchNext.disabled = !hasMatches;
  els.searchCount.textContent = searchCountText();
  els.searchCount.title = current ? `${current.fileName}:${current.lineNumber}` : "";
}

function searchCountText() {
  if (state.search.query.length === 0) {
    return "";
  }
  if (state.search.matches.length === 0) {
    return "0/0";
  }
  const total = `${state.search.matches.length}${state.search.truncated ? "+" : ""}`;
  return `${state.search.currentIndex + 1}/${total}`;
}

function scheduleCurrentSearchHighlight() {
  afterNextPaint().then(applyCurrentSearchHighlight);
}

function applyCurrentSearchHighlight() {
  if (!state.search.open) {
    clearRenderedSearchHighlight();
    return;
  }
  const current = currentSearchMatch();
  if (!current) {
    clearRenderedSearchHighlight();
    return;
  }

  const nextHighlight = nextSearchHighlight(current);
  if (!nextHighlight) {
    clearRenderedSearchHighlight();
    return;
  }

  updateRenderedSearchHighlight(nextHighlight);
}

function nextSearchHighlight(current) {
  const textMatches = renderedTextMatches(current);
  const lineHighlights = findRenderedLineElements(current)
    .map((element) => ({ element, current: true }));
  if (!textMatches.some((match) => match.current) && lineHighlights.length === 0) {
    return undefined;
  }
  return { textMatches, lineHighlights };
}

function updateRenderedSearchHighlight(nextHighlight) {
  withDiffObserverPaused(() => {
    clearRenderedSearchHighlight();
    applyTextSearchHighlights(nextHighlight.textMatches);
    applyLineHighlights(nextHighlight.lineHighlights);
  });
}

function applyLineHighlights(highlights) {
  for (const highlight of highlights) {
    const { element } = highlight;
    renderedLineHighlights.push({
      element,
      style: element.getAttribute("style"),
    });
    styleLineHighlight(highlight);
  }
}

function styleLineHighlight(highlight) {
  const backgroundColor = highlight.current
    ? CURRENT_LINE_OUTLINE_BACKGROUND
    : LINE_OUTLINE_BACKGROUND;
  highlight.element.style.backgroundColor = backgroundColor;
  if (highlight.current) {
    highlight.element.style.boxShadow = LINE_OUTLINE_SHADOW;
  }
}

function clearRenderedSearchHighlight() {
  clearTextSearchHighlights();
  for (const { element, style } of renderedLineHighlights) {
    restoreStyle(element, style);
  }
  renderedLineHighlights = [];
}

function restoreStyle(element, style) {
  if (style == null) {
    element.removeAttribute("style");
  } else {
    element.setAttribute("style", style);
  }
}

function observeDiffMutations() {
  if (diffObserver) {
    return;
  }

  diffObserver = new MutationObserver(() => {
    if (state.search.open && refreshSearchForExpandedContext()) {
      return;
    }
    if (state.search.open && currentSearchMatch()) {
      applyCurrentSearchHighlight();
    }
  });
  diffObserver.observe(els.diff, { childList: true, subtree: true });
}

function refreshSearchForExpandedContext() {
  if (state.search.query.length === 0) {
    return false;
  }
  const signature = expandedContextSignature();
  if (signature === indexedExpandedContext) {
    return false;
  }
  const shouldJump = !currentSearchMatch();
  setSearchQuery(state.search.query, { preserveCurrent: true, jump: shouldJump });
  return true;
}

function withDiffObserverPaused(callback) {
  if (diffObserver) {
    diffObserver.disconnect();
  }
  try {
    callback();
  } finally {
    if (diffObserver) {
      diffObserver.observe(els.diff, { childList: true, subtree: true });
    }
  }
}

function findRenderedLineElements(match) {
  if (match.hidden) {
    return [];
  }
  return findRenderedContentLineElements(match).filter((element) => (
    isElementTextMatch(element, match)
  ));
}

function applyTextSearchHighlights(matches) {
  const matchesByElement = new Map();
  for (const match of matches) {
    const elementMatches = matchesByElement.get(match.element) || [];
    elementMatches.push(match);
    matchesByElement.set(match.element, elementMatches);
  }

  for (const elementMatches of matchesByElement.values()) {
    elementMatches.sort((left, right) => right.startColumn - left.startColumn);
    for (const match of elementMatches) {
      applyTextSearchHighlight(match);
    }
  }
}

function renderedTextMatches(current) {
  const matches = [];
  for (const match of state.search.matches) {
    if (match.hidden) {
      continue;
    }
    const lineElements = findRenderedContentLineElements(match);
    for (const element of lineElements) {
      if (!isElementTextMatch(element, match)) {
        continue;
      }
      matches.push({
        element,
        startColumn: match.startColumn,
        endColumn: match.endColumn,
        current: match === current,
      });
    }
  }

  return matches;
}

function isElementTextMatch(element, match) {
  const expected = match.text
    .slice(match.startColumn, match.endColumn)
    .toLowerCase();
  const rendered = trimLineEnding(element.textContent ?? "")
    .slice(match.startColumn, match.endColumn)
    .toLowerCase();
  return rendered === expected;
}

function applyTextSearchHighlight(match) {
  const range = rangeForTextOffset(match.element, match.startColumn, match.endColumn);
  if (!range) {
    return;
  }

  const marker = document.createElement("span");
  styleTextHighlightMarker(marker, match.current);
  marker.append(range.extractContents());
  range.insertNode(marker);
  highlightMarkers.push(marker);
}

function styleTextHighlightMarker(marker, current) {
  marker.style.backgroundColor = current
    ? CURRENT_TEXT_HIGHLIGHT_BACKGROUND
    : TEXT_HIGHLIGHT_BACKGROUND;
  marker.style.borderRadius = "0.125rem";
  marker.style.boxDecorationBreak = "clone";
  marker.style.webkitBoxDecorationBreak = "clone";
  marker.style.color = "inherit";
}

function clearTextSearchHighlights() {
  for (const element of highlightMarkers) {
    unwrapElement(element);
  }
  highlightMarkers = [];
}

function unwrapElement(element) {
  const parent = element.parentNode;
  if (!parent) {
    return;
  }
  while (element.firstChild) {
    parent.insertBefore(element.firstChild, element);
  }
  parent.removeChild(element);
  parent.normalize();
}

function findRenderedContentLineElements(match) {
  const selector = `[data-line="${match.lineNumber}"]`;
  return findRenderedElements(match, selector);
}

function findRenderedElements(match, selector) {
  const root = renderedItemElement(match);
  if (!root) {
    return [];
  }

  return queryDeep(root, selector).filter((element) => (
    isElementForSearchSide(element, match.side)
  ));
}

function renderedItemElement(match) {
  if (typeof state.codeView?.getRenderedItems !== "function") {
    return undefined;
  }

  const renderedItem = state.codeView.getRenderedItems().find(({ id }) => id === match.path);
  return renderedItem?.element;
}

function rangeForTextOffset(root, startOffset, endOffset) {
  if (endOffset <= startOffset) {
    return undefined;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode;
  let startNodeOffset = 0;
  let endNode;
  let endNodeOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nextOffset = offset + node.nodeValue.length;
    if (!startNode && startOffset <= nextOffset) {
      startNode = node;
      startNodeOffset = Math.max(0, startOffset - offset);
    }
    if (startNode && endOffset <= nextOffset) {
      endNode = node;
      endNodeOffset = Math.max(0, endOffset - offset);
      break;
    }
    offset = nextOffset;
  }

  if (!startNode || !endNode) {
    return undefined;
  }

  const range = document.createRange();
  range.setStart(startNode, startNodeOffset);
  range.setEnd(endNode, endNodeOffset);
  return range;
}

function queryDeep(root, selector) {
  const matches = [];
  visitNode(root, selector, matches);
  return matches;
}

function visitNode(node, selector, matches) {
  if (node instanceof Element) {
    if (node.matches(selector)) {
      matches.push(node);
    }
    if (node.shadowRoot) {
      visitNode(node.shadowRoot, selector, matches);
    }
  }

  for (const child of node.children || []) {
    visitNode(child, selector, matches);
  }
}

function isElementForSearchSide(element, side) {
  const sideRoot = closestSearchSideRoot(element);
  if (!sideRoot) {
    return true;
  }
  if (sideRoot.hasAttribute("data-unified")) {
    return true;
  }
  return side === "additions"
    ? sideRoot.hasAttribute("data-additions")
    : sideRoot.hasAttribute("data-deletions");
}

function closestSearchSideRoot(element) {
  let node = element;
  while (node) {
    if (node instanceof Element && node.matches(SEARCH_SIDE_SELECTOR)) {
      return node;
    }
    if (node.parentElement) {
      node = node.parentElement;
      continue;
    }
    const root = node.getRootNode?.();
    node = root instanceof ShadowRoot ? root.host : undefined;
  }
  return undefined;
}
