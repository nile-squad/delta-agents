# delta-agents Documentation Site

The documentation site for [delta-agents](https://github.com/hussein-kizz/delta-agents), a deterministic governance and control-plane engine for AI agents. Built with [Rspress](https://rspress.dev).

## Setup

```bash
bun install
```

## Development

Run from this directory (`packages/web`):

```bash
pnpm dev
```

The site is available at `http://localhost:8000`.

## Building

```bash
pnpm build
```

Preview the production build:

```bash
pnpm preview
```

## Documentation Structure

```
docs/
  index.tsx                     # Home page (custom React component)
  home.css                      # Home page styles
  _nav.json                     # Top navigation
  guide/
    _meta.json
    start/
      getting-started.md
    basics/
      actions.md
      agents-and-workflows.md
      human-oversight-and-approvals.md
    internals/
      execution-gateway.md
      delegation-and-teams.md
      tools-and-memory.md
    reference/
      faq.md
      llms-txt.mdx
      llms-full-txt.mdx
```

## Theming

Brand colors are defined in `theme/index.css`.

## LLMs Integration

The site uses `@rspress/plugin-llms` to generate `llms.txt` and `llms-full.txt` files at build time. These are copied to `docs/public/` via the `postbuild` script so they are accessible at the site root.

## Home Page Code Samples

The code blocks on the home page are generated at build time by `scripts/generate-home-code.ts`, which writes `home-code-blocks.ts`. That file is generated; do not edit it by hand. Edit the source snippets in the generator script instead, then run:

```bash
bun run scripts/generate-home-code.ts
```

## Customization

- **Navigation**: `docs/_nav.json`
- **Sidebar**: `_meta.json` files in each directory
- **Home page**: `docs/index.tsx` and `docs/home.css`
- **Theme**: `theme/index.css`
- **Site config**: `rspress.config.ts`

## Adding Documentation

1. Create a `.md` file in the appropriate directory under `docs/guide/`
2. Update the corresponding `_meta.json` to include the new page in the sidebar
3. Test locally with `pnpm dev`
