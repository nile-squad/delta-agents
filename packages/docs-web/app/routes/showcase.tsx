import { HomeLayout } from "fumadocs-ui/layouts/home";
import { ArrowRight, Rocket } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { ShikiCode } from "@/components/shiki-code";
import { SiteFooter } from "@/components/site-footer";
import { baseOptions } from "@/lib/layout.shared";
import { buildMeta } from "@/lib/seo";
import { githubUrl } from "@/lib/site-config";
import type { Route } from "./+types/showcase";

export function meta(_args: Route.MetaArgs) {
  return buildMeta({
    title: "Showcase | Delta Agents",
    description: "Real projects built with Delta, submitted by the community.",
    path: "/showcase",
    image: "/og/showcase.png",
  });
}

const SUBMISSION_STRUCTURE = `{
  "name": "Your Project Name",
  "tagline": "One sentence on what it does",
  "description": "Two or three sentences on the project and how it uses Delta.",
  "url": "https://your-project.com",
  "repo": "https://github.com/you/your-project",
  "author": "Your name or GitHub handle",
  "tags": ["support", "multi-agent"]
}`;

export default function Showcase() {
  return (
    <HomeLayout {...baseOptions()}>
      {/* Header */}
      <section className="section-more-glow">
        <div className="mx-auto max-w-5xl px-6 pb-16 pt-24 sm:pb-20 sm:pt-32">
          <FadeIn>
            <h1 className="text-center text-[clamp(2.25rem,1.6rem+2.6vw,3.5rem)] font-bold tracking-tight leading-[1.1] text-fd-foreground sm:text-left">
              Showcase
            </h1>
            <p className="mt-4 max-w-2xl text-center text-[clamp(1rem,0.92rem+0.4vw,1.125rem)] text-fd-muted-foreground leading-relaxed sm:text-left">
              Real projects built with Delta, submitted by the community. Built
              something governed? Put it here.
            </p>
          </FadeIn>
        </div>
      </section>

      {/* How to submit */}
      <section>
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
          <FadeIn>
            <h2 className="text-center text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-bold tracking-tight leading-[1.15] text-fd-foreground sm:text-left">
              How to submit
            </h2>
            <p className="mt-3 max-w-2xl text-center text-sm text-fd-muted-foreground leading-relaxed sm:text-left sm:text-base">
              Make a PR with the following structure:
            </p>
          </FadeIn>
          <FadeIn delay={0.1} className="mt-8 min-w-0">
            <div
              className="texture-card rounded-xl border p-5 sm:p-8"
              style={{
                backgroundColor: "#5F57E30f",
                borderColor: "#5F57E326",
              }}
            >
              <div className="quick-start-code overflow-x-auto rounded-lg border border-fd-border p-5 text-[13px] leading-relaxed shadow-lg [&_pre]:!bg-transparent">
                <ShikiCode code={SUBMISSION_STRUCTURE} lang="json" />
              </div>
            </div>
          </FadeIn>
          <FadeIn
            delay={0.15}
            className="mt-6 max-w-2xl text-center text-sm text-fd-muted-foreground leading-relaxed sm:text-left"
          >
            Add your entry to the showcase list, keep the description concise,
            and link to something that actually runs. Open the PR against the
            repo below and we'll review it for the next release.
          </FadeIn>
          <FadeIn delay={0.2} className="mt-8">
            <a
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#5F57E3] px-6 font-mono text-sm font-semibold text-white transition-colors hover:bg-[#5F57E3]/90"
              href={`${githubUrl}/compare/main...main?quick_pull=1&template=showcase.md`}
              rel="noreferrer"
              target="_blank"
            >
              Open a PR
              <ArrowRight className="size-4" />
            </a>
          </FadeIn>
        </div>
      </section>

      {/* Featured projects */}
      <section>
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-24">
          <FadeIn>
            <h2 className="text-center text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-bold tracking-tight leading-[1.15] text-fd-foreground sm:text-left">
              Featured projects
            </h2>
          </FadeIn>
          <FadeIn
            delay={0.1}
            className="mt-8 flex flex-col items-center rounded-xl border border-dashed border-[#5F57E3]/30 px-6 py-20 text-center"
          >
            <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-[#5F57E3]/10 text-[#5F57E3]">
              <Rocket className="size-6" aria-hidden="true" />
            </span>
            <h3 className="mt-5 text-base font-semibold text-fd-foreground">
              Nothing here yet
            </h3>
            <p className="mt-2 max-w-sm text-sm text-fd-muted-foreground leading-relaxed">
              No projects have been submitted so far. Be the first to showcase
              what you've built with Delta.
            </p>
          </FadeIn>
        </div>
      </section>

      <SiteFooter />
    </HomeLayout>
  );
}
