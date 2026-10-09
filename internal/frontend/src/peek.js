import { requestJSON } from "./api.js";
import { DIFF_THEME } from "./constants.js";
import { setIconButton } from "./icons.js";
import { els, state } from "./state.js";
import { afterNextPaint } from "./util.js";

let peekView;
let tokenOptions = {};

// Read-only view for search results the diff does not show, so following a
// reference never expands or reorders the review itself.
export function setupPeek(options) {
  tokenOptions = options;
  setIconButton(els.peekClose, "X", "Close preview");
  els.peekClose.addEventListener("click", closePeek);
}

export function handlePeekKey(event) {
  if (event.defaultPrevented || event.key !== "Escape" || els.peek.hidden) {
    return false;
  }
  event.preventDefault();
  closePeek();
  return true;
}

export async function openPeek(path, lineNumber, inDiff) {
  const title = `${path}:${lineNumber}`;
  els.peek.hidden = false;
  els.peekTitle.textContent = title;
  els.peekSource.textContent = inDiff ? "reviewed revision" : "working copy";
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
      ...tokenOptions,
    }, state.workerManager);
    peekView.setup(els.peekView);
  }
  return peekView;
}

export function closePeek() {
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
