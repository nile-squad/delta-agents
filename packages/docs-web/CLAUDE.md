# docs-web UI context

Design decisions and rules for the Delta Agents docs site (React Router v7 + fumadocs-ui + Tailwind v4). These were set deliberately with the maintainer; follow them for any UI work here.

## Copy rules

- **No em dashes (—) anywhere in UI copy.** Use a comma or split into two sentences instead.
- **No sparkle/Sparkles icons anywhere.** For AI/model concepts use `BrainCircuit`, `Cpu`, or `Bot` (lucide-react).
- Keep marketing copy plain and confident, no hype punctuation.

## Fonts

- **Headings (h1-h6):** IBM Plex Sans Variable, falling back to `ui-sans-serif, system-ui` (global rule in `app/app.css`).
- **Buttons and mono UI (labels, tags, captions, code):** IBM Plex Mono (weights 400/500/600), exposed as Tailwind's `font-mono` via `--font-mono` in `:root`.
- **The hero delta (δ) character only:** Manrope Variable, weight 800. Never change this one to the site fonts.
- All fonts self-hosted via fontsource, imported in `app/root.tsx`.

## Typography

- Fluid sizes via `text-[clamp(min,preferred,max)]`; always set an explicit `leading-*` alongside (clamp utilities carry no implicit line-height).
- Hero h1: `clamp(2.25rem,1.4rem+3.4vw,3.75rem)`. Major section titles (e.g. "How it works"): `clamp(2.25rem,1.6rem+2.6vw,3.5rem)`, bold, tracking-tight, `leading-[1.1]`. Section titles are real titles, not small uppercase eyebrows.

## Color and theme

- Brand accents: purple `#5F57E3` (primary/You), orange `#F97316` family + amber `#fbbf24` (delta glyph, Engine, "governance." gradient), green `#2CD46B` (approve), amber `#F59E0B` (escalate/ask), violet `#8B5CF6` (Model), rose `#E25557`.
- In the hero h1, only the word "governance." gets the amber→orange gradient; "with built-in" stays solid purple.
- Always style both themes using fumadocs variables (`fd-background`, `fd-border`, `fd-foreground`, `fd-muted-foreground`, `fd-muted`). Note: `fd-card` is NOT defined by the imported neutral theme, don't use it.
- Colored text on light backgrounds needs darker light-mode variants (e.g. `text-[#1fa855] dark:text-[#2CD46B]`).
- Biome's CSS parser rejects Tailwind's `@theme` directive; put theme variable overrides in plain `:root` blocks in `app/app.css`.

## Hero delta glyph (`.delta-glow` in app.css)

- Hot-metal gradient uses `background-clip: text` + transparent fill. **Never add `text-shadow`** to it (paints over the clipped gradient and washes it out); all glow lives in `filter: drop-shadow` and the `::before`/`::after` blurred halos.
- Keep the glow blast radius tight: halo `inset: -5%`, `blur(56px)`, tight gradient falloffs. The maintainer repeatedly asked for a contained glow, don't widen it.
- `--glow` (0-1) is scroll-driven from `home.tsx` via motion; `--bloom` damps the halo to 0.45 in light mode. Multiply any new halo opacity by both.

## Governance loop section (`app/components/governance-loop.tsx`)

- Three cards (You / Delta Engine / Model) joined by dashed flow lines (`.flow-line-h/v`, drifting dash animation; `.flow-reverse` flips direction). Horizontal loop on `md+`, stacked with vertical arrow pairs below `md`.
- Cards: 2px accent-tinted borders + soft accent box-shadow glow, `cursor-pointer`, generous padding (`p-6 sm:p-8`). Never highlight whole cards in animations; only elements inside them.
- A step animation cycles a soft accent ring (`.loop-step` / `.loop-step-active`, `--step-accent`) through the in-card elements and arrows every 1.6s; hovering a card lights all its steps (`.loop-node:hover .loop-step`).
- Code snippets use the `ShikiCode` component (tokyo-night / catppuccin-latte) inside a `quick-start-code` wrapper, not hand-styled `<pre>`.

## How to use section (`app/components/how-to-use.tsx`)

- Quick-start steps broken into four snippets in a zig-zag layout (text/code sides alternate per row on `md+` via `md:order-*`, stacked below).
- Each snippet is a two-layer composition: an outer `.texture-card` backdrop (grid-paper PNG at `/inflicted.png` tiled 240px, damped to `opacity: 0.5` so the grid stays a whisper, over a faint purple tint, lines inverted via `filter: invert(1)` in light mode, generous padding) with a solid `quick-start-code` code card floating on top of it (own border + shadow, Shiki's inline `pre` background forced transparent with `[&_pre]:!bg-transparent`). The code never sits directly on the texture.
- Card backdrops and borders all use one accent, purple `#5F57E3` (per-card color rotation was rejected). Step numbers DO rotate through the brand palette (purple, orange, green, violet) for consistency with the rest of the page.
- Under the grid, `.texture-card::after` paints a heavily blurred wash of the hero palette (rose, amber, green, violet radial blobs at ~0.12-0.2 alpha, `blur(28px)`, damped to 0.55 opacity in light mode). It should read as color bleeding, never as glow. `.texture-card` is `overflow: hidden` to clip both pseudo layers to the rounded corners.
- Cards scale subtly on hover (`motion-safe:hover:scale-[1.02]`, 300ms ease-out). Note: Tailwind v4 scale utilities set the native CSS `scale` property, not `transform`, so verify with `getComputedStyle(el).scale`.
- Rows use `md:grid-cols-5` with text `col-span-2` and code `col-span-3` so snippets fit without horizontal scrolling; section container is `max-w-7xl`. Grid children that hold wide content (code blocks) need `min-w-0` or they stretch the track and cause page-level horizontal overflow on mobile.

## Page structure (home)

Hero → How it works (governance loop) → How to use the Delta framework (zig-zag steps) → Features highlight → More about Delta (badges + install + docs CTA) → footer. The old Technical Foundation, Quick Start, and Explore sections were removed deliberately; don't resurrect them. **No section divider borders** anywhere on the page; the only horizontal rule is the footer's `border-t`.

- **Hero**: container is `max-w-6xl` with `lg:gap-32` between the text column and the delta glyph (the maintainer asked for generous separation from the character art). Buttons: primary "Get Started" (purple, → /docs) and a secondary outline "Star on GitHub" (external link, `Star` icon); the old "API Reference" hero button was replaced deliberately, API Reference stays reachable from the footer. The "Open source · Free · Works with Node, Bun & Deno" micro-line is `font-mono text-sm text-fd-muted-foreground/80` with `mt-10` breathing room from the buttons.

- **Features highlight**: large section title with a glowing amber `Lightbulb` beside it (`.bulb-glow`, breathing drop-shadow, static under reduced motion). Nine feature cells sourced from `content/docs/index.mdx` in a JOINED mosaic grid, NOT separate rounded cards (the maintainer explicitly wants `gap-px bg-fd-border` shared hairlines, square corners): `max-w-7xl`, 1/2/3 columns, roomy `p-8 sm:p-10` cells, each with accent top border, tinted icon chip, hover background. Lucide's `Route` icon must be imported as `Route as RouteIcon` (collides with the `Route` route-types import).
- **More about Delta**: no words beyond the badges, install command, and button. Three award-medal badges (`.award-badge`: gradient disc + dashed seal outline + two ribbon tails via clip-path pseudos, colors driven by `--badge-hi/mid/lo` custom props set inline) with lucide `Award` / `Medal` / `Trophy` icons and matching mono labels beneath. Each medal has its own brand color: purple "Open source", green "Free", orange "Node, Bun & Deno" (label deliberately without "Works with"). Medal discs are deliberately large: `4.25rem` (mobile) / `5rem` (sm+) with `size-7 sm:size-8` icons and `text-xs sm:text-sm` labels; badge columns are `w-[5.5rem] gap-x-3` on mobile (tuned so all three still sit in one row at 360px) and `w-36 gap-x-12` on sm+. Then the `$ npm install delta-agents` chip with copy button and a "Star on GitHub" CTA (external link, `Star` icon) in the same amber→orange gradient as the "governance." hero text. Plain pill badges were rejected as boring; the CTA is deliberately GitHub, not docs.
- **Footer**: extracted to `app/components/site-footer.tsx` (`SiteFooter`), reused on every page, not just home. Single row (stacks on mobile), logo + name + "free and open source" on the left, mono Docs / API Reference / Showcase / Use Cases / GitHub links on the right, `border-t`.
- **Mobile spacing**: hero and the four major sections use tighter mobile-only vertical padding (`pt-24 pb-16` hero, `py-16` sections, `sm:` values unchanged) so the page doesn't feel over-padded on small screens. The award badges shrink (`w-24 sm:w-36`, `gap-x-6 sm:gap-x-12`) so all three sit in one row even at 375px instead of stacking.
- **Side-lightening background**: `.section-side-glow` (in `app.css`) washes a section's left edge purple and right edge orange, rendered as static PNGs (`/section-side-glow-dark.png` / `-light.png`, 1600×2400, theme bg baked in: dark `#121212`, light `#f5f5f5`) so nothing recomposites on scroll. Applied ONLY to the tall "How to use the Delta framework" section (NOT "How it works" — mixed those up once, don't repeat it). Don't touch these PNGs when adjusting other sections' glows.
- **Short-section side glow**: `.section-more-glow` (in `app.css`) is the wide-aspect variant for short sections: "More about Delta" plus the showcase and use-cases page headers. Own PNGs (`/section-more-glow-dark.png` / `-light.png`, 1600×800) so the blobs aren't squashed by `100% 100%` stretching, with a "dark skin" veil baked in (uniform `rgba(0,0,0,0.2)` over the gradients in dark, a near-invisible `rgba(18,18,18,0.025)` in light) so the glow reads as embedded in a slightly darker surface instead of sitting on top, and a deeper 14% top/bottom mask fade so the short section melts into its neighbors. Regenerate by screenshotting a gradient-only HTML page with headless Chrome (`google-chrome --headless=new --screenshot --window-size=1600,800`); keep the exact theme bg colors above or the seams show.

## Other pages

- **`/showcase`** (`app/routes/showcase.tsx`): header on `.section-more-glow`, then "How to submit" with the `ShikiCode`-rendered JSON submission structure in the same two-layer `.texture-card` + `quick-start-code` composition as the how-to-use snippets (purple accent, no hover scale since it isn't interactive), an "Open a PR" CTA (links to the GitHub repo), then "Featured projects" with a designed empty state (dashed purple-tinted border card, circular accent-tinted icon chip with `Rocket`, "Nothing here yet"). Sub-page h2s use the mid clamp `text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-bold tracking-tight leading-[1.15]`. Update this page, not a new one, once real projects exist.
- **`/use-cases`** (`app/routes/use-cases.tsx`): same header pattern (also `.section-more-glow`), then a 9-item joined mosaic grid identical in structure to Features highlight (own `USE_CASES` array, own icons/accents) covering support, fintech, devops, data, compliance, internal tooling, multi-agent research, e-commerce, and moderation.
- Both pages are registered in `app/routes.ts` and linked from the top nav (`app/lib/layout.shared.tsx` `links` array) and the shared footer.

## Motion and accessibility

- Scroll-linked values via `motion` (`useScroll` + `useTransform`) applied as CSS custom properties (`style={{ "--glow": glow } as MotionStyle}`).
- Every animation must have a `prefers-reduced-motion: reduce` fallback (see the block in `app.css`); static drop-shadow replaces the heat pulse, flow/step animations turn off.
- **Entry animations**: use `app/components/fade-in.tsx` (`FadeIn`) for scroll-triggered reveals, not ad hoc `motion.div`s. It's a thin `motion.div` wrapper (`opacity 0→1`, `y: 14→0`, 0.35s ease-out, `viewport={{ once: true, margin: "-64px" }}`) that renders a plain `div` instead when `useReducedMotion()` is true. Pass `delay` (small increments, e.g. `i * 0.05` capped around `0.25`) to stagger grid items; pass `style` through for accent-colored borders. Wrap the *row/cell*, not an element that already owns a CSS `transform` (e.g. the how-to-use `.texture-card` hover-scale), since motion's inline `transform` on an animated element overrides Tailwind's class-based transform utilities.
- Testing note: Playwright's `fullPage` screenshot does not actually scroll the page, so `whileInView` content below the initial viewport can appear as an unstyled gap in a `fullPage` capture even though it renders correctly for real users. Verify scroll-triggered content by scrolling programmatically (`page.mouse.wheel`) and re-checking, not by trusting a single `fullPage` screenshot.

## Contrast and sizing

- Desktop visuals should fill their space, don't undersize them (the loop section uses `max-w-7xl` vs the usual `max-w-5xl`).
- Prefer accent-tinted borders and `text-fd-foreground/60`+ over faint muted grays for diagram lines and labels.

## Site config

- Site identity lives in `app/lib/site-config.ts`: `appName`, `gitConfig` (user `nile-squad`, repo `delta-agents`, branch), and the derived `githubUrl`. Every GitHub link in the site must come from there, never hardcode `https://github.com/...` in components (the only exception is placeholder copy like the showcase submission example). Route constants stay in `app/lib/shared.ts`.

## SEO and OG images

- `app/lib/seo.tsx`: `buildMeta({title, description, path, image})` returns title/description/canonical/OG/Twitter tags; used in route `meta()` exports, and as `<SeoTags>` JSX in `docs.tsx` (per-page frontmatter, no static `meta()` there).
- OG PNGs (1200x630) in `public/og/`: `default.png`, `docs.png`, `showcase.png`, `use-cases.png`.
- `public/robots.txt` + `scripts/generate-sitemap.mjs` (runs as part of `pnpm build`) → `sitemap.xml`.

## Assets

- Logo and favicon: `/delta-logo.svg` and `/favicon.svg` (same artwork, dark tile + orange delta from `docs/assets/Delta Agents.svg`). Don't reintroduce PNG logos.

## Tooling

- Lint/format with Biome (`pnpm exec biome check --write <files>`), not ESLint/Prettier.
- `tsc --noEmit` has one known pre-existing error in `react-router.config.ts`; ignore that line only.
- Visual QA: run `pnpm dev` from this package dir (not repo root) and screenshot with playwright-core + system Chrome at 1600px and 390px, in both color schemes. Kill any leftover process on port 5173 first; a stale server serves outdated Vite deps (504 Outdated Optimize Dep) and makes fresh code appear broken.
