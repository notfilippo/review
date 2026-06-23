import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Rows2,
  Search,
  Trash2,
  X,
  createElement,
} from "lucide";

const icons = {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Rows2,
  Search,
  Trash2,
  X,
};

export function createLucideIcon(iconName) {
  const iconNode = icons[iconName];
  if (!iconNode) {
    return undefined;
  }
  const svg = createElement(iconNode);
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

export function setIconButton(button, iconName, label) {
  const icon = createLucideIcon(iconName);
  if (icon) {
    button.replaceChildren(icon);
  } else {
    button.textContent = label;
  }
  button.setAttribute("aria-label", label);
  button.title = label;
}
