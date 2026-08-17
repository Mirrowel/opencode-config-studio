/** @jsxImportSource @opentui/solid */

import type { BoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"

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
