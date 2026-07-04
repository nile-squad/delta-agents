import { HomeLayout } from "fumadocs-ui/layouts/home";
import {
  ArrowRight,
  Award,
  Check,
  ClipboardCopy,
  Clock,
  Cpu,
  Eye,
  GitBranch,
  Lightbulb,
  Lock,
  Medal,
  MessagesSquare,
  Route as RouteIcon,
  Send,
  Star,
  Trophy,
  Zap,
} from "lucide-react";
import {
  type MotionStyle,
  motion,
  useScroll,
  useTransform,
} from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { GovernanceLoop } from "@/components/governance-loop";
import { HowToUse } from "@/components/how-to-use";
import { baseOptions } from "@/lib/layout.shared";
import { appName, gitConfig } from "@/lib/shared";
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
  {
    icon: <RouteIcon className="size-5" />,
    title: "Workflows run deterministically",
    description:
      "Multi-phase SOPs run the same way every time, regardless of which model executes them. Conditional branching and declared prerequisites keep execution predictable.",
    accent: "#8B5CF6",
  },
  {
    icon: <Send className="size-5" />,
    title: "Agents work in your channels",
    description:
      "Agents communicate through Slack, Teams, Discord, or Telegram. Execution is decoupled from delivery, so agents keep working even when a channel is down.",
    accent: "#2CD46B",
  },
  {
    icon: <Cpu className="size-5" />,
    title: "Bring your own models",
    description:
      "OpenAI, OpenRouter, or any OpenAI-compatible endpoint. Swap models freely; the governance layer stays exactly the same.",
    accent: "#F97316",
  },
];

const INSTALL_COMMAND = "npm install delta-agents";

export default function Home() {
  const [copied, setCopied] = useState(false);
  const heroRef = useRef<HTMLElement>(null);
  // Glow fades as the hero scrolls out of view and returns on scroll up.
  const { scrollYProgress } = useScroll({
    target: heroRef,
    offset: ["start start", "end start"],
  });
  const glow = useTransform(scrollYProgress, [0, 1], [1, 0.15]);

  const copyInstall = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
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
      <section>
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
      <section>
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

      {/* Features highlight */}
      <section>
        <div className="mx-auto max-w-7xl px-6 py-20 sm:py-28">
          <div className="flex items-center gap-4">
            <h2 className="text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground">
              Features highlight
            </h2>
            <Lightbulb
              className="bulb-glow size-8 shrink-0 text-[#F59E0B] sm:size-10"
              aria-hidden="true"
            />
          </div>
          <div className="mt-14 grid gap-px border border-fd-border bg-fd-border sm:mt-20 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((cap) => (
              <div
                key={cap.title}
                className="border-t-2 bg-fd-background p-8 transition-colors hover:bg-fd-accent/30 sm:p-10"
                style={{ borderTopColor: cap.accent }}
              >
                <span
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: `${cap.accent}15`,
                    color: cap.accent,
                  }}
                >
                  {cap.icon}
                </span>
                <h3 className="mt-5 text-base font-semibold text-fd-foreground leading-snug">
                  {cap.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
                  {cap.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* More about Delta: badges, install command, docs CTA */}
      <section>
        <div className="mx-auto max-w-3xl px-6 pb-24 pt-28 text-center sm:pb-32 sm:pt-40">
          <div className="flex flex-wrap items-start justify-center gap-x-12 gap-y-10">
            {(
              [
                {
                  icon: Award,
                  label: "Open source",
                  labelClass: "text-[#4a43c4] dark:text-[#9d97ff]",
                  colors: { hi: "#9d97ff", mid: "#5F57E3", lo: "#443DBB" },
                },
                {
                  icon: Medal,
                  label: "Free",
                  labelClass: "text-[#1b7d43] dark:text-[#5ee695]",
                  colors: { hi: "#5ee695", mid: "#2CD46B", lo: "#178a45" },
                },
                {
                  icon: Trophy,
                  label: "Node, Bun & Deno",
                  labelClass: "text-[#b45309] dark:text-[#fbbf24]",
                  colors: { hi: "#fbbf24", mid: "#f97316", lo: "#ea580c" },
                },
              ] as const
            ).map(({ icon: Icon, label, labelClass, colors }) => (
              <div
                key={label}
                className="flex w-36 flex-col items-center gap-4"
              >
                <span
                  className="award-badge"
                  style={
                    {
                      "--badge-hi": colors.hi,
                      "--badge-mid": colors.mid,
                      "--badge-lo": colors.lo,
                    } as CSSProperties
                  }
                >
                  <Icon className="size-6" aria-hidden="true" />
                </span>
                <span
                  className={`font-mono text-xs leading-snug ${labelClass}`}
                >
                  {label}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <div className="quick-start-code flex h-11 items-center gap-3 rounded-lg border border-[#F97316]/30 pl-4 pr-2 font-mono text-sm text-fd-foreground/90">
              <span aria-hidden="true" className="text-[#F97316]/70">
                $
              </span>
              {INSTALL_COMMAND}
              <button
                type="button"
                onClick={copyInstall}
                aria-label="Copy install command"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground"
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <ClipboardCopy className="size-3.5" />
                )}
              </button>
            </div>
            <a
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-gradient-to-b from-[#fbbf24] via-[#f97316] to-[#ea580c] px-6 font-mono text-sm font-semibold text-white transition-opacity hover:opacity-90"
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer"
              target="_blank"
            >
              <Star className="size-4" />
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-fd-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
          <div className="flex items-center gap-2.5">
            <img
              src="/delta-logo.svg"
              alt=""
              width="20"
              height="20"
              className="size-5 rounded"
            />
            <span className="text-sm font-semibold text-fd-foreground">
              {appName}
            </span>
            <span className="font-mono text-xs text-fd-muted-foreground/70">
              free and open source
            </span>
          </div>
          <nav className="flex items-center gap-6 font-mono text-xs text-fd-muted-foreground">
            <Link
              className="transition-colors hover:text-fd-foreground"
              to="/docs"
            >
              Docs
            </Link>
            <Link
              className="transition-colors hover:text-fd-foreground"
              to="/docs/reference"
            >
              API Reference
            </Link>
            <a
              className="transition-colors hover:text-fd-foreground"
              href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
              rel="noreferrer"
              target="_blank"
            >
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </HomeLayout>
  );
}
