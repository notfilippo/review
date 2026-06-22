import { els, state } from "./state.js";

export function computeDiffStats(patch, fileCount) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return {
    files: fileCount,
    additions,
    deletions,
    lines: additions + deletions,
  };
}

export function renderDiffStats() {
  const stats = state.diffStats;
  els.diffStatsSummary.textContent = `${stats.lines.toLocaleString()} lines`;
  els.diffStats.replaceChildren(
    createChangeBar(stats),
    createStatGrid(
      createStatItem("Files", stats.files),
      createStatItem("Additions", stats.additions, "addition"),
      createStatItem("Deletions", stats.deletions, "deletion"),
      createStatItem("Lines", stats.lines),
    ),
  );
}

function createChangeBar(stats) {
  const bar = document.createElement("div");
  bar.className = "change-bar";
  const additions = document.createElement("span");
  additions.className = "addition";
  additions.style.flexGrow = String(stats.additions || 0);
  const deletions = document.createElement("span");
  deletions.className = "deletion";
  deletions.style.flexGrow = String(stats.deletions || 0);
  if (stats.lines === 0) {
    additions.style.flexGrow = "1";
  }
  bar.append(additions, deletions);
  return bar;
}

function createStatGrid(...items) {
  const grid = document.createElement("dl");
  grid.className = "diff-stats-grid";
  grid.append(...items);
  return grid;
}

function createStatItem(label, value, tone = "") {
  const fragment = document.createDocumentFragment();
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.className = tone;
  detail.textContent = value.toLocaleString();
  fragment.append(term, detail);
  return fragment;
}
