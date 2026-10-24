import type { AutocompleteProvider } from "@earendil-works/pi-tui"

/** Pi 1.4 routes Tab after slash-command arguments through file completion. */
export function cursorFastAutocomplete(current: AutocompleteProvider): AutocompleteProvider {
  const argumentsAt = (lines: string[], line: number, col: number) =>
    line === 0 && /^[ \t]*\/cursor\.fast +/.test((lines[line] ?? "").slice(0, col))

  return {
    triggerCharacters: current.triggerCharacters,
    shouldTriggerFileCompletion(lines, line, col) {
      if (argumentsAt(lines, line, col)) return true
      return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true
    },
    getSuggestions(lines, line, col, options) {
      return current.getSuggestions(lines, line, col, argumentsAt(lines, line, col) ? { ...options, force: false } : options)
    },
    applyCompletion(lines, line, col, item, prefix) {
      return current.applyCompletion(lines, line, col, item, prefix)
    },
  }
}
