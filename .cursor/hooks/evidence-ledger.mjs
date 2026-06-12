import { appendFile, mkdir } from "node:fs/promises"

const input = await new Promise((resolve) => {
  let data = ""
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", (chunk) => {
    data += chunk
  })
  process.stdin.on("end", () => resolve(data))
})

let payload = {}
try {
  payload = input.trim() ? JSON.parse(input) : {}
} catch {
  payload = {}
}

const event = typeof payload.hook_event_name === "string"
  ? payload.hook_event_name
  : typeof payload.command === "string" && typeof payload.output === "string"
    ? "afterShellExecution"
    : typeof payload.command === "string"
      ? "beforeShellExecution"
      : "unknown"

const record = {
  timestamp: new Date().toISOString(),
  event,
  ...(typeof payload.cwd === "string" ? { cwd: payload.cwd } : {}),
  ...(typeof payload.command === "string" ? { command: payload.command } : {}),
  ...(typeof payload.duration === "number" ? { durationMs: payload.duration } : {}),
  ...(typeof payload.duration_ms === "number" ? { durationMs: payload.duration_ms } : {}),
  ...(typeof payload.exit_code === "number" ? { exitCode: payload.exit_code } : {}),
  ...(typeof payload.exitCode === "number" ? { exitCode: payload.exitCode } : {}),
  ...(typeof payload.output === "string" ? { outputLength: payload.output.length } : {}),
}

await mkdir(".cursor", { recursive: true })
await appendFile(".cursor/evidence-ledger.jsonl", `${JSON.stringify(record)}\n`)

if (event === "beforeShellExecution") {
  console.log(JSON.stringify({ permission: "allow" }))
} else {
  console.log("{}")
}
