import { appendFile, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { Agent, CursorAgentError } from "@cursor/sdk"
import chalk from "chalk"

const ROOT = dirname(fileURLToPath(import.meta.url))
try {
  process.loadEnvFile(join(ROOT, ".env"))
} catch {} // .env is optional
const SKEPTIC_PROMPT_PATH = join(ROOT, "prompts", "skeptic.md")
const FEEDBACK_LOG_PATH = join(ROOT, "feedback.log")
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5"

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

async function runAgent(name: string, prompt: string, echo: boolean) {
  try {
    await using agent = await Agent.create({
      apiKey: process.env.CURSOR_API_KEY,
      name: `Crucible ${name}`,
      model: { id: MODEL },
      local: { cwd: ROOT },
    })
    const run = await agent.send(prompt)
    let text = ""
    for await (const event of run.stream()) {
      if (event.type !== "assistant") continue
      for (const block of event.message.content) {
        if (block.type === "text") {
          text += block.text
          if (echo) process.stdout.write(chalk.dim(block.text))
        }
      }
    }
    if (echo) process.stdout.write("\n")
    const result = await run.wait()
    if (result.status !== "finished") {
      console.error(chalk.red(`${name} run ended with status "${result.status}". Aborting.`))
      process.exit(2)
    }
    return text.trim()
  } catch (err) {
    const detail = err instanceof CursorAgentError ? err.message : String(err)
    console.error(chalk.red(`\n${name} call failed: ${detail}`))
    process.exit(1)
  }
}

function printBrief(brief: string) {
  console.log(chalk.bold("\n=== LABELED BRIEF ===\n"))
  for (const line of brief.split("\n")) {
    if (line.includes("VERIFIED")) console.log(chalk.green(line))
    else if (line.includes("CONTESTED")) console.log(chalk.red(line))
    else if (line.includes("WEAK")) console.log(chalk.gray(line))
    else console.log(line)
  }
}

if (!process.env.CURSOR_API_KEY) {
  console.error(chalk.red("CURSOR_API_KEY is not set. Get one at cursor.com/dashboard -> Integrations."))
  process.exit(1)
}
const question = process.argv.slice(2).join(" ").trim()
if (!question) {
  console.error('Usage: pnpm dev "<research question>"')
  process.exit(1)
}

// Run number = how many feedback entries exist so far, plus one.
const priorFeedback = await readFile(FEEDBACK_LOG_PATH, "utf8").catch(() => "")
const runNumber = priorFeedback.split("\n").filter(Boolean).length + 1

console.log(chalk.bold(`Crucible run ${runNumber}`))
console.log(chalk.bold(`Question: ${question}\n`))

// 1. RESEARCHER
console.log(chalk.bold.cyan("--- Researcher ---"))
const claims = await runAgent(
  "researcher",
  [
    "You are a researcher. Answer the research question below with a numbered",
    "list of 4-7 factual claims in prose. Every claim must explicitly name its",
    "source (publication, dataset, institution, or author and year). Output only",
    "the numbered claims. Do not edit any files and do not ask questions.",
    "",
    `Research question: ${question}`,
  ].join("\n"),
  true
)

// 2. SKEPTIC (system prompt loaded from prompts/skeptic.md at runtime)
console.log(chalk.bold.cyan("\n--- Skeptic (reviewing claims...) ---"))
const skepticPrompt = await readFile(SKEPTIC_PROMPT_PATH, "utf8")
const brief = await runAgent(
  "skeptic",
  `${skepticPrompt}\nDo not edit any files.\n\nClaims to evaluate:\n\n${claims}`,
  false
)

// 3. Labeled brief
printBrief(brief)

// 4. Feedback
const rl = createInterface({ input: process.stdin, output: process.stdout })
const feedback = (await rl.question(chalk.bold("\nFeedback on the skeptic (one line, empty to skip): "))).trim()
rl.close()
if (!feedback) {
  console.log("No feedback. Skeptic prompt unchanged.")
  process.exit(0)
}
await appendFile(FEEDBACK_LOG_PATH, `run ${runNumber} | ${new Date().toISOString()} | ${feedback}\n`)

// Ensure v1 of skeptic.md is committed so every coach edit has a clean diff.
try {
  git("ls-files", "--error-unmatch", "prompts/skeptic.md")
} catch {
  git("add", "prompts/skeptic.md")
  git("commit", "-m", "skeptic: v1 baseline", "--", "prompts/skeptic.md")
  console.log(chalk.dim("Committed skeptic.md v1 baseline."))
}

// 5. COACH
console.log(chalk.bold.cyan("\n--- Coach ---"))
const before = await readFile(SKEPTIC_PROMPT_PATH, "utf8")
const feedbackLog = await readFile(FEEDBACK_LOG_PATH, "utf8")
const coachReply = await runAgent(
  "coach",
  [
    "You are a prompt coach. The file prompts/skeptic.md (in your workspace) is",
    "the system prompt of a skeptic agent that labels research claims. Your job:",
    "make the SMALLEST possible edit to prompts/skeptic.md that addresses the",
    "NEWEST feedback line below without violating any earlier feedback.",
    "",
    "If the newest feedback contradicts earlier feedback, do NOT edit the file.",
    "Instead explain the conflict so a human can resolve it.",
    "",
    "If you do edit, use your file-editing tools on prompts/skeptic.md directly.",
    "Edit nothing else, and never run git commands. The very LAST line of your",
    "reply must be a single short line (under 60 characters) summarizing what",
    "you did, with nothing after it.",
    "",
    `Full feedback history (newest entry is run ${runNumber}):\n${feedbackLog}`,
    `Current prompts/skeptic.md:\n${before}`,
    `This run's labeled brief:\n${brief}`,
  ].join("\n"),
  true
)

// 6. Commit the edit (or surface the conflict).
const after = await readFile(SKEPTIC_PROMPT_PATH, "utf8")
if (after === before) {
  console.log(chalk.yellow("\nCoach made no edit (conflict or no change needed) - see its reasoning above."))
  console.log(chalk.yellow("Resolve the conflict with a clarifying feedback line on your next run."))
  process.exit(0)
}
const summary = coachReply.split("\n").filter((line) => line.trim()).at(-1)?.trim().slice(0, 72) ?? "prompt update"
git("add", "prompts/skeptic.md")
git("commit", "-m", `skeptic: ${summary} (run ${runNumber}: "${feedback}")`, "--", "prompts/skeptic.md")
console.log(chalk.bold("\n=== skeptic.md diff (just committed) ===\n"))
console.log(git("-c", "color.diff=always", "show", "--format=", "HEAD", "--", "prompts/skeptic.md"))
