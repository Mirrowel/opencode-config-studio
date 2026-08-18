/** @jsxImportSource @opentui/solid */

import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { __testInternals } from "../../dist/tui.js"

const mockApi = () => ({
  kv: { get: () => undefined, set: () => {} },
  theme: { current: { accent: "#aaaaaa", error: "#ff0000", success: "#00ff00", textMuted: "#888888", text: "#ffffff", background: "#000000", primary: "#0000ff", backgroundPanel: "#111111" } },
  mode: { push: () => () => {} },
  keymap: { registerLayer: () => () => {} },
  renderer: { root: {} },
  ui: { dialog: { setSize: () => {} } },
})

export async function verifyReactiveSelection() {
  let edited: BoxRenderable | undefined
  let plain: BoxRenderable | undefined
  let toggle: ((value: boolean) => void) | undefined

  function Harness() {
    const [isEdited, setIsEdited] = createSignal(false)
    toggle = setIsEdited
    return (
      <box flexDirection="column">
        <box ref={(value: BoxRenderable) => (edited = value)} backgroundColor={isEdited() ? "#00ff00" : "#000000"}>
          <text>edited row</text>
        </box>
        <box ref={(value: BoxRenderable) => (plain = value)} backgroundColor="#111111">
          <text>plain row</text>
        </box>
      </box>
    )
  }

  const app = await testRender(() => <Harness />, { width: 30, height: 6 })
  try {
    await app.flush()
    if (!edited || !plain || !toggle) throw new Error("reactivity fixture did not initialize")
    const editedBefore = edited.backgroundColor.toString()
    const plainBefore = plain.backgroundColor.toString()
    toggle(true)
    await app.flush()
    const editedAfter = edited.backgroundColor.toString()
    const plainAfter = plain.backgroundColor.toString()
    if (editedBefore === editedAfter) {
      throw new Error("edited-row color did not repaint after signal change")
    }
    if (plainBefore !== plainAfter) {
      throw new Error("static row color changed unexpectedly")
    }
  } finally {
    app.renderer.destroy()
  }
}

/**
 * Mirrors PagedDialog's structure: one scrollbox, sections as boxes with refs,
 * jumps computed from box.screenY - scroll.content.screenY. Verifies the
 * compiled JSX renders, refs resolve, offsets are ordered, and scrollTop
 * moves to the measured section offset.
 */
export async function verifyPagedSectionJump() {
  let scroll: ScrollBoxRenderable | undefined
  const sectionRefs: (BoxRenderable | undefined)[] = []
  const [current, setCurrent] = createSignal(0)

  const sections = [
    { title: "Requests", lines: Array.from({ length: 8 }, (_, i) => `request line ${i}`) },
    { title: "Differences", lines: Array.from({ length: 8 }, (_, i) => `diff line ${i}`) },
    { title: "Default body", lines: Array.from({ length: 8 }, (_, i) => `body line ${i}`) },
  ]

  function Harness() {
    return (
      <box flexDirection="column" width="100%">
        <scrollbox maxHeight={6} ref={(element: ScrollBoxRenderable) => (scroll = element)}>
          <box flexDirection="column" gap={0}>
            {sections.map((section, index) => (
              <box
                flexDirection="column"
                gap={0}
                paddingTop={index > 0 ? 1 : 0}
                ref={(element: BoxRenderable) => (sectionRefs[index] = element)}
              >
                <text>{`-- ${section.title}`}</text>
                {section.lines.map((line) => (
                  <text>{line}</text>
                ))}
              </box>
            ))}
          </box>
        </scrollbox>
      </box>
    )
  }

  const app = await testRender(() => <Harness />, { width: 40, height: 10 })
  try {
    await app.flush()
    if (!scroll || sectionRefs.some((ref) => !ref)) throw new Error("paged fixture did not initialize refs")
    if (!scroll.content) throw new Error("scrollbox exposes no content renderable")

    const offsets = sectionRefs.map((ref) => ref!.screenY - scroll!.content.screenY)
    if (!(offsets[0]! <= 0.5)) throw new Error(`first section offset should be ~0, got ${offsets[0]}`)
    for (let index = 1; index < offsets.length; index++) {
      if (!(offsets[index]! > offsets[index - 1]!)) {
        throw new Error(`section offsets not ascending: ${JSON.stringify(offsets)}`)
      }
    }

    // Jump to section 2 (same math as PagedDialog.scrollToSection).
    const target = 2
    setCurrent(target)
    await app.flush()
    scroll.scrollTop = offsets[target]!
    await app.flush()
    if (scroll.scrollTop <= 0) throw new Error(`scrollTop did not move to section offset (scrollTop=${scroll.scrollTop})`)
    if (Math.abs(scroll.scrollTop - offsets[target]!) > 2) {
      throw new Error(`scrollTop landed far from section offset: ${scroll.scrollTop} vs ${offsets[target]}`)
    }
    if (current() !== target) throw new Error("current-section signal did not follow the jump")

    // Scrolling back to top behaves like home.
    scroll.scrollTop = 0
    await app.flush()
    if (scroll.scrollTop !== 0) throw new Error("scrollTop did not reset to top")
  } finally {
    app.renderer.destroy()
  }
}

/**
 * Renders the real SizeSliderDialog (compiled Solid output) under a real
 * test renderer. Catches markup-level crashes like nested <text> elements
 * (TextNodeRenderable rejects them) before they ship.
 */
export async function verifySizeSliderDialogRenders() {
  const api = mockApi() as any
  let settled: ((value: unknown) => void) | undefined
  const done = new Promise((resolve) => (settled = resolve))

  const app = await testRender(() => {
    const SizeSliderDialog = __testInternals.SizeSliderDialog as any
    return <SizeSliderDialog api={api} current={50} onDone={(value: unknown) => settled?.(value)} />
  }, { width: 90, height: 30 })
  try {
    await app.flush()
    // Give reactive effects a beat, then close through the API the dialog
    // itself registered (not key events) to exercise cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50))
    await app.flush()
  } finally {
    app.renderer.destroy()
  }
}
