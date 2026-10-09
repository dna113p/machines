import { raise } from "xstate";
import { human, operation, final, type Event, type HumanOptions, type HumanPrompt } from "./index.ts";

export interface ConversationMessage { readonly role: "human" | "agent"; readonly text: string }
export type ConversationOptions = HumanOptions & {
  readonly prompt: HumanPrompt;
  /** The Machine owns this responder and any original native session it resumes. */
  readonly reply: (question: string, history: readonly ConversationMessage[]) => string | Promise<string>;
  readonly maxQuestions?: number;
};

/** A Human -> clarification -> Human state, completed only by an explicit answer.
 * It creates no assistant and makes no native-session claim. The owner supplies
 * its retained session's responder, or an explicitly identified fallback.
 */
export function conversation<const TOn extends Readonly<Record<string, unknown>>>(
  options: ConversationOptions, on: TOn,
) {
  let question = "";
  let answer = "";
  let reply = "";
  let questions = 0;
  const history: ConversationMessage[] = [];
  const limit = options.maxQuestions ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("Invalid conversation question limit");
  const prompt = () => {
    const original = typeof options.prompt === "function" ? options.prompt() : options.prompt;
    return reply ? `${reply}\n\n${original}` : original;
  };
  const inputOptions = options.choices !== undefined
    ? { choices: options.choices, discussion: true }
    : { suggestions: options.suggestions, discussion: true };
  return {
    initial: "waiting",
    states: {
      waiting: human(prompt, {
        submitted: { target: "answered", actions: ({ event }: { event: Event }) => { answer = String(event.value); } },
        question: { target: "clarifying", actions: ({ event }: { event: Event }) => { question = String(event.value); } },
      }, inputOptions),
      clarifying: operation(async () => {
        if (++questions > limit) throw new Error("Conversation question limit reached; inspect before continuing");
        history.push({ role: "human", text: question });
        const result = await options.reply(question, history.map(message => ({ ...message })));
        if (typeof result !== "string" || !result.trim() || result.length > 32000) throw new Error("Conversation reply must contain 1–32000 characters");
        reply = result;
        history.push({ role: "agent", text: result });
        return { type: "replied" };
      }, { replied: "waiting" }),
      answered: final(),
    },
    onDone: { actions: raise(() => ({ type: "submitted", value: answer })) },
    on,
  } as const;
}
