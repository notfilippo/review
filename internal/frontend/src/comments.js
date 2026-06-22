import { COMMENT_KIND_RANGE, DEFAULT_COMMENT_SIDE } from "./constants.js";
import { requestJSON } from "./api.js";
import { renderDiffs, setCurrentPath } from "./diff-view.js";
import { setIconButton } from "./icons.js";
import { els, state } from "./state.js";
import { stopDiffEvents } from "./util.js";

export function annotationsForPath(path) {
  const comments = state.comments.filter((comment) => comment.path === path && comment.kind === COMMENT_KIND_RANGE);
  if (state.draft && state.draft.path === path && state.draft.kind === COMMENT_KIND_RANGE) {
    comments.push(state.draft);
  }
  return comments.map((comment) => ({
    side: annotationSide(comment),
    lineNumber: annotationLine(comment),
    metadata: { commentId: comment.id },
  }));
}

export function startDraft(path, range) {
  if (!range || !path || !state.filesByPath.has(path)) {
    return;
  }
  const normalized = normalizeRange(range);
  setCurrentPath(path, { scrollDiff: false, selectTree: true });
  clearActiveComment();
  state.draft = {
    id: `draft-${crypto.randomUUID()}`,
    kind: COMMENT_KIND_RANGE,
    path,
    ...normalized,
    text: "",
    draft: true,
  };
  renderDiffs();
}

function createAnnotationAction(iconName, label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button annotation-icon-button${className ? ` ${className}` : ""}`;
  setIconButton(button, iconName, label);
  return button;
}

export function createAnnotationCard(comment) {
  const card = document.createElement("article");
  card.className = "annotation-card";
  stopDiffEvents(card);
  card.addEventListener("mouseenter", () => {
    state.hoveredCommentId = comment.id;
    applyActiveSelection();
  });
  card.addEventListener("mouseleave", () => {
    if (state.hoveredCommentId === comment.id) {
      clearHoveredComment();
      applyActiveSelection();
    }
  });

  const meta = document.createElement("div");
  meta.className = "annotation-meta";
  meta.textContent = comment.draft ? `New comment · ${rangeLabel(comment)}` : `You · ${rangeLabel(comment)}`;
  card.append(meta);

  if (comment.draft || state.editingId === comment.id) {
    card.append(createAnnotationEditor(comment));
    return card;
  }

  const text = document.createElement("div");
  text.className = "annotation-text";
  text.textContent = comment.text;
  card.append(text);

  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  const edit = createAnnotationAction("Pencil", "Edit");
  edit.addEventListener("click", () => {
    state.draft = null;
    state.editingId = comment.id;
    clearHoveredComment();
    renderDiffs();
  });
  const remove = createAnnotationAction("Trash2", "Delete", "danger");
  remove.addEventListener("click", async () => {
    await deleteComment(comment.id);
  });
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

function createAnnotationEditor(comment) {
  const fragment = document.createDocumentFragment();
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Add comment";
  textarea.value = comment.text || "";
  textarea.addEventListener("keydown", (event) => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      void saveInlineComment(comment, textarea.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelInlineComment(comment);
    }
  });

  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  const cancel = createAnnotationAction("X", "Cancel");
  cancel.addEventListener("click", () => {
    cancelInlineComment(comment);
  });
  const save = createAnnotationAction("Check", "Save", "primary");
  save.addEventListener("click", async () => {
    await saveInlineComment(comment, textarea.value);
  });
  actions.append(cancel, save);

  fragment.append(textarea, actions);
  queueMicrotask(() => textarea.focus());
  return fragment;
}

function isSubmitShortcut(event) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

function cancelInlineComment(comment) {
  if (comment.draft) {
    state.draft = null;
  }
  clearActiveComment();
  renderDiffs();
}

async function saveInlineComment(comment, value) {
  const text = value.trim();
  if (!text) {
    return;
  }

  if (comment.draft) {
    const { draft, ...saved } = comment;
    state.comments.push({
      ...saved,
      id: crypto.randomUUID(),
      text,
    });
    state.draft = null;
  } else {
    const existing = state.comments.find((item) => item.id === comment.id);
    if (existing) {
      existing.text = text;
    }
  }

  clearActiveComment();
  renderDiffs();
  await saveComments();
}

async function deleteComment(id) {
  state.comments = state.comments.filter((comment) => comment.id !== id);
  if (state.editingId === id) {
    state.editingId = "";
  }
  if (state.hoveredCommentId === id) {
    clearHoveredComment();
  }
  renderDiffs();
  await saveComments();
}

export function clearActiveComment() {
  state.editingId = "";
  clearHoveredComment();
}

function clearHoveredComment() {
  state.hoveredCommentId = "";
}

export function findAnnotationComment(id) {
  if (!id) {
    return undefined;
  }
  if (state.draft && state.draft.id === id) {
    return state.draft;
  }
  return state.comments.find((comment) => comment.id === id);
}

function activeSelectionComment() {
  if (state.draft) {
    return state.draft;
  }
  const id = state.editingId || state.hoveredCommentId;
  return id ? state.comments.find((comment) => comment.id === id) : undefined;
}

export function applyActiveSelection() {
  if (!state.codeView) {
    return;
  }
  const comment = activeSelectionComment();
  if (!comment) {
    state.codeView.clearSelectedLines({ notify: false });
    return;
  }
  queueMicrotask(() => {
    state.codeView.setSelectedLines({
      id: comment.path,
      range: selectionRange(comment),
    }, { notify: false });
  });
}

export function syncCommentSummary() {
  const count = state.comments.length;
  els.commentSummary.textContent = `${count} comment${count === 1 ? "" : "s"}`;
}

export async function saveComments() {
  await requestJSON("/api/comments", {
    method: "PUT",
    body: JSON.stringify({ comments: state.comments }),
  });
  syncCommentSummary();
}

function normalizeRange(range) {
  if (range.start <= range.end) {
    return {
      side: range.side || range.endSide || DEFAULT_COMMENT_SIDE,
      startLine: range.start,
      endLine: range.end,
      endSide: range.endSide || range.side || DEFAULT_COMMENT_SIDE,
    };
  }
  return {
    side: range.endSide || range.side || DEFAULT_COMMENT_SIDE,
    startLine: range.end,
    endLine: range.start,
    endSide: range.side || range.endSide || DEFAULT_COMMENT_SIDE,
  };
}

function selectionRange(comment) {
  return {
    start: comment.startLine,
    side: comment.side || DEFAULT_COMMENT_SIDE,
    end: comment.endLine,
    endSide: comment.endSide || comment.side || DEFAULT_COMMENT_SIDE,
  };
}

function annotationLine(comment) {
  return comment.endLine || comment.startLine;
}

function annotationSide(comment) {
  return comment.endSide || comment.side || DEFAULT_COMMENT_SIDE;
}

function rangeLabel(comment) {
  const side = comment.side || "line";
  if (comment.startLine === comment.endLine) {
    return `${side} line ${comment.startLine}`;
  }
  return `${side} lines ${comment.startLine}-${comment.endLine}`;
}
