import { HomeLayout } from "fumadocs-ui/layouts/home";
import {
  ArrowRight,
  BookOpen,
  Check,
  ClipboardCopy,
  Clock,
  Eye,
  GitBranch,
  Layers,
  Lock,
  MessagesSquare,
  Zap,
} from "lucide-react";
import {
  type MotionStyle,
  motion,
  useScroll,
  useTransform,
} from "motion/react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { GovernanceLoop } from "@/components/governance-loop";
import { HowToUse } from "@/components/how-to-use";
import { ShikiCode } from "@/components/shiki-code";
import { baseOptions } from "@/lib/layout.shared";
import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "Delta Agents" },
    {
      name: "description",
      content:
        "The AI agent framework with built-in safety, governance, and provenance.",
    },
  ];
}

const CAPABILITIES: ReadonlyArray<{
  icon: ReactNode;
  title: string;
  description: string;
  accent: string;
}> = [
  {
    icon: <Lock className="size-5" />,
    title: "Agents cannot execute unsafe actions",
    description:
      "Budget enforcement across token, time, and multi-dimensional levels. Schema validation and prerequisite checks block unsafe actions before they run. Loop detection catches reasoning spirals early.",
    accent: "#E25557",
  },
  {
    icon: <GitBranch className="size-5" />,
    title: "Workflows recover from failure points",
    description:
      "Multi-phase SOPs resume from the failed step, not the start. High-risk operations pause for human approval. The engine resumes from the exact checkpoint once approved.",
    accent: "#5F57E3",
  },
  {
    icon: <MessagesSquare className="size-5" />,
    title: "Agents coordinate through bounded delegation",
    description:
      "Scoped budgets prevent delegation from running away. Automatic retries, restarts, and escalations handle unresponsive teammates. Mailbox read receipts confirm delivery across the team.",
    accent: "#5F57E3",
  },
  {
    icon: <Clock className="size-5" />,
    title: "Agents retrieve context on demand",
    description:
      "Agents retrieve past task context on demand. They record notes and improve on repeated work. Temporal awareness supports time-sensitive decisions.",
    accent: "#2CD46B",
  },
  {
    icon: <Eye className="size-5" />,
    title: "Every action is traceable and auditable",
    description:
      "Every token, action, and decision is traceable and queryable. Trust and risk scores update continuously from observed behavior. Commit history tracks what was done, by whom, and when.",
    accent: "#5F57E3",
  },
  {
    icon: <Zap className="size-5" />,
    title: "Tools operate under the same governance",
    description:
      "Web search, document extraction, and custom tools all route through the same budget and audit pipeline. No exception paths, no untracked side effects.",
    accent: "#F59E0B",
  },
];

const QUICK_START_CODE = `import { createDeltaEngine, Ok } from "delta-agents";
import { z } from "zod";

const delta = await createDeltaEngine({
  apiKey: process.env.OPENAI_API_KEY,
  models: [{ name: "fast", model: "gpt-4o-mini", default: true }],
});

const lookupCustomer = delta.action({
  name: "lookup-customer",
  description: "Look up a customer account by ID",
  risk: 1,
  schema: z.object({ customerId: z.string() }),
  fn: async ({ customerId }) => Ok(await db.customer.find(customerId)),
});

const supportAgent = delta.agent({
  name: "support-agent",
  description: "Handles customer support requests",
  role: "Customer Support Specialist",
  rolePrompt: "Help customers resolve their issues.",
  actions: [lookupCustomer],
});

delta.deploy(supportAgent);

const result = await delta.send({
  goal: "Look up customer C-42",
  agentName: "support-agent",
  input: { customerId: "C-42" },
  budget: { tokens: 5000, durationMs: 30_000 },
});`;

export default function Home() {
  const [copied, setCopied] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  // Glow fades as the hero scrolls out of view and returns on scroll up.
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const glow = useTransform(scrollYProgress, [0, 1], [1, 0.15]);

  const copyCode = async () => {
    await navigator.clipboard.writeText(QUICK_START_CODE);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <HomeLayout {...baseOptions()}>
      {/* Hero */}
      <section ref={heroRef}>
        <div className="mx-auto max-w-5xl px-6 pb-28 pt-36 sm:pb-36 sm:pt-44">
          <div className="grid items-center gap-16 lg:grid-cols-2 lg:gap-24">
            <div className="max-w-2xl">
              <h1 className="text-[clamp(2.25rem,1.4rem+3.4vw,3.75rem)] font-bold tracking-tight leading-[1.1]">
                The AI agent framework
                <br />
                <span className="text-[#5F57E3]">with built-in </span>
                <span className="bg-gradient-to-b from-[#fbbf24] via-[#f97316] to-[#ea580c] bg-clip-text text-transparent">
                  governance.
                </span>
              </h1>
              <p className="mt-6 text-[clamp(1.0625rem,0.95rem+0.55vw,1.25rem)] text-fd-muted-foreground max-w-xl leading-normal">
                Delta's math based engine supervises agents, and guides them
                towards correction or involve you when it can't, no drift,
                strict on policy and rules, no prompt hacks!
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <Link
                  className="inline-flex h-11 items-center rounded-lg bg-[#5F57E3] px-6 font-mono text-sm font-semibold text-white transition-colors hover:bg-[#5F57E3]/90"
                  to="/docs"
                >
                  Get Started
                </Link>
                <Link
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-fd-border px-6 font-mono text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
                  to="/docs/reference"
                >
                  API Reference
                  <ArrowRight className="size-4" />
                </Link>
              </div>
              <div className="mt-7 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-fd-muted-foreground/70">
                <span>Open source</span>
                <span className="text-fd-muted-foreground/40">·</span>
                <span>Free</span>
                <span className="text-fd-muted-foreground/40">·</span>
                <span>Works with Node, Bun &amp; Deno</span>
              </div>
            </div>
            <div className="relative hidden min-w-0 items-center justify-center lg:flex">
              <motion.span
                className="delta-glow"
                style={{ "--glow": glow } as MotionStyle}
                aria-hidden="true"
              >
                δ
              </motion.span>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:py-28">
          <h2 className="text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground">
            How it works
          </h2>
          <p className="mt-4 max-w-2xl text-[clamp(1rem,0.92rem+0.4vw,1.125rem)] text-fd-muted-foreground leading-relaxed">
            You define the agent, the engine supervises it, and the model only
            ever proposes. Every action is validated, authorized, or escalated
            back to you.
          </p>
          <div className="mt-14 sm:mt-16">
            <GovernanceLoop />
          </div>
        </div>
      </section>

      {/* How to use the Delta framework */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-7xl px-6 py-20 sm:py-28">
          <h2 className="text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground">
            How to use the Delta framework
          </h2>
          <p className="mt-4 max-w-2xl text-[clamp(1rem,0.92rem+0.4vw,1.125rem)] text-fd-muted-foreground leading-relaxed">
            From zero to a governed agent in four steps.
          </p>
          <div className="mt-14 sm:mt-20">
            <HowToUse />
          </div>
        </div>
      </section>

      {/* Capabilities */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
          <h2 className="text-xs font-semibold text-[#5F57E3] tracking-widest uppercase mb-10">
            Capabilities
          </h2>
          <div className="grid gap-px border border-fd-border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((cap) => (
              <div
                key={cap.title}
                className="bg-fd-background p-6 transition-colors hover:bg-fd-accent/30 border-t-2"
                style={{ borderTopColor: cap.accent }}
              >
                <span
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: `${cap.accent}15`,
                    color: cap.accent,
                  }}
                >
                  {cap.icon}
                </span>
                <h3 className="mt-4 text-sm font-semibold text-fd-foreground leading-snug">
                  {cap.title}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-fd-muted-foreground">
                  {cap.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Technical credibility */}
      <section className="border-b border-fd-border bg-fd-muted/20">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
          <p className="text-xs font-semibold text-fd-muted-foreground tracking-widest uppercase mb-4">
            Technical Foundation
          </p>
          <h2 className="text-[clamp(1.5rem,1.25rem+1.1vw,1.875rem)] font-semibold text-fd-foreground max-w-3xl tracking-tight">
            Governance is not heuristic. It is control theory applied to agent
            behavior.
          </h2>
          <p className="mt-6 text-base text-fd-muted-foreground max-w-2xl leading-relaxed">
            The engine applies bounded state-space models, Markov constraints,
            Bellman optimization, model predictive control, Kalman estimation,
            and Bayesian updating. Every decision is deterministic, provable,
            and auditable.
          </p>
          <p className="mt-6 text-sm font-semibold text-[#2CD46B] tracking-wide">
            Deterministic. Provable. Auditable.
          </p>
        </div>
      </section>

      {/* Quick start */}
      <section className="border-b border-fd-border">
        <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
          <div className="flex items-end justify-between mb-8">
            <div>
              <h2 className="text-lg font-semibold text-fd-foreground">
                Quick Start
              </h2>
              <p className="mt-1 text-sm text-fd-muted-foreground">
                Build your first governed agent in under a minute.
              </p>
            </div>
            <Link
              to="/docs"
              className="hidden sm:inline-flex items-center gap-1.5 text-sm font-medium text-[#5F57E3] transition-colors hover:text-[#5F57E3]/80"
            >
              Full guide
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
          <div className="relative overflow-x-auto rounded-xl border border-fd-border p-6 quick-start-code">
            <button
              type="button"
              onClick={copyCode}
              className="absolute right-3 top-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-fd-border bg-fd-background px-2.5 text-xs font-medium text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
            >
              {copied ? (
                <>
                  <Check className="size-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <ClipboardCopy className="size-3.5" />
                  Copy
                </>
              )}
            </button>
            <ShikiCode code={QUICK_START_CODE} lang="typescript" />
          </div>
        </div>
      </section>

      {/* Explore */}
      <section>
        <div className="mx-auto max-w-5xl px-6 py-20 sm:py-28">
          <h2 className="text-xs font-semibold text-[#5F57E3] tracking-widest uppercase mb-8">
            Explore
          </h2>
          <div className="mt-4 grid gap-px border border-fd-border bg-fd-border sm:grid-cols-3">
            <Link
              to="/docs"
              className="group flex flex-col bg-fd-background p-6 transition-colors hover:bg-fd-accent"
            >
              <Zap className="size-5 text-fd-muted-foreground transition-colors group-hover:text-[#5F57E3]" />
              <span className="mt-4 text-sm font-semibold text-fd-foreground">
                Getting Started
              </span>
              <span className="mt-1.5 text-xs text-fd-muted-foreground leading-relaxed">
                Install the SDK and build your first governed agent
              </span>
            </Link>

            <Link
              to="/docs/basics"
              className="group flex flex-col bg-fd-background p-6 transition-colors hover:bg-fd-accent"
            >
              <Layers className="size-5 text-fd-muted-foreground transition-colors group-hover:text-[#5F57E3]" />
              <span className="mt-4 text-sm font-semibold text-fd-foreground">
                Basics
              </span>
              <span className="mt-1.5 text-xs text-fd-muted-foreground leading-relaxed">
                Actions, agents, workflows, and tools
              </span>
            </Link>

            <Link
              to="/docs/advanced"
              className="group flex flex-col bg-fd-background p-6 transition-colors hover:bg-fd-accent"
            >
              <BookOpen className="size-5 text-fd-muted-foreground transition-colors group-hover:text-[#5F57E3]" />
              <span className="mt-4 text-sm font-semibold text-fd-foreground">
                Advanced
              </span>
              <span className="mt-1.5 text-xs text-fd-muted-foreground leading-relaxed">
                Multi-agent coordination, channels, memory, and oversight
              </span>
            </Link>
          </div>
        </div>
      </section>
    </HomeLayout>
  );
}
