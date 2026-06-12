import { appendFile, readFile, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { Agent, CursorAgentError, type AgentOptions, type ModelSelection } from "@cursor/sdk"
import chalk from "chalk"

const ROOT = dirname(fileURLToPath(import.meta.url))
try {
  process.loadEnvFile(join(ROOT, ".env"))
} catch {} // .env is optional
const SKEPTIC_SKILL_PATH = join(ROOT, ".cursor", "skills", "skeptic", "SKILL.md")
const FEEDBACK_LOG_PATH = join(ROOT, "feedback.log")
const EVIDENCE_LEDGER_PATH = join(ROOT, ".cursor", "evidence-ledger.jsonl")

type Role = "researcher" | "skeptic" | "coach"
type LedgerEntry = { event?: string; command?: string; durationMs?: number; exitCode?: number }

const model = (id: string): ModelSelection => ({ id })
const ROLE_MODELS: Record<Role | "verifier", ModelSelection> = {
  researcher: model(process.env.CRUCIBLE_RESEARCHER_MODEL ?? "composer-2"),
  skeptic: model(process.env.CRUCIBLE_SKEPTIC_MODEL ?? "gpt-5.5"),
  coach: model(process.env.CRUCIBLE_COACH_MODEL ?? "gpt-5.5"),
  verifier: model(process.env.CRUCIBLE_VERIFIER_MODEL ?? process.env.CRUCIBLE_SKEPTIC_MODEL ?? "gpt-5.5"),
}
const USE_CLOUD_COACH = process.env.CRUCIBLE_COACH_RUNTIME === "cloud"

function git(...args: string[]) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}
function tryGit(...args: string[]) {
  try { return git(...args).trim() } catch { return undefined }
}
function cloudOptions(): NonNullable<AgentOptions["cloud"]> {
  const remote = tryGit("config", "--get", "remote.origin.url")
  const clean = remote?.trim().replace(/\.git$/, "")
  const repo = clean?.match(/^git@github\.com:(.+\/.+)$/)?.[1]
    ?? clean?.match(/^ssh:\/\/git@github\.com\/(.+\/.+)$/)?.[1]
    ?? clean?.match(/^https:\/\/github\.com\/(.+\/.+)$/)?.[1]
  const url = repo ? `https://github.com/${repo}` : undefined
  if (!url) throw new Error("Cloud coach needs a GitHub remote.origin.url.")
  const branch = tryGit("rev-parse", "--abbrev-ref", "HEAD")
  return { repos: [{ url, ...(branch && branch !== "HEAD" ? { startingRef: branch } : {}) }], autoCreatePR: true, skipReviewerRequest: true }
}

const local = (): NonNullable<AgentOptions["local"]> => ({ cwd: ROOT, settingSources: ["project"] })
const verifier = (): NonNullable<AgentOptions["agents"]> => ({
  verifier: {
    description: "Verify one sourced claim for the Crucible skeptic.",
    model: ROLE_MODELS.verifier,
    prompt: "You are a verifier subagent for Crucible's skeptic.\nVerify exactly one claim. Use shell commands only when they produce useful evidence.\nDo not edit files. Return prose: source check, contradiction/staleness notes, and concise label advice.",
  },
})

async function runAgent(role: Role, prompt: string, echo: boolean, options: { cloudPr?: boolean; subagents?: boolean } = {}) {
  try {
    const createOptions: AgentOptions = {
      apiKey: process.env.CURSOR_API_KEY, name: `Crucible ${role}`, model: ROLE_MODELS[role],
      ...(options.cloudPr ? { cloud: cloudOptions() } : { local: local() }),
      ...(options.subagents ? { agents: verifier() } : {}),
    }
    await using agent = await Agent.create(createOptions)
    const run = await agent.send(prompt)
    console.log(chalk.dim(`[${role}] model=${ROLE_MODELS[role].id} agent=${agent.agentId} run=${run.id}`))
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
    if (result.status !== "finished") throw new Error(`${role} run ended with status "${result.status}".`)
    return { text: (result.result ?? text).trim(), result, agentId: agent.agentId }
  } catch (err) {
    const detail = err instanceof CursorAgentError ? err.message : String(err)
    console.error(chalk.red(`\n${role} call failed: ${detail}`))
    process.exit(1)
  }
}

async function readEvidenceLedger() {
  const raw = await readFile(EVIDENCE_LEDGER_PATH, "utf8").catch(() => "")
  const entries = raw.split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line) as LedgerEntry } catch { return undefined }
  }).filter((entry): entry is LedgerEntry => Boolean(entry?.command))
  const after = entries.filter((entry) => entry.event === "afterShellExecution")
  const source = after.length ? after : entries.filter((entry) => entry.event === "beforeShellExecution")
  if (!source.length) return "No shell commands recorded by the skeptic."
  return source.map((entry, index) => {
    const parts = [`${index + 1}. ${entry.command}`]
    if (typeof entry.durationMs === "number") parts.push(`${Math.round(entry.durationMs / 1000)}s`)
    if (typeof entry.exitCode === "number") parts.push(`exit ${entry.exitCode}`)
    return parts.join(" | ")
  }).join("\n")
}

function printBrief(brief: string, ledger: string) {
  console.log(chalk.bold("\n=== LABELED BRIEF ===\n"))
  for (const line of brief.split("\n")) {
    if (line.includes("VERIFIED")) console.log(chalk.green(line))
    else if (line.includes("CONTESTED")) console.log(chalk.red(line))
    else if (line.includes("WEAK")) console.log(chalk.gray(line))
    else console.log(line)
  }
  console.log(chalk.bold("\n=== EVIDENCE LEDGER ===\n"))
  console.log(chalk.dim(ledger))
}

if (!process.env.CURSOR_API_KEY) fail("CURSOR_API_KEY is not set. Get one at cursor.com/dashboard -> Integrations.")
const question = process.argv.slice(2).join(" ").trim()
if (!question) fail('Usage: pnpm dev "<research question>"')

const priorFeedback = await readFile(FEEDBACK_LOG_PATH, "utf8").catch(() => "")
const runNumber = priorFeedback.split("\n").filter(Boolean).length + 1

console.log(chalk.bold(`Crucible run ${runNumber}`))
console.log(chalk.bold(`Question: ${question}\n`))
console.log(chalk.dim(`models: researcher=${ROLE_MODELS.researcher.id}, skeptic=${ROLE_MODELS.skeptic.id}, verifier=${ROLE_MODELS.verifier.id}, coach=${ROLE_MODELS.coach.id}`))
console.log(chalk.dim(`coach runtime: ${USE_CLOUD_COACH ? "cloud + autoCreatePR" : "local commit"}\n`))

console.log(chalk.bold.cyan("--- Researcher ---"))
const { text: claims } = await runAgent(
  "researcher",
  `You are a researcher. Answer the research question below with a numbered list of 4-7 factual claims in prose. Every claim must explicitly name its source (publication, dataset, institution, or author and year). Output only the numbered claims. Do not edit any files and do not ask questions.\n\nResearch question: ${question}`,
  true
)

console.log(chalk.bold.cyan("\n--- Skeptic (reviewing claims...) ---"))
await writeFile(EVIDENCE_LEDGER_PATH, "")
const { text: brief } = await runAgent(
  "skeptic",
  `Use the project skill named \`skeptic\` to evaluate the claims below. Spawn verifier subagents in parallel when useful. Do not edit files.\n\nClaims to evaluate:\n${claims}`,
  false,
  { subagents: true }
)
const evidenceLedger = await readEvidenceLedger()
const briefWithLedger = `${brief}\n\nEvidence ledger:\n${evidenceLedger}`
printBrief(brief, evidenceLedger)

const rl = createInterface({ input: process.stdin, output: process.stdout })
const feedback = (await rl.question(chalk.bold("\nFeedback on the skeptic (one line, empty to skip): "))).trim()
rl.close()
if (!feedback) {
  console.log("No feedback. Skeptic prompt unchanged.")
  process.exit(0)
}
await appendFile(FEEDBACK_LOG_PATH, `run ${runNumber} | ${new Date().toISOString()} | ${feedback}\n`)

try {
  git("ls-files", "--error-unmatch", ".cursor/skills/skeptic/SKILL.md")
} catch {
  git("add", ".cursor/skills/skeptic/SKILL.md")
  git("commit", "-m", "skeptic: skill v1 baseline", "--", ".cursor/skills/skeptic/SKILL.md")
  console.log(chalk.dim("Committed skeptic skill v1 baseline."))
}

console.log(chalk.bold.cyan("\n--- Coach ---"))
const before = await readFile(SKEPTIC_SKILL_PATH, "utf8")
const feedbackLog = await readFile(FEEDBACK_LOG_PATH, "utf8")
const { text: coachReply, result: coachResult } = await runAgent(
  "coach",
  `You are a skill coach. The file .cursor/skills/skeptic/SKILL.md is Crucible's self-evolving skeptic skill. Make the SMALLEST possible edit to it that addresses the NEWEST feedback line below without violating earlier feedback.\n\nIf the newest feedback contradicts earlier feedback, do NOT edit the file. Instead explain the conflict so a human can resolve it.\n\nIf you do edit, use your file-editing tools on .cursor/skills/skeptic/SKILL.md directly. Edit nothing else, and never run git commands. The very LAST line of your reply must be a single short line (under 60 characters) summarizing what you did, with nothing after it.\n\nFull feedback history (newest entry is run ${runNumber}):\n${feedbackLog}\n\nCurrent .cursor/skills/skeptic/SKILL.md:\n${before}\n\nThis run's labeled brief and evidence ledger:\n${briefWithLedger}`,
  true,
  { cloudPr: USE_CLOUD_COACH }
)

if (USE_CLOUD_COACH) {
  const prUrls = coachResult.git?.branches.map((branch) => branch.prUrl).filter(Boolean) ?? []
  if (prUrls.length) {
    console.log(chalk.bold("\n=== Coach PR ===\n"))
    console.log(prUrls.join("\n"))
  } else {
    console.log(chalk.yellow("\nCloud coach finished. No PR URL was returned; check the cloud agent for conflict/no-op details."))
  }
  process.exit(0)
}

const after = await readFile(SKEPTIC_SKILL_PATH, "utf8")
if (after === before) {
  console.log(chalk.yellow("\nCoach made no edit (conflict or no change needed) - see its reasoning above."))
  console.log(chalk.yellow("Resolve the conflict with a clarifying feedback line on your next run."))
  process.exit(0)
}
const summary = coachReply.split("\n").filter((line) => line.trim()).at(-1)?.trim().slice(0, 72) ?? "prompt update"
git("add", ".cursor/skills/skeptic/SKILL.md")
git("commit", "-m", `skeptic: ${summary} (run ${runNumber}: "${feedback}")`, "--", ".cursor/skills/skeptic/SKILL.md")
console.log(chalk.bold("\n=== skeptic skill diff (just committed) ===\n"))
console.log(git("-c", "color.diff=always", "show", "--format=", "HEAD", "--", ".cursor/skills/skeptic/SKILL.md"))

function fail(message: string): never {
  console.error(chalk.red(message))
  process.exit(1)
}
