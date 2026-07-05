import { HomeLayout } from "fumadocs-ui/layouts/home";
import {
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
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import type { CSSProperties, ReactNode } from "react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { FadeIn } from "@/components/fade-in";
import { GovernanceLoop } from "@/components/governance-loop";
import { HowToUse } from "@/components/how-to-use";
import { SiteFooter } from "@/components/site-footer";
import { baseOptions } from "@/lib/layout.shared";
import { buildMeta, defaultDescription } from "@/lib/seo";
import { githubUrl } from "@/lib/site-config";
import type { Route } from "./+types/home";

export function meta(_args: Route.MetaArgs) {
  return buildMeta({
    title: "Delta Agents",
    description: defaultDescription,
    path: "/",
    image: "/og/default.png",
  });
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
    title: "Human oversight with real-time events",
    description:
      "High-risk actions pause for approval; the engine emits typed events the moment an escalation, approval request, or task outcome occurs. Dashboards and webhooks react instantly without polling.",
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
  const reduceMotion = useReducedMotion();

  const copyInstall = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <HomeLayout {...baseOptions()}>
      {/* Hero */}
      <section ref={heroRef}>
        <div className="mx-auto max-w-6xl px-6 pb-16 pt-24 sm:pb-36 sm:pt-44">
          <div className="grid items-center gap-16 lg:grid-cols-2 lg:gap-32">
            <FadeIn className="max-w-2xl">
              <h1 className="text-center text-[clamp(2.25rem,1.4rem+3.4vw,3.75rem)] font-bold tracking-tight leading-[1.1] sm:text-left">
                The AI agents framework
                <br />
                <span className="text-[#5F57E3]">with built-in </span>
                <span className="bg-gradient-to-b from-[#fbbf24] via-[#f97316] to-[#ea580c] bg-clip-text text-transparent">
                  governance.
                </span>
              </h1>
              <p className="mt-6 text-center text-[clamp(1.0625rem,0.95rem+0.55vw,1.25rem)] text-fd-muted-foreground max-w-xl leading-normal sm:text-left">
                Delta AI Agents Framework <br className="md:hidden" /> & Runtime
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-4 sm:justify-start">
                <Link
                  className="inline-flex h-11 items-center rounded-lg bg-[#5F57E3] px-6 font-mono text-sm font-semibold text-white transition-colors hover:bg-[#5F57E3]/90"
                  to="/docs"
                >
                  Get Started
                </Link>
                <a
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-fd-border px-6 font-mono text-sm font-medium text-fd-foreground transition-colors hover:bg-fd-accent"
                  href={githubUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <Star className="size-4" />
                  Star on GitHub
                </a>
              </div>
              <div className="mt-10 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 font-mono text-sm text-fd-muted-foreground/80 sm:justify-start">
                <span>Open source</span>
                <span className="text-fd-muted-foreground/40">·</span>
                <span>Free</span>
                <span className="text-fd-muted-foreground/40">·</span>
                <span>Works with Node, Bun &amp; Deno</span>
              </div>
            </FadeIn>
            <div className="relative hidden min-w-0 items-center justify-center lg:flex">
              <motion.span
                className="delta-glow"
                style={{ "--glow": glow } as MotionStyle}
                initial={reduceMotion ? undefined : { opacity: 0, scale: 0.92 }}
                animate={reduceMotion ? undefined : { opacity: 1, scale: 1 }}
                transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
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
        <div className="mx-auto max-w-7xl px-6 py-16 sm:py-28">
          <FadeIn>
            <h2 className="text-center text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground sm:text-left">
              How it works
            </h2>
            <p className="mt-4 max-w-2xl text-center text-[clamp(1rem,0.92rem+0.4vw,1.125rem)] text-fd-muted-foreground leading-relaxed sm:text-left">
              You define the agent, the math based engine supervises, and every
              agent action is validated, authorized, or escalated back to you,
              strict on policy and rules, no prompt hacks!
            </p>
          </FadeIn>
          <FadeIn delay={0.1} className="mt-14 sm:mt-16">
            <GovernanceLoop />
          </FadeIn>
        </div>
      </section>

      {/* How to use the Delta framework */}
      <section className="section-side-glow">
        <div className="mx-auto max-w-7xl px-6 py-16 sm:py-28">
          <FadeIn>
            <h2 className="text-center text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground sm:text-left">
              How to use the Delta framework
            </h2>
            <p className="mt-4 max-w-2xl text-center text-[clamp(1rem,0.92rem+0.4vw,1.125rem)] text-fd-muted-foreground leading-relaxed sm:text-left">
              From zero to a governed agent in four steps.
            </p>
          </FadeIn>
          <div className="mt-14 sm:mt-20">
            <HowToUse />
          </div>
        </div>
      </section>

      {/* Features highlight */}
      <section>
        <div className="mx-auto max-w-7xl px-6 py-16 sm:py-28">
          <FadeIn className="flex items-center justify-center gap-4 sm:justify-start">
            <h2 className="text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground">
              Features highlight
            </h2>
            <Lightbulb
              className="bulb-glow size-8 shrink-0 text-[#F59E0B] sm:size-10"
              aria-hidden="true"
            />
          </FadeIn>
          <div className="mt-14 grid gap-px border border-fd-border bg-fd-border sm:mt-20 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((cap, i) => (
              <FadeIn
                key={cap.title}
                delay={Math.min(i * 0.05, 0.25)}
                className={`border-t-2 p-8 text-center transition-colors hover:bg-fd-accent/30 sm:p-10 sm:text-left ${i === 4 ? "bg-fd-accent/30" : "bg-fd-background"}`}
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
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      {/* More about Delta: badges, install command, docs CTA */}
      <section className="section-more-glow">
        <div className="mx-auto max-w-3xl px-6 pb-16 pt-20 text-center sm:pb-32 sm:pt-40">
          <div className="flex flex-wrap items-start justify-center gap-x-3 gap-y-8 sm:gap-x-12 sm:gap-y-10">
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
            ).map(({ icon: Icon, label, labelClass, colors }, i) => (
              <FadeIn
                key={label}
                delay={i * 0.08}
                className="flex w-[5.5rem] flex-col items-center gap-5 sm:w-36 sm:gap-6"
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
                  <Icon className="size-7 sm:size-8" aria-hidden="true" />
                </span>
                <span
                  className={`font-mono text-xs leading-snug sm:text-sm ${labelClass}`}
                >
                  {label}
                </span>
              </FadeIn>
            ))}
          </div>
          <FadeIn
            delay={0.2}
            className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
          >
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
              href={githubUrl}
              rel="noreferrer"
              target="_blank"
            >
              <Star className="size-4" />
              Star on GitHub
            </a>
          </FadeIn>
        </div>
      </section>

      <SiteFooter />
    </HomeLayout>
  );
}
