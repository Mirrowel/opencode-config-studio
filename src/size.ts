/**
 * Pure dialog-size math shared by every studio dialog and the size-slider
 * preview. OpenCode's dialog backdrop anchors at terminalHeight / 4 from the
 * top, so a panel taller than 75% of the terminal overflows the bottom edge.
 */
export function computeDialogRows(percent: number, terminalHeight: number, chromeRows: number, minRows: number) {
  const clampedPercent = Math.min(100, Math.max(10, Math.max(1, Math.round(percent)) || 1))
  const backdropBudget = Math.max(minRows + chromeRows, Math.floor(terminalHeight * 0.75) - 1)
  const available = Math.max(minRows, backdropBudget - chromeRows)
  const requested = Math.max(minRows, Math.floor((terminalHeight * clampedPercent) / 100) - chromeRows)
  return {
    /** Rows actually available before the backdrop overflows. */
    availableRows: available,
    /** Rows wanted at this percent, capped to what fits. */
    targetRows: Math.min(requested, available),
  }
}
