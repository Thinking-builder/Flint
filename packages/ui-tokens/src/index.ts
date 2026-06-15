export const flintColors = {
  obsidian: "#0D0D0D",
  surface: "#1A1A1A",
  surface2: "#242424",
  border: "rgba(255,255,255,0.08)",
  spark: "#5EE6A3",
  amber: "#F5C262",
  blue: "#378ADD",
  coral: "#D85A30",
  red: "#E24B4A",
  grayText: "rgba(255,255,255,0.35)"
} as const;

export const taskStatusColors = {
  queued: flintColors.grayText,
  dispatching: flintColors.blue,
  running: flintColors.spark,
  waiting_user: flintColors.amber,
  judging: flintColors.blue,
  review_required: flintColors.coral,
  completed: flintColors.spark,
  failed: flintColors.red,
  cancelled: flintColors.grayText
} as const;

export const flintCssVariables = `
:root {
  --obsidian: ${flintColors.obsidian};
  --surface: ${flintColors.surface};
  --surface-2: ${flintColors.surface2};
  --border: ${flintColors.border};
  --spark-400: ${flintColors.spark};
  --amber-400: ${flintColors.amber};
  --blue-400: ${flintColors.blue};
  --coral-400: ${flintColors.coral};
  --red-400: ${flintColors.red};
  --gray-text: ${flintColors.grayText};
}
`;
