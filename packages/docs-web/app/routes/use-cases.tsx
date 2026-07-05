import { HomeLayout } from "fumadocs-ui/layouts/home";
import {
  Briefcase,
  Database,
  Flag,
  Headphones,
  Landmark,
  ScrollText,
  Server,
  ShoppingCart,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { FadeIn } from "@/components/fade-in";
import { SiteFooter } from "@/components/site-footer";
import { baseOptions } from "@/lib/layout.shared";
import { buildMeta } from "@/lib/seo";
import type { Route } from "./+types/use-cases";

export function meta(_args: Route.MetaArgs) {
  return buildMeta({
    title: "Use Cases | Delta Agents",
    description: "Where governed agent autonomy earns its keep.",
    path: "/use-cases",
    image: "/og/use-cases.png",
  });
}

const USE_CASES: ReadonlyArray<{
  icon: ReactNode;
  title: string;
  description: string;
  accent: string;
}> = [
  {
    icon: <Headphones className="size-5" />,
    title: "Customer support automation",
    description:
      "Agents resolve tickets, look up accounts, and issue refunds within policy. Anything above the risk threshold escalates to a human before it executes.",
    accent: "#5F57E3",
  },
  {
    icon: <Landmark className="size-5" />,
    title: "Financial operations and approvals",
    description:
      "Payments, transfers, and reconciliations run under hard budget and risk ceilings. High-value actions pause for approval; everything is auditable after the fact.",
    accent: "#F97316",
  },
  {
    icon: <Server className="size-5" />,
    title: "DevOps and infrastructure automation",
    description:
      "Agents restart services, roll back deploys, and triage incidents. Destructive operations require sign-off; routine fixes execute and get logged.",
    accent: "#2CD46B",
  },
  {
    icon: <Database className="size-5" />,
    title: "Data pipeline orchestration",
    description:
      "Multi-phase workflows validate, transform, and route data with declared prerequisites. A failed step resumes from checkpoint, not from scratch.",
    accent: "#8B5CF6",
  },
  {
    icon: <ScrollText className="size-5" />,
    title: "Compliance-heavy industries",
    description:
      "Every action is deterministic, provable, and tied to an identity. Regulated teams get a full commit history of what ran, by whom, and why.",
    accent: "#E25557",
  },
  {
    icon: <Briefcase className="size-5" />,
    title: "Internal tooling and employee copilots",
    description:
      "Agents handle repetitive internal requests, IT tickets, and reporting. Sensitive actions like access changes stay behind human approval.",
    accent: "#F59E0B",
  },
  {
    icon: <Users className="size-5" />,
    title: "Multi-agent research teams",
    description:
      "Agents delegate subtasks to each other under scoped budgets and bounded supervision trees, coordinating through mailboxes with read receipts.",
    accent: "#5F57E3",
  },
  {
    icon: <ShoppingCart className="size-5" />,
    title: "E-commerce order management",
    description:
      "Agents look up orders, adjust shipments, and process returns. Refunds beyond a set amount escalate; everything else executes immediately.",
    accent: "#2CD46B",
  },
  {
    icon: <Flag className="size-5" />,
    title: "Content moderation pipelines",
    description:
      "Agents classify and action content against policy at volume. Ambiguous or high-impact calls route to a human reviewer instead of guessing.",
    accent: "#F97316",
  },
];

export default function UseCases() {
  return (
    <HomeLayout {...baseOptions()}>
      {/* Header */}
      <section className="section-more-glow">
        <div className="mx-auto max-w-5xl px-6 pb-16 pt-24 sm:pb-20 sm:pt-32">
          <FadeIn>
            <h1 className="text-center text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground sm:text-left">
              Use cases
            </h1>
            <p className="mt-4 max-w-2xl text-center text-[clamp(1rem,0.92rem+0.4vw,1.125rem)] text-fd-muted-foreground leading-relaxed sm:text-left">
              Anywhere an agent needs to act on its own, and you need proof it
              stayed inside the lines.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* Use case grid */}
      <section>
        <div className="mx-auto max-w-7xl px-6 py-16 sm:py-24">
          <div className="grid gap-px border border-fd-border bg-fd-border sm:grid-cols-2 lg:grid-cols-3">
            {USE_CASES.map((useCase, i) => (
              <FadeIn
                key={useCase.title}
                delay={Math.min(i * 0.05, 0.25)}
                className={`border-t-2 p-8 text-center transition-colors hover:bg-fd-accent/30 sm:p-10 sm:text-left ${i === 4 ? "bg-fd-accent/30" : "bg-fd-background"}`}
                style={{ borderTopColor: useCase.accent }}
              >
                <span
                  className="inline-flex h-11 w-11 items-center justify-center rounded-lg"
                  style={{
                    backgroundColor: `${useCase.accent}15`,
                    color: useCase.accent,
                  }}
                >
                  {useCase.icon}
                </span>
                <h3 className="mt-5 text-base font-semibold text-fd-foreground leading-snug">
                  {useCase.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-fd-muted-foreground">
                  {useCase.description}
                </p>
              </FadeIn>
            ))}
          </div>
        </div>
      </section>

      <SiteFooter />
    </HomeLayout>
  );
}
