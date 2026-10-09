import { streamJSONLines } from "./api.js";
import { SEARCH_DEBOUNCE_MS, SEARCH_MIN_LIVE_LENGTH } from "./constants.js";
import { renderDiffs, setCurrentPath } from "./diff-view.js";
import { createLucideIcon, setIconButton } from "./icons.js";
import { isNarrowViewport, setSidebarTab, setTreeCollapsed } from "./layout.js";
import { closePeek, openPeek, setupPeek } from "./peek.js";
import { els, state } from "./state.js";
import { afterNextPaint, closestAcrossShadow, queryDeep } from "./util.js";

const IDENTIFIER_PATTERN = /[\p{L}\p{N}_$]+/gu;
const FLASH_BACKGROUND = "color-mix(in srgb, var(--accent-2) 30%, transparent)";
const FLASH_MS = 1600;
const STREAM_RENDER_MS = 120;
const DIFF_SIDE_SELECTOR = "[data-additions], [data-deletions], [data-unified]";
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MODIFIER_LABEL = IS_MAC ? "⌘" : "Ctrl";

let debounceTimer;
let renderTimer;
let underlinedToken;

export function setupSearch() {
  setIconButton(els.searchCase, "CaseSensitive", "Match case");
  setIconButton(els.searchWord, "WholeWord", "Match whole word");
  setIconButton(els.searchRegex, "Regex", "Use regular expression");
  setIconButton(els.searchToggle, "Search", "Search repository");
  els.searchToggle.addEventListener("click", () => openSearch(selectedText()));

  els.searchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch();
  });
  els.searchInput.addEventListener("input", scheduleLiveSearch);
  els.searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (els.searchInput.value) {
      els.searchInput.value = "";
      clearResults();
    } else {
      els.searchInput.blur();
    }
  });
  for (const [button, key] of [
    [els.searchCase, "caseSensitive"],
    [els.searchWord, "word"],
    [els.searchRegex, "regex"],
  ]) {
    button.addEventListener("click", () => {
      state.search[key] = !state.search[key];
      syncOptionButtons();
      if (els.searchInput.value.trim()) {
        runSearch();
      }
    });
  }
  setupPeek(referenceTokenOptions());
  syncOptionButtons();
  renderResults();
}

export function handleSearchKey(event) {
  if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "f") {
    return false;
  }
  event.preventDefault();
  openSearch(selectedText());
  return true;
}

// Token hooks shared by the diff and the peek view: modifier-click a symbol
// to list every place it appears in the repository.
export function referenceTokenOptions() {
  return {
    onTokenClick(token, event) {
      if (!isReferenceClick(event)) {
        return;
      }
      const identifier = identifierAtPointer(token, event);
      if (!identifier) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      findReferences(identifier);
    },
    onTokenEnter(token, event) {
      if (isReferenceClick(event) && identifierAtPointer(token, event)) {
        underlineToken(token.tokenElement);
      }
    },
    onTokenLeave() {
      underlineToken(undefined);
    },
  };
}

function findReferences(identifier) {
  Object.assign(state.search, { word: true, caseSensitive: true, regex: false });
  els.searchInput.value = identifier;
  syncOptionButtons();
  showSearchTab();
  runSearch();
}

function openSearch(prefill) {
  if (prefill) {
    els.searchInput.value = prefill;
  }
  showSearchTab();
  els.searchInput.focus();
  els.searchInput.select();
  if (prefill) {
    runSearch();
  }
}

function showSearchTab() {
  if (state.treeCollapsed) {
    setTreeCollapsed(false);
  }
  setSidebarTab("search");
}

function isReferenceClick(event) {
  return (IS_MAC ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;
}

function identifierAtPointer(token, event) {
  const identifiers = [...token.tokenText.matchAll(IDENTIFIER_PATTERN)];
  if (identifiers.length <= 1) {
    return identifiers[0]?.[0] || "";
  }
  const offset = pointerOffsetInToken(token, event);
  const hit = identifiers.find((match) => offset >= match.index && offset <= match.index + match[0].length);
  return (hit || identifiers[0])[0];
}

function pointerOffsetInToken(token, event) {
  const root = token.tokenElement.getRootNode();
  const position = document.caretPositionFromPoint?.(
    event.clientX,
    event.clientY,
    root instanceof ShadowRoot ? { shadowRoots: [root] } : undefined,
  );
  if (!position || !token.tokenElement.contains(position.offsetNode)) {
    return 0;
  }
  let offset = position.offset;
  const walker = document.createTreeWalker(token.tokenElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && walker.currentNode !== position.offsetNode) {
    offset += walker.currentNode.nodeValue.length;
  }
  return offset;
}

function underlineToken(element) {
  if (underlinedToken && underlinedToken !== element) {
    underlinedToken.style.removeProperty("text-decoration");
    underlinedToken.style.removeProperty("cursor");
  }
  underlinedToken = element;
  if (element) {
    element.style.textDecoration = "underline";
    element.style.cursor = "pointer";
  }
}

function scheduleLiveSearch() {
  clearTimeout(debounceTimer);
  const query = els.searchInput.value.trim();
  if (!query) {
    clearResults();
    return;
  }
  if (query.length < SEARCH_MIN_LIVE_LENGTH) {
    return;
  }
  debounceTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

async function runSearch() {
  clearTimeout(debounceTimer);
  const query = els.searchInput.value;
  if (!query.trim()) {
    clearResults();
    return;
  }
  stopSearch();
  const controller = new AbortController();
  state.search.controller = controller;
  Object.assign(state.search, {
    error: "",
    activeKey: "",
    collapsedFiles: new Set(),
    response: { files: [], match_count: 0, searched_files: 0, scope: [], truncated: false, elapsed_ms: 0 },
  });
  renderResults();

  const params = new URLSearchParams({
    q: query,
    word: String(state.search.word),
    regex: String(state.search.regex),
    case_sensitive: String(state.search.caseSensitive),
  });
  try {
    await streamJSONLines(`/api/search?${params}`, {
      signal: controller.signal,
      onEvent: (event) => {
        if (!controller.signal.aborted) {
          applySearchEvent(event);
        }
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return;
    }
    state.search.response = null;
    state.search.error = error instanceof Error ? error.message : String(error);
  }
  if (state.search.controller === controller) {
    state.search.controller = null;
    renderResults();
  }
}

function applySearchEvent(event) {
  const response = state.search.response;
  switch (event.type) {
    case "file":
      insertSorted(response.files, event);
      response.match_count += event.matches.length;
      scheduleRender();
      break;
    case "scope":
      response.scope = event.dirs;
      response.searched_files = event.searched_files;
      renderStatus();
      break;
    case "progress":
      response.searched_files = event.searched_files;
      renderStatus();
      break;
    case "done":
      Object.assign(response, {
        match_count: event.match_count,
        searched_files: event.searched_files,
        truncated: event.truncated,
        elapsed_ms: event.elapsed_ms,
      });
      break;
    default:
      break;
  }
}

// Files stream in nearest-first; definitions and diff files still lead so the
// declaration is the first thing to read.
function insertSorted(files, file) {
  const rank = (item) => [
    item.matches.some((match) => match.definition) ? 0 : 1,
    item.in_diff ? 0 : 1,
    item.distance,
  ];
  const key = rank(file);
  const index = files.findIndex((other) => {
    const otherKey = rank(other);
    for (let i = 0; i < key.length; i += 1) {
      if (key[i] !== otherKey[i]) {
        return key[i] < otherKey[i];
      }
    }
    return file.path < other.path;
  });
  files.splice(index === -1 ? files.length : index, 0, file);
}

function scheduleRender() {
  if (renderTimer) {
    return;
  }
  renderTimer = setTimeout(() => {
    renderTimer = undefined;
    renderResults();
  }, STREAM_RENDER_MS);
}

function stopSearch() {
  if (state.search.controller && state.search.response) {
    state.search.response.stopped = true;
  }
  state.search.controller?.abort();
  state.search.controller = null;
}

function clearResults() {
  clearTimeout(debounceTimer);
  stopSearch();
  state.search.error = "";
  state.search.response = null;
  renderResults();
}

function syncOptionButtons() {
  els.searchCase.setAttribute("aria-pressed", String(state.search.caseSensitive));
  els.searchWord.setAttribute("aria-pressed", String(state.search.word));
  els.searchRegex.setAttribute("aria-pressed", String(state.search.regex));
}

function renderResults() {
  renderStatus();
  const response = state.search.response;
  els.searchResults.replaceChildren();
  if (!response) {
    if (!state.search.error) {
      els.searchResults.append(emptyHint());
    }
    return;
  }
  for (const file of response.files) {
    els.searchResults.append(createFileGroup(file));
  }
}

function renderStatus() {
  const { controller, error, response } = state.search;
  const loading = Boolean(controller);
  els.searchStatus.dataset.error = String(Boolean(error));
  els.searchCount.textContent = response ? countLabel(response) : "0";
  if (error) {
    els.searchStatus.replaceChildren(error);
  } else if (response) {
    const text = document.createElement("span");
    text.className = "search-status-text";
    text.textContent = statusLabel(response, loading);
    text.title = text.textContent;
    els.searchStatus.replaceChildren(text);
    if (loading) {
      els.searchStatus.append(stopButton());
    }
  } else {
    els.searchStatus.replaceChildren();
  }
}

function stopButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "search-stop";
  button.textContent = "Stop";
  button.addEventListener("click", () => {
    stopSearch();
    renderResults();
  });
  return button;
}

function countLabel(response) {
  return `${response.match_count}${response.truncated ? "+" : ""}`;
}

function statusLabel(response, loading) {
  const lines = response.files.reduce((total, file) => total + file.matches.length, 0);
  const files = `${response.files.length} file${response.files.length === 1 ? "" : "s"}`;
  const found = `${lines} line${lines === 1 ? "" : "s"} in ${files}`;
  const searched = `${response.searched_files.toLocaleString()} searched`;
  if (loading) {
    const scope = response.scope.length === 0 ? "diff" : response.scope.map((dir) => dir || "repository").join(", ");
    return `${found} · ${searched} · in ${scope}…`;
  }
  const ending = response.stopped
    ? " · stopped"
    : ` · ${response.elapsed_ms.toLocaleString()} ms${response.truncated ? ", truncated" : ""}`;
  return `${lines === 0 ? "No results" : found} · ${searched}${ending}`;
}

function emptyHint() {
  const hint = document.createElement("p");
  hint.className = "search-empty";
  hint.textContent = `${MODIFIER_LABEL}-click a symbol in the diff to find its references. ${MODIFIER_LABEL}F searches with the current selection.`;
  return hint;
}

function createFileGroup(file) {
  const group = document.createElement("section");
  group.className = "search-file";
  const collapsed = state.search.collapsedFiles.has(file.path);

  const header = document.createElement("button");
  header.type = "button";
  header.className = "search-file-header";
  header.setAttribute("aria-expanded", String(!collapsed));
  header.title = file.path;
  header.addEventListener("click", () => {
    if (state.search.collapsedFiles.has(file.path)) {
      state.search.collapsedFiles.delete(file.path);
    } else {
      state.search.collapsedFiles.add(file.path);
    }
    renderResults();
  });

  const chevron = createLucideIcon(collapsed ? "ChevronRight" : "ChevronDown");
  const name = document.createElement("span");
  name.className = "search-path";
  const slash = file.path.lastIndexOf("/");
  const base = document.createElement("strong");
  base.textContent = file.path.slice(slash + 1);
  const dir = document.createElement("span");
  dir.textContent = slash === -1 ? "" : file.path.slice(0, slash);
  name.append(base, dir);
  header.append(chevron || "", name);
  if (file.in_diff) {
    header.append(badge("diff", "In this review"));
  }
  const count = document.createElement("span");
  count.className = "tab-count";
  count.textContent = String(file.matches.length);
  header.append(count);
  group.append(header);

  if (!collapsed) {
    const lines = document.createElement("div");
    lines.className = "search-lines";
    for (const match of file.matches) {
      lines.append(createMatchRow(file, match));
    }
    group.append(lines);
  }
  return group;
}

function createMatchRow(file, match) {
  const key = `${file.path}:${match.line}`;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "search-line";
  row.dataset.active = String(key === state.search.activeKey);
  row.title = `${file.path}:${match.line}`;
  row.addEventListener("click", () => {
    state.search.activeKey = key;
    for (const other of els.searchResults.querySelectorAll(".search-line[data-active=\"true\"]")) {
      other.dataset.active = "false";
    }
    row.dataset.active = "true";
    openMatch(file, match);
  });

  const number = document.createElement("span");
  number.className = "search-line-number";
  number.textContent = String(match.line);
  row.append(number, matchText(match));
  if (match.definition) {
    row.append(badge("def", "Likely definition"));
  }
  return row;
}

function matchText(match) {
  const code = document.createElement("code");
  code.className = "search-text";
  const leading = match.clipped_start ? 0 : match.text.length - match.text.trimStart().length;
  if (match.clipped_start) {
    code.append("…");
  }
  let cursor = leading;
  for (const [start, end] of match.ranges) {
    if (end <= cursor) {
      continue;
    }
    const from = Math.max(start, cursor);
    code.append(match.text.slice(cursor, from));
    const mark = document.createElement("mark");
    mark.textContent = match.text.slice(from, end);
    code.append(mark);
    cursor = end;
  }
  code.append(match.text.slice(cursor));
  if (match.clipped_end) {
    code.append("…");
  }
  return code;
}

function badge(text, title) {
  const node = document.createElement("span");
  node.className = `search-badge search-badge-${text}`;
  node.textContent = text;
  node.title = title;
  return node;
}

function openMatch(file, match) {
  if (isNarrowViewport()) {
    setTreeCollapsed(true);
  }
  const reviewFile = file.in_diff ? state.filesByPath.get(file.path) : undefined;
  if (reviewFile && isHunkLine(reviewFile, match.line)) {
    closePeek();
    scrollDiffToLine(reviewFile.reviewId, match.line);
  } else {
    openPeek(file.path, match.line, file.in_diff);
  }
}

// Results map onto addition line numbers. Lines outside hunks go to the peek
// so jumping around never expands context in the diff.
function isHunkLine(file, lineNumber) {
  return (file.hunks || []).some((hunk) => (
    lineNumber >= hunk.additionStart && lineNumber < hunk.additionStart + hunk.additionCount
  ));
}

async function scrollDiffToLine(reviewId, lineNumber) {
  if (!state.codeView) {
    return;
  }
  if (state.collapsedFiles.has(reviewId)) {
    state.collapsedFiles.delete(reviewId);
    renderDiffs();
  }
  setCurrentPath(reviewId, { scrollDiff: false, selectTree: true });
  state.codeView.scrollTo({
    type: "line",
    id: reviewId,
    lineNumber,
    side: "additions",
    align: "center",
    behavior: "instant",
  });
  await afterNextPaint();
  flashLines(renderedAdditionLines(reviewId, lineNumber));
}

function renderedAdditionLines(reviewId, lineNumber) {
  const item = state.codeView.getRenderedItems?.().find(({ id }) => id === reviewId);
  if (!item?.element) {
    return [];
  }
  return queryDeep(item.element, `[data-line="${lineNumber}"]`).filter((element) => {
    const side = closestAcrossShadow(element, DIFF_SIDE_SELECTOR);
    return !side || !side.hasAttribute("data-deletions");
  });
}

// First line of the page selection, including selections inside the diff's
// shadow roots, which window.getSelection() does not report.
function selectedText() {
  const selections = [window.getSelection()];
  for (const host of queryDeep(els.diff, "*")) {
    if (host.shadowRoot?.getSelection) {
      selections.push(host.shadowRoot.getSelection());
    }
  }
  for (const selection of selections) {
    const text = String(selection || "").trim();
    if (text) {
      return text.split("\n")[0].trim();
    }
  }
  return "";
}

function flashLines(elements) {
  for (const element of elements) {
    element.animate(
      [{ backgroundColor: FLASH_BACKGROUND }, { backgroundColor: "transparent" }],
      { duration: FLASH_MS, easing: "ease-out" },
    );
  }
}

