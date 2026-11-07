//! Cross-session tools. Every session in this OpenCode process becomes addressable by ID,
//! title or directory: list them, ask one a question and read its answer, rename, move, and
//! interrupt (which also stops its subagents and kills the shells it is running).
//!
//! `session.interrupt` is the same call the subagent tool makes on a child session, so a
//! parent can stop a runaway subagent, and interrupting a session cancels the jobs it owns.

import { Plugin } from "@opencode/plugin"
import { Schema } from "effect"

/** One context row, as `session.context` returns them. */
type SessionMessageInfo = Awaited<ReturnType<Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]["session"]["context"]>>[number]

const DEFAULT_WAIT_MS = 120_000

/** How often the target's transcript is re-read while waiting for its reply. */
const POLL_MS = 400

/** A session id from the list endpoint looks like `ses_…`; anything else is a title search. */
const looksLikeID = (value: string) => /^ses_[A-Za-z0-9]+$/.test(value)

const textOf = (message: SessionMessageInfo | undefined) => {
	if (!message || message.type !== "assistant") return ""
	return message.content
		.flatMap((part) => (part.type === "text" && "text" in part ? [part.text] : []))
		.join("\n")
		.trim()
}

/** Index of the last row that is our own question, matched by its stored text.
 * `prompt()` returns an inbox id, which never appears in the context rows, so the id is a
 * fallback only; the text is what is actually persisted on the delivered user message. */
const lastQuestionIndex = (rows: readonly SessionMessageInfo[], payload: string, admittedID: string) => {
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		const row = rows[i] as { type?: string; text?: unknown }
		if (row.type === "user" && row.text === payload) return i
	}
	for (let i = rows.length - 1; i >= 0; i -= 1) {
		if ((rows[i] as { id?: string }).id === admittedID) return i
	}
	return -1
}

export default Plugin.define({
	id: "session-tools",
	setup: async (ctx) => {
		/** Resolve `sessionID | title | directory` to one session, returning the row it matched. */
		const resolve = async (needle: string) => {
			if (looksLikeID(needle)) {
				const info = await ctx.session.get({ sessionID: needle })
				return { sessionID: info.id, title: info.title ?? "", directory: info.location?.directory ?? "" }
			}
			const page = await ctx.session.list({ search: needle, limit: 50, order: "desc" })
			const rows = page.data
			const exact = rows.find((s) => s.title === needle)
			const contains = rows.find((s) => (s.title ?? "").includes(needle))
			const byDirectory = rows.find((s) => s.location?.directory === needle)
			const hit = exact ?? contains ?? byDirectory
			if (!hit) throw new Error(`No session matches "${needle}". Run session_list to see titles and ids.`)
			return { sessionID: hit.id, title: hit.title ?? "", directory: hit.location?.directory ?? "" }
		}

		/** The provenance line every question carries, e.g.
		 * `[sent from session ses_18f2… model commandcode/deepseek-v4.1-flash#high]`.
		 * Built from the session row rather than from tool arguments, so the sender cannot
		 * omit or forge it, and it always precedes the question text. */
		const senderStamp = async (sessionID: string) => {
			let ref = "unknown"
			try {
				const info = await ctx.session.get({ sessionID })
				const model = info.model
				if (model) {
					const variant = model.variant ? `#${model.variant}` : ""
					ref = `${model.providerID}/${model.id}${variant}`
				}
			} catch {
				// An unresolvable session still gets a stamp; the id alone is the useful half.
			}
			return `[sent from session ${sessionID} model ${ref}]`
		}

		/** Second stamped line: the question is a side errand, not a new task. */
		const RESUME_LINE = "[answer, then continue your own work immediately — do not stop or wait]"

		await ctx.tool.transform((tools) => {
			tools.add({
				name: "session_list",
				description:
					"List OpenCode sessions in this project, newest first. Shows id, title, directory, when it last changed, whether it is running, and the parent for subagent sessions.",
				input: Schema.Struct({
					limit: Schema.optional(Schema.Number.annotate({ description: "How many rows. Default 20." })),
					search: Schema.optional(Schema.String.annotate({ description: "Filter by title or directory text." })),
					directory: Schema.optional(Schema.String.annotate({ description: "Only sessions in this directory." })),
					subagents: Schema.optional(
						Schema.Boolean.annotate({ description: "List subagent sessions too. Default false: top-level only." }),
					),
				}),
				output: Schema.Struct({
					sessions: Schema.Array(
						Schema.Struct({
							id: Schema.String,
							title: Schema.String,
							directory: Schema.String,
							updated: Schema.Number,
							parent: Schema.Union([Schema.String, Schema.Null]),
							running: Schema.Boolean,
						}),
					),
				}),
				execute: async (input) => {
					const page = await ctx.session.list({
						limit: input.limit ?? 20,
						order: "desc",
						search: input.search,
						directory: input.directory,
						parentID: input.subagents ? undefined : null,
					})
					const sessions = page.data.map((s) => ({
						id: s.id,
						title: s.title ?? "(untitled)",
						directory: s.location?.directory ?? "",
						updated: s.time.updated,
						parent: s.parentID ?? null,
						running: s.time.busy !== undefined && (s.time.idle === undefined || s.time.busy > s.time.idle),
					}))
					const lines = sessions
						.map((s) => `${s.running ? "●" : "○"} ${s.title}  ${s.id}  ${s.directory}${s.parent ? `  (child of ${s.parent})` : ""}`)
						.join("\n")
					return { output: { sessions }, content: lines || "No sessions." }
				},
			})

			tools.add({
				name: "session_ask",
				description:
					"Ask another OpenCode session a question and return its answer. Address it by session id, title or directory. The message lands in that session's own conversation, and its reply comes back here. Waits up to `timeout_ms`, then returns whatever it has said so far.",
				input: Schema.Struct({
					session: Schema.String.annotate({ description: "Session id (`ses_…`), title, or directory." }),
					question: Schema.String.annotate({ description: "What to ask, in plain words." }),
					timeout_ms: Schema.optional(Schema.Number.annotate({ description: "How long to wait. Default 120000." })),
					delivery: Schema.optional(
						Schema.Literals(["steer", "queue"]).annotate({
							description:
								"`steer` (default) cuts into the target's running turn; `queue` waits until it finishes its current work.",
						}),
					),
				}),
				output: Schema.Struct({
					sessionID: Schema.String,
					answered: Schema.Boolean,
					answer: Schema.String,
				}),
				execute: async (input, context) => {
					const target = await resolve(input.session)
					// The stamp is built here, never accepted from the caller, so no tool argument
					// can drop or fake it: every question arrives tagged with its sender.
					const stamp = await senderStamp(context.sessionID)
					const payload = `${stamp}\n${RESUME_LINE}\n\n${input.question}`
					// `steer` delivers once the target's current turn finishes and never interrupts
					// it (core's own default). `queue` waits behind work already pending instead.
					const admitted = await ctx.session.prompt({
						sessionID: target.sessionID,
						text: payload,
						delivery: input.delivery ?? "steer",
						metadata: { from_session: context.sessionID, kind: "session_ask" },
					})
					const timeout = input.timeout_ms ?? DEFAULT_WAIT_MS
					const deadline = Date.now() + timeout
					let answer = ""
					// Poll the target's transcript for the first assistant text after our own question,
					// and return the moment it appears. `session.wait` cannot be used here: it gates on
					// the session going idle, so a target that keeps working (steer hands the question
					// into its running turn) would hold the caller until everything it is doing has
					// finished — the whole response, not the answer.
					while (Date.now() < deadline) {
						const rows = await ctx.session.context({ sessionID: target.sessionID })
						// Anchoring on our own question is the only reliable marker: prompt() returns an
						// inbox id, and inbox ids never appear among the context rows. The stored text
						// does, so the last row carrying our exact payload is where this exchange starts.
						const anchor = lastQuestionIndex(rows, payload, admitted.id)
						const turn = anchor >= 0 ? rows.slice(anchor + 1) : []
						answer = turn
							.filter((m) => m.type === "assistant")
							.map(textOf)
							.filter(Boolean)
							.join("\n\n")
						if (answer) break
						await new Promise((resolveTick) => setTimeout(resolveTick, POLL_MS))
					}
					const answered = answer !== ""
					const content = answered
						? answer
						: `(no answer within ${timeout} ms — the session is still working. Ask again rather than reading silence as a no.)`
					return { output: { sessionID: target.sessionID, answered, answer }, content }
				},
			})

			tools.add({
				name: "session_rename",
				description: "Rename a session. Address it by session id, title or directory.",
				input: Schema.Struct({
					session: Schema.String.annotate({ description: "Session id (`ses_…`), title, or directory." }),
					title: Schema.String.annotate({ description: "The new title." }),
				}),
				output: Schema.Struct({ sessionID: Schema.String, title: Schema.String }),
				execute: async (input) => {
					const target = await resolve(input.session)
					await ctx.session.update({ sessionID: target.sessionID, title: input.title })
					return {
						output: { sessionID: target.sessionID, title: input.title },
						content: `Renamed ${target.sessionID} to "${input.title}".`,
					}
				},
			})

			tools.add({
				name: "session_move",
				description: "Move a session to another directory, so its next turn runs there with that project's files and instructions.",
				input: Schema.Struct({
					session: Schema.String.annotate({ description: "Session id (`ses_…`), title, or directory." }),
					directory: Schema.String.annotate({ description: "Destination directory, absolute or relative to the session's own." }),
				}),
				output: Schema.Struct({ sessionID: Schema.String, directory: Schema.String }),
				execute: async (input) => {
					const target = await resolve(input.session)
					const directory = input.directory.startsWith("/")
						? input.directory
						: `${target.directory.replace(/\/$/, "")}/${input.directory}`
					await ctx.session.move({ sessionID: target.sessionID, directory })
					return {
						output: { sessionID: target.sessionID, directory },
						content: `Moved ${target.sessionID} to ${directory}.`,
					}
				},
			})

			tools.add({
				name: "session_interrupt",
				description:
					"Stop a session's current turn: the model loop, any subagent it is waiting on, and the shell commands it started are all interrupted. Address it by session id, title or directory. A session that is idle is left alone.",
				input: Schema.Struct({
					session: Schema.String.annotate({
						description: "Session id (`ses_…`), title, or directory. A subagent's id stops just that subagent.",
					}),
				}),
				output: Schema.Struct({ sessionID: Schema.String, interrupted: Schema.Boolean }),
				execute: async (input) => {
					const target = await resolve(input.session)
					const result = await ctx.session.interrupt({ sessionID: target.sessionID })
					const interrupted = Boolean((result as { interrupted?: boolean })?.interrupted ?? result)
					return {
						output: { sessionID: target.sessionID, interrupted },
						content: interrupted
							? `Interrupted ${target.sessionID}.`
							: `${target.sessionID} was idle; nothing to interrupt.`,
					}
				},
			})
		})
	},
})
