import { ShikiCode } from "@/components/shiki-code";

/* all card backdrops share the purple accent; step numbers rotate
   through the brand palette like the rest of the page */
const CARD_ACCENT = "#5F57E3";

const STEPS: ReadonlyArray<{
  accent: string;
  title: string;
  description: string;
  code: string;
}> = [
  {
    accent: "#5F57E3",
    title: "Create the engine",
    description:
      "One engine owns everything: model access, budgets, policies, and the audit trail. Point it at a provider and pick your models.",
    code: `import { createDeltaEngine, Ok } from "delta-agents";

const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
});`,
  },
  {
    accent: "#F97316",
    title: "Define a governed action",
    description:
      "Actions declare their schema and risk score up front. The engine validates every call against them, so nothing malformed or over-risk ever runs.",
    code: `const lookupCustomer = delta.action({
  name: "lookup-customer",
  description: "Look up a customer account by ID",
  risk: 1,
  schema: z.object({ customerId: z.string() }),
  fn: async ({ customerId }) => Ok(await db.customer.find(customerId)),
});`,
  },
  {
    accent: "#2CD46B",
    title: "Compose the agent",
    description:
      "Give the agent a role and only the actions it is allowed to use. Its capabilities are the list you hand it, nothing more.",
    code: `const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles customer support requests",
  role: "Customer Support Specialist",
  rolePrompt: "Help customers resolve their issues.",
  actions: [lookupCustomer],
});`,
  },
  {
    accent: "#8B5CF6",
    title: "Deploy and send work",
    description:
      "One line deploys the agent. Every run carries a budget, and the engine supervises it from goal to result.",
    code: `delta.deploy(supportAgent);

const result = await delta.send({
  goal: "Look up customer C-42",
  agentName: "support-agent",
  input: { customerId: "C-42" },
  budget: { tokens: 5000, durationMs: 30_000 },
});`,
  },
];

export function HowToUse() {
  return (
    <div className="flex flex-col gap-16 sm:gap-20">
      {STEPS.map((step, i) => (
        <div
          key={step.title}
          className="grid items-center gap-8 md:grid-cols-5 md:gap-14"
        >
          <div className={`md:col-span-2 ${i % 2 === 1 ? "md:order-2" : ""}`}>
            <span
              className="font-mono text-sm font-semibold"
              style={{ color: step.accent }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3 className="mt-2 text-xl font-semibold text-fd-foreground sm:text-2xl">
              {step.title}
            </h3>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-fd-muted-foreground sm:text-base">
              {step.description}
            </p>
          </div>
          <div
            className={`min-w-0 md:col-span-3 ${i % 2 === 1 ? "md:order-1" : ""}`}
          >
            <div
              className="texture-card rounded-xl border p-5 transition-transform duration-300 ease-out motion-safe:hover:scale-[1.02] sm:p-8"
              style={{
                backgroundColor: `${CARD_ACCENT}0f`,
                borderColor: `${CARD_ACCENT}26`,
              }}
            >
              <div className="quick-start-code overflow-x-auto rounded-lg border border-fd-border p-5 text-[13px] leading-relaxed shadow-lg [&_pre]:!bg-transparent">
                <ShikiCode code={step.code} lang="typescript" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
