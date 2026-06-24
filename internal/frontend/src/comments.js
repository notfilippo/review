import { DEFAULT_COMMENT_SIDE } from "./constants.js";
import { requestJSON } from "./api.js";
import { renderDiffs, setCurrentPath } from "./diff-view.js";
import { setIconButton } from "./icons.js";
import { fileCommentKey } from "./patch-files.js";
import { els, state } from "./state.js";
import { isEditableTarget, stopDiffEvents } from "./util.js";

export function annotationsForFile(file) {
  const comments = state.comments.filter((comment) => sameFileComment(comment, file));
  if (state.draft && sameFileComment(state.draft, file)) {
    comments.push(state.draft);
  }
  return comments.map((comment) => ({
    side: annotationSide(comment),
    lineNumber: annotationLine(comment),
    metadata: { commentId: comment.id },
  }));
}

export function startDraft(reviewId, range) {
  const file = state.filesByPath.get(reviewId);
  if (!range || !file) {
    return;
  }
  const normalized = normalizeRange(range);
  setCurrentPath(reviewId, { scrollDiff: false, selectTree: true });
  clearActiveComment();
  state.selectedCommentId = "";
  state.draft = {
    id: `draft-${crypto.randomUUID()}`,
    path: file.name,
    ...normalized,
    text: "",
    draft: true,
  };
  renderDiffs();
}

function createAnnotationAction(iconName, label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.classList.add("icon-button", "annotation-icon-button");
  if (className) {
    button.classList.add(className);
  }
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
    state.selectedCommentId = comment.id;
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
  if (state.selectedCommentId === id) {
    state.selectedCommentId = "";
  }
  renderDiffs();
  await saveComments();
}

export function clearActiveComment() {
  state.editingId = "";
  state.selectedCommentId = "";
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
  const id = state.editingId || state.hoveredCommentId || state.selectedCommentId;
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
    const reviewId = reviewIdForComment(comment);
    if (!reviewId) {
      state.codeView.clearSelectedLines({ notify: false });
      return;
    }
    state.codeView.setSelectedLines({
      id: reviewId,
      range: selectionRange(comment),
    }, { notify: false });
  });
}

export function syncCommentSummary() {
  const count = state.comments.length;
  if (els.commentSummary) {
    els.commentSummary.textContent = `${count} comment${count === 1 ? "" : "s"}`;
  }
  renderCommentNavigator();
}

export async function saveComments() {
  await requestJSON("/api/comments", {
    method: "PUT",
    body: JSON.stringify({ comments: state.comments }),
  });
  syncCommentSummary();
}

export function handleCommentShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
    return false;
  }
  const key = event.key.toLowerCase();
  if (key === "n") {
    event.preventDefault();
    moveComment(1);
    return true;
  }
  if (key === "p") {
    event.preventDefault();
    moveComment(-1);
    return true;
  }
  return false;
}

function normalizeRange(range) {
  if (range.start <= range.end) {
    return {
      side: range.side || range.endSide || DEFAULT_COMMENT_SIDE,
      start_line: range.start,
      end_line: range.end,
      end_side: range.endSide || range.side || DEFAULT_COMMENT_SIDE,
    };
  }
  return {
    side: range.endSide || range.side || DEFAULT_COMMENT_SIDE,
    start_line: range.end,
    end_line: range.start,
    end_side: range.side || range.endSide || DEFAULT_COMMENT_SIDE,
  };
}

function selectionRange(comment) {
  return {
    start: comment.start_line,
    side: comment.side || DEFAULT_COMMENT_SIDE,
    end: comment.end_line,
    endSide: comment.end_side || comment.side || DEFAULT_COMMENT_SIDE,
  };
}

function annotationLine(comment) {
  return comment.end_line || comment.start_line;
}

function annotationSide(comment) {
  return comment.end_side || comment.side || DEFAULT_COMMENT_SIDE;
}

function sameFileComment(comment, file) {
  return comment.path === file.name;
}

function reviewIdForComment(comment) {
  return state.fileKeyToReviewId.get(fileCommentKey(comment.path)) || "";
}

function rangeLabel(comment) {
  const side = comment.side || "line";
  if (comment.start_line === comment.end_line) {
    return `${side} line ${comment.start_line}`;
  }
  return `${side} lines ${comment.start_line}-${comment.end_line}`;
}

function renderCommentNavigator() {
  if (!els.commentNavigator || !els.commentNavigatorSummary) {
    return;
  }

  const comments = orderedComments();
  const count = comments.length;
  els.commentNavigatorSummary.textContent = String(count);
  els.commentNavigator.replaceChildren();

  if (count === 0) {
    const empty = document.createElement("p");
    empty.className = "comment-nav-empty";
    empty.textContent = "No comments yet.";
    els.commentNavigator.append(empty);
    return;
  }

  const list = document.createElement("div");
  list.className = "comment-nav-list";
  for (const comment of comments) {
    list.append(createCommentNavItem(comment));
  }
  els.commentNavigator.append(list);
}

function createCommentNavItem(comment) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "comment-nav-item";
  button.dataset.active = String(comment.id === activeCommentId());
  button.addEventListener("click", () => {
    jumpToComment(comment.id);
  });

  const meta = document.createElement("span");
  meta.className = "comment-nav-meta";

  const path = document.createElement("span");
  path.className = "comment-nav-path";
  path.textContent = comment.path;

  const line = document.createElement("span");
  line.className = "comment-nav-line";
  line.textContent = rangeLabel(comment);

  const text = document.createElement("span");
  text.className = "comment-nav-text";
  text.textContent = commentSnippet(comment.text);

  meta.append(path, line);
  button.append(meta, text);
  return button;
}

function commentSnippet(text) {
  const singleLine = text.trim().replace(/\s+/g, " ");
  if (singleLine.length <= 120) {
    return singleLine;
  }
  return `${singleLine.slice(0, 117)}...`;
}

function activeCommentId() {
  return state.editingId || state.hoveredCommentId || state.selectedCommentId;
}

function orderedComments() {
  const fileOrder = new Map(state.files.map((file, index) => [file.reviewId, index]));
  return [...state.comments].sort((left, right) => {
    const leftFile = fileOrder.get(reviewIdForComment(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightFile = fileOrder.get(reviewIdForComment(right)) ?? Number.MAX_SAFE_INTEGER;
    if (leftFile !== rightFile) {
      return leftFile - rightFile;
    }
    if (left.start_line !== right.start_line) {
      return left.start_line - right.start_line;
    }
    if (left.end_line !== right.end_line) {
      return left.end_line - right.end_line;
    }
    return left.id.localeCompare(right.id);
  });
}

function moveComment(delta) {
  const comments = orderedComments();
  if (comments.length === 0) {
    return;
  }

  const id = activeCommentId();
  const index = comments.findIndex((comment) => comment.id === id);
  const nextIndex = index < 0
    ? (delta < 0 ? comments.length - 1 : 0)
    : (index + delta + comments.length) % comments.length;
  jumpToComment(comments[nextIndex].id);
}

function jumpToComment(id) {
  const comment = findAnnotationComment(id);
  if (!comment) {
    return;
  }
  const reviewId = reviewIdForComment(comment);
  if (!reviewId) {
    return;
  }

  state.selectedCommentId = comment.id;
  state.editingId = "";
  clearHoveredComment();

  if (state.collapsedFiles.has(reviewId)) {
    state.collapsedFiles.delete(reviewId);
    renderDiffs();
  } else {
    applyActiveSelection();
    renderCommentNavigator();
  }

  if (!state.codeView) {
    return;
  }
  setCurrentPath(reviewId, { scrollDiff: false, selectTree: true });
  state.codeView.scrollTo({
    type: "line",
    id: reviewId,
    lineNumber: annotationLine(comment),
    side: annotationSide(comment),
    align: "center",
    behavior: "instant",
  });
}
