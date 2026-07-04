import {
  BrainCircuit,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleUser,
  ShieldCheck,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { ShikiCode } from "@/components/shiki-code";

/* the loop walked step by step: define → engine → model → propose →
   decide (approve / ask) → back to you */
const STEP_SEQUENCE = [
  "you-code",
  "arrow-define",
  "arrow-goal",
  "model-proposal",
  "arrow-proposed",
  "pill-approve",
  "pill-ask",
  "arrow-approval",
] as const;

type StepId = (typeof STEP_SEQUENCE)[number];

function Node({
  icon,
  accent,
  featured,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  accent: string;
  featured?: boolean;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="loop-node flex h-full cursor-pointer flex-col rounded-xl border-2 bg-fd-background p-6 sm:p-8"
      style={{
        borderColor: featured ? `${accent}66` : `${accent}33`,
        boxShadow: featured
          ? `0 0 32px ${accent}2e, 0 0 12px ${accent}1f`
          : `0 0 24px ${accent}1f`,
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accent}1f`, color: accent }}
        >
          {icon}
        </span>
        <span className="text-lg font-semibold text-fd-foreground">
          {title}
        </span>
      </div>
      <p className="mt-4 text-sm leading-relaxed text-fd-muted-foreground">
        {description}
      </p>
      {children}
    </div>
  );
}

function ArrowH({
  label,
  reverse,
  active,
  accent,
}: {
  label: string;
  reverse?: boolean;
  active: boolean;
  accent: string;
}) {
  return (
    <div className="flex flex-col gap-2 px-1">
      <span
        className="text-center font-mono text-xs leading-tight text-fd-foreground/80 transition-colors duration-500"
        style={{ color: active ? accent : undefined }}
      >
        {label}
      </span>
      <div
        className="flex items-center text-fd-foreground/60 transition-colors duration-500"
        style={{ color: active ? accent : undefined }}
      >
        {reverse && <ChevronLeft className="-mr-2 size-4 shrink-0" />}
        <div
          className={`flow-line-h flex-1 ${reverse ? "flow-reverse" : ""}`}
        />
        {!reverse && <ChevronRight className="-ml-2 size-4 shrink-0" />}
      </div>
    </div>
  );
}

function ArrowV({
  label,
  reverse,
  active,
  accent,
}: {
  label: string;
  reverse?: boolean;
  active: boolean;
  accent: string;
}) {
  return (
    <div className="flex w-32 flex-col items-center gap-2">
      <div
        className="flex h-12 flex-col items-center text-fd-foreground/60 transition-colors duration-500"
        style={{ color: active ? accent : undefined }}
      >
        {reverse && <ChevronUp className="-mb-2 size-4 shrink-0" />}
        <div
          className={`flow-line-v flex-1 ${reverse ? "flow-reverse" : ""}`}
        />
        {!reverse && <ChevronDown className="-mt-2 size-4 shrink-0" />}
      </div>
      <span
        className="text-center font-mono text-xs leading-tight text-fd-foreground/80 transition-colors duration-500"
        style={{ color: active ? accent : undefined }}
      >
        {label}
      </span>
    </div>
  );
}

export function GovernanceLoop() {
  const [step, setStep] = useState<StepId>("you-code");

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % STEP_SEQUENCE.length;
      setStep(STEP_SEQUENCE[i]);
    }, 1600);
    return () => clearInterval(id);
  }, []);

  const highlight = (id: StepId, accent: string) =>
    ({
      className: `loop-step ${step === id ? "loop-step-active" : ""}`,
      style: { "--step-accent": accent } as CSSProperties,
    }) as const;

  const youCode = highlight("you-code", "#5F57E3");
  const modelProposal = highlight("model-proposal", "#8B5CF6");
  const pillApprove = highlight("pill-approve", "#2CD46B");
  const pillAsk = highlight("pill-ask", "#F59E0B");

  const you = (
    <Node
      icon={<CircleUser className="size-5" />}
      accent="#5F57E3"
      title="You"
      description="Define the agent, its actions, and the policies it must obey. Approve the calls the engine escalates."
    >
      <div
        className={`quick-start-code mt-6 overflow-x-auto rounded-lg border border-fd-border p-4 text-xs leading-relaxed ${youCode.className}`}
        style={youCode.style}
      >
        <ShikiCode
          code={`const support = delta.agent({
  name: "support-agent",
  actions: [lookupCustomer],
});
delta.deploy(support);`}
          lang="typescript"
        />
      </div>
    </Node>
  );

  const engine = (
    <Node
      icon={<ShieldCheck className="size-5" />}
      accent="#F97316"
      featured
      title="Delta Engine"
      description="Validates schema, budget, and risk. Authorizes or escalates every proposed action, and audits the whole run."
    >
      <div className="mt-6 flex flex-col gap-4 font-mono text-xs">
        <span
          className={`rounded-md border border-[#2CD46B]/40 bg-[#2CD46B]/10 px-3 py-2.5 text-[#1fa855] dark:text-[#2CD46B] ${pillApprove.className}`}
          style={pillApprove.style}
        >
          within policy → approve &amp; execute
        </span>
        <span
          className={`rounded-md border border-[#F59E0B]/40 bg-[#F59E0B]/10 px-3 py-2.5 text-[#b45309] dark:text-[#F59E0B] ${pillAsk.className}`}
          style={pillAsk.style}
        >
          beyond policy → ask you
        </span>
      </div>
    </Node>
  );

  const model = (
    <Node
      icon={<BrainCircuit className="size-5" />}
      accent="#8B5CF6"
      title="Model"
      description="Reasons over the goal and proposes the next action. It never executes anything itself."
    >
      <div
        className={`mt-6 overflow-x-auto rounded-lg border border-fd-border bg-fd-muted/40 p-4 font-mono text-xs leading-relaxed text-fd-foreground/80 ${modelProposal.className}`}
        style={modelProposal.style}
      >
        <span className="text-[#8B5CF6]">proposes →</span>{" "}
        <code>lookup-customer(&#123; customerId: "C-42" &#125;)</code>
      </div>
    </Node>
  );

  const arrows = {
    define: { active: step === "arrow-define", accent: "#5F57E3" },
    approval: { active: step === "arrow-approval", accent: "#F59E0B" },
    goal: { active: step === "arrow-goal", accent: "#F97316" },
    proposed: { active: step === "arrow-proposed", accent: "#8B5CF6" },
  };

  return (
    <div>
      {/* md+: three nodes with a circulating left-right flow */}
      <div className="hidden items-stretch md:grid md:grid-cols-[1fr_minmax(5rem,8rem)_1.15fr_minmax(5rem,8rem)_1fr]">
        {you}
        <div className="flex flex-col justify-center gap-14">
          <ArrowH label="define & deploy" {...arrows.define} />
          <ArrowH label="approval request" reverse {...arrows.approval} />
        </div>
        {engine}
        <div className="flex flex-col justify-center gap-14">
          <ArrowH label="goal + guardrails" {...arrows.goal} />
          <ArrowH label="proposed action" reverse {...arrows.proposed} />
        </div>
        {model}
      </div>

      {/* below md: stacked nodes with paired up/down flow */}
      <div className="flex flex-col md:hidden">
        {you}
        <div className="flex justify-center gap-8 py-5">
          <ArrowV label="define & deploy" {...arrows.define} />
          <ArrowV label="approval request" reverse {...arrows.approval} />
        </div>
        {engine}
        <div className="flex justify-center gap-8 py-5">
          <ArrowV label="goal + guardrails" {...arrows.goal} />
          <ArrowV label="proposed action" reverse {...arrows.proposed} />
        </div>
        {model}
      </div>

      <p className="mt-12 text-center font-mono text-sm text-fd-muted-foreground">
        One audited loop, nothing executes until the engine approves it.
      </p>
    </div>
  );
}
