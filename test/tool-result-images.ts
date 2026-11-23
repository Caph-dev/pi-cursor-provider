import assert from "node:assert/strict"
import test from "node:test"
import { toChat } from "../src/pi-stream.ts"

test("tool images follow the complete parallel result batch", () => {
  const url = "data:image/png;base64,AQID"
  const messages = toChat([
    { role: "toolResult", toolCallId: "a", toolName: "read", timestamp: 0, isError: false,
      content: [{ type: "text", text: "Screenshot" }, { type: "image", mimeType: "image/png", data: "AQID" }] },
    { role: "toolResult", toolCallId: "b", toolName: "read", timestamp: 0, isError: true,
      content: [{ type: "text", text: "not found" }] },
  ], "")
  assert.deepEqual(messages, [
    { role: "tool", tool_call_id: "a", content: "Screenshot[image attached]" },
    { role: "tool", tool_call_id: "b", content: "not found", isError: true },
    { role: "user", content: [
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url } },
    ] },
  ])
})
