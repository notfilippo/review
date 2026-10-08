import { requestJSON } from "./api.js";
import {
  DIFF_THEME,
  REPO_SEARCH_DEBOUNCE_MS,
  REPO_SEARCH_MIN_LIVE_LENGTH,
  REPO_SEARCH_TIMEOUT_MS,
} from "./constants.js";
import { renderDiffs, setCurrentPath } from "./diff-view.js";
import { createLucideIcon, setIconButton } from "./icons.js";
import { isNarrowViewport, setSidebarTab, setTreeCollapsed } from "./layout.js";
import { findRenderedLines, selectedSearchText } from "./search.js";
import { els, state } from "./state.js";
import { afterNextPaint } from "./util.js";

const IDENTIFIER_PATTERN = /[\p{L}\p{N}_$]+/gu;
const FLASH_BACKGROUND = "color-mix(in srgb, var(--accent-2) 30%, transparent)";
const FLASH_MS = 1600;
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const MODIFIER_LABEL = IS_MAC ? "⌘" : "Ctrl";

let debounceTimer;
let peekView;
let underlinedToken;

export function setupReferences() {
  setIconButton(els.repoSearchCase, "CaseSensitive", "Match case");
  setIconButton(els.repoSearchWord, "WholeWord", "Match whole word");
  setIconButton(els.repoSearchRegex, "Regex", "Use regular expression");
  setIconButton(els.peekClose, "X", "Close preview");

  els.repoSearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    runRepoSearch();
  });
  els.repoSearchInput.addEventListener("input", () => {
    state.refs.query = els.repoSearchInput.value;
    scheduleLiveSearch();
  });
  els.repoSearchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (els.repoSearchInput.value) {
      els.repoSearchInput.value = "";
      state.refs.query = "";
      clearResults();
    } else {
      els.repoSearchInput.blur();
    }
  });
  for (const [button, key] of [
    [els.repoSearchCase, "caseSensitive"],
    [els.repoSearchWord, "word"],
    [els.repoSearchRegex, "regex"],
  ]) {
    button.addEventListener("click", () => {
      state.refs[key] = !state.refs[key];
      syncOptionButtons();
      if (state.refs.query.trim()) {
        runRepoSearch();
      }
    });
  }
  els.peekClose.addEventListener("click", closePeek);
  syncOptionButtons();
  renderResults();
}

export function handleReferencesKey(event) {
  if (event.defaultPrevented) {
    return false;
  }
  if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openRepoSearch(selectedSearchText().split("\n")[0]);
    return true;
  }
  if (event.key === "Escape" && !els.peek.hidden) {
    event.preventDefault();
    closePeek();
    return true;
  }
  return false;
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

export function findReferences(identifier) {
  Object.assign(state.refs, {
    query: identifier,
    word: true,
    caseSensitive: true,
    regex: false,
  });
  els.repoSearchInput.value = identifier;
  syncOptionButtons();
  showSearchTab();
  runRepoSearch();
}

function openRepoSearch(prefill) {
  if (prefill) {
    els.repoSearchInput.value = prefill;
    state.refs.query = prefill;
  }
  showSearchTab();
  els.repoSearchInput.focus();
  els.repoSearchInput.select();
  if (prefill) {
    runRepoSearch();
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
  const query = state.refs.query.trim();
  if (!query) {
    clearResults();
    return;
  }
  if (query.length < REPO_SEARCH_MIN_LIVE_LENGTH) {
    return;
  }
  debounceTimer = setTimeout(runRepoSearch, REPO_SEARCH_DEBOUNCE_MS);
}

async function runRepoSearch() {
  clearTimeout(debounceTimer);
  const query = els.repoSearchInput.value;
  state.refs.query = query;
  if (!query.trim()) {
    clearResults();
    return;
  }
  const requestId = ++state.refs.requestId;
  state.refs.loading = true;
  state.refs.error = "";
  renderStatus();

  const params = new URLSearchParams({
    q: query,
    word: String(state.refs.word),
    regex: String(state.refs.regex),
    case_sensitive: String(state.refs.caseSensitive),
  });
  try {
    const response = await requestJSON(`/api/search?${params}`, { timeoutMs: REPO_SEARCH_TIMEOUT_MS });
    if (requestId !== state.refs.requestId || response.cancelled) {
      return;
    }
    state.refs.response = response;
    state.refs.activeKey = "";
    state.refs.collapsedFiles = new Set();
  } catch (error) {
    if (requestId !== state.refs.requestId) {
      return;
    }
    state.refs.response = null;
    state.refs.error = error instanceof Error ? error.message : String(error);
  }
  state.refs.loading = false;
  renderResults();
}

function clearResults() {
  clearTimeout(debounceTimer);
  state.refs.requestId += 1;
  state.refs.loading = false;
  state.refs.error = "";
  state.refs.response = null;
  renderResults();
}

function syncOptionButtons() {
  els.repoSearchCase.setAttribute("aria-pressed", String(state.refs.caseSensitive));
  els.repoSearchWord.setAttribute("aria-pressed", String(state.refs.word));
  els.repoSearchRegex.setAttribute("aria-pressed", String(state.refs.regex));
}

function renderResults() {
  renderStatus();
  const response = state.refs.response;
  els.repoSearchResults.replaceChildren();
  if (!response) {
    if (!state.refs.error) {
      els.repoSearchResults.append(emptyHint());
    }
    return;
  }
  for (const file of response.files) {
    els.repoSearchResults.append(createFileGroup(file));
  }
}

function renderStatus() {
  const { loading, error, response } = state.refs;
  els.repoSearchStatus.dataset.error = String(Boolean(error));
  els.refsCount.textContent = response ? countLabel(response) : "0";
  if (loading) {
    els.repoSearchStatus.textContent = "Searching…";
  } else if (error) {
    els.repoSearchStatus.textContent = error;
  } else if (response) {
    els.repoSearchStatus.textContent = statusLabel(response);
  } else {
    els.repoSearchStatus.textContent = "";
  }
}

function countLabel(response) {
  return `${response.match_count}${response.truncated ? "+" : ""}`;
}

function statusLabel(response) {
  if (response.files.length === 0) {
    return `No results in ${response.searched_files} files`;
  }
  const lines = response.files.reduce((total, file) => total + file.matches.length, 0);
  const files = `${response.files.length} file${response.files.length === 1 ? "" : "s"}`;
  const truncated = response.truncated ? ", truncated" : "";
  return `${lines} line${lines === 1 ? "" : "s"} in ${files} · ${response.elapsed_ms} ms${truncated}`;
}

function emptyHint() {
  const hint = document.createElement("p");
  hint.className = "repo-search-empty";
  hint.textContent = `${MODIFIER_LABEL}-click a symbol in the diff to find its references. ${MODIFIER_LABEL}⇧F searches with the current selection.`;
  return hint;
}

function createFileGroup(file) {
  const group = document.createElement("section");
  group.className = "repo-search-file";
  const collapsed = state.refs.collapsedFiles.has(file.path);

  const header = document.createElement("button");
  header.type = "button";
  header.className = "repo-search-file-header";
  header.setAttribute("aria-expanded", String(!collapsed));
  header.title = file.path;
  header.addEventListener("click", () => {
    if (state.refs.collapsedFiles.has(file.path)) {
      state.refs.collapsedFiles.delete(file.path);
    } else {
      state.refs.collapsedFiles.add(file.path);
    }
    renderResults();
  });

  const chevron = createLucideIcon(collapsed ? "ChevronRight" : "ChevronDown");
  const name = document.createElement("span");
  name.className = "repo-search-path";
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
    lines.className = "repo-search-lines";
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
  row.className = "repo-search-line";
  row.dataset.active = String(key === state.refs.activeKey);
  row.title = `${file.path}:${match.line}`;
  row.addEventListener("click", () => {
    state.refs.activeKey = key;
    for (const other of els.repoSearchResults.querySelectorAll(".repo-search-line[data-active=\"true\"]")) {
      other.dataset.active = "false";
    }
    row.dataset.active = "true";
    openMatch(file, match);
  });

  const number = document.createElement("span");
  number.className = "repo-search-line-number";
  number.textContent = String(match.line);
  row.append(number, matchText(match));
  if (match.definition) {
    row.append(badge("def", "Likely definition"));
  }
  return row;
}

function matchText(match) {
  const code = document.createElement("code");
  code.className = "repo-search-text";
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
  node.className = `repo-search-badge repo-search-badge-${text}`;
  node.textContent = text;
  node.title = title;
  return node;
}

function openMatch(file, match) {
  if (isNarrowViewport()) {
    setTreeCollapsed(true);
  }
  const reviewFile = file.in_diff ? state.filesByPath.get(file.path) : undefined;
  if (reviewFile) {
    closePeek();
    revealInDiff(reviewFile.reviewId, match.line);
  } else {
    openPeek(file.path, match.line);
  }
}

// Search results come from the new side of the review, so they map onto
// addition line numbers. revealLine only sees hunks of a mounted file, so the
// file is scrolled into view before collapsed context is expanded.
async function revealInDiff(reviewId, lineNumber) {
  if (!state.codeView) {
    return;
  }
  if (state.collapsedFiles.has(reviewId)) {
    state.collapsedFiles.delete(reviewId);
    renderDiffs();
  }
  setCurrentPath(reviewId, { scrollDiff: false, selectTree: true });
  state.codeView.scrollTo({ type: "item", id: reviewId, align: "start", behavior: "instant" });
  await afterNextPaint();
  if (state.codeView.idToItem?.get(reviewId)?.instance?.revealLine?.(lineNumber)) {
    await afterNextPaint();
  }
  state.codeView.scrollTo({
    type: "line",
    id: reviewId,
    lineNumber,
    side: "additions",
    align: "center",
    behavior: "instant",
  });
  await afterNextPaint();
  flashLines(findRenderedLines(reviewId, "additions", lineNumber));
}

function flashLines(elements) {
  for (const element of elements) {
    element.animate(
      [{ backgroundColor: FLASH_BACKGROUND }, { backgroundColor: "transparent" }],
      { duration: FLASH_MS, easing: "ease-out" },
    );
  }
}

async function openPeek(path, lineNumber) {
  const title = `${path}:${lineNumber}`;
  els.peek.hidden = false;
  els.peekTitle.textContent = title;
  showPeekMessage(loadingNode());
  let file;
  try {
    file = await requestJSON(`/api/file?${new URLSearchParams({ path })}`);
  } catch (error) {
    if (els.peekTitle.textContent === title) {
      showPeekMessage(errorNode(error));
    }
    return;
  }
  if (els.peekTitle.textContent !== title) {
    return;
  }
  showPeekMessage(undefined);
  const view = ensurePeekView();
  view.setItems([{
    id: file.path,
    type: "file",
    file: { name: file.path, contents: file.contents, cacheKey: `peek-${file.path}` },
  }]);
  view.render(true);
  await afterNextPaint();
  view.scrollTo({ type: "line", id: file.path, lineNumber, align: "center", behavior: "instant" });
  view.setSelectedLines({ id: file.path, range: { start: lineNumber, end: lineNumber } }, { notify: false });
}

function showPeekMessage(node) {
  els.peekMessage.hidden = !node;
  els.peekMessage.replaceChildren(...(node ? [node] : []));
}

function ensurePeekView() {
  if (!peekView) {
    peekView = new state.CodeView({
      theme: DIFF_THEME,
      overflow: "scroll",
      disableFileHeader: true,
      enableLineSelection: true,
      lineHoverHighlight: "both",
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
      ...referenceTokenOptions(),
    }, state.workerManager);
    peekView.setup(els.peekView);
  }
  return peekView;
}

function closePeek() {
  if (els.peek.hidden) {
    return;
  }
  els.peek.hidden = true;
  els.peekTitle.textContent = "";
  peekView?.setItems([]);
  peekView?.render(true);
}

function loadingNode() {
  const node = document.createElement("div");
  node.className = "diff-loading";
  const spinner = document.createElement("span");
  spinner.className = "diff-loading-spinner";
  spinner.setAttribute("aria-hidden", "true");
  node.append(spinner, "Loading file");
  return node;
}

function errorNode(error) {
  const node = document.createElement("div");
  node.className = "error";
  node.textContent = error instanceof Error ? error.message : String(error);
  return node;
}
