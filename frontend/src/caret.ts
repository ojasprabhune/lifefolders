let ctx: CanvasRenderingContext2D | null = null

function measureCtx(): CanvasRenderingContext2D {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')
  return ctx as CanvasRenderingContext2D
}

/**
 * Horizontal caret position inside a single-line `<input>`, relative to the
 * input's own left edge - no existing caret-measurement code in this
 * codebase, built from the standard canvas-text-width technique since a
 * plain input has no API for it. Single-line only; there is no line-wrap
 * math to do here.
 */
export function measureCaretOffset(input: HTMLInputElement, index: number): number {
  const c = measureCtx()
  const style = getComputedStyle(input)
  // `font` comes back populated for a rendered element in every evergreen
  // browser; the parts are composed only as a fallback.
  c.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily}`
  if ('letterSpacing' in c) c.letterSpacing = style.letterSpacing
  const width = c.measureText(input.value.slice(0, index)).width
  const left = width - input.scrollLeft + parseFloat(style.paddingLeft || '0')
  // A caret scrolled out of view horizontally shouldn't place the dropdown
  // off to the side or at a negative offset.
  return Math.max(0, Math.min(left, input.clientWidth))
}
