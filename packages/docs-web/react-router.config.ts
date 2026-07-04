import type { Config } from "@react-router/dev/config";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createGetUrl, getSlugs } from "fumadocs-core/source";

const getUrl = createGetUrl("/docs");

/** Recursively find all .mdx files under a directory (Node 18+ compatible). */
async function findMdxFiles(dir: string, base = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await findMdxFiles(join(dir, entry.name), relative)));
    } else if (entry.name.endsWith(".mdx")) {
      files.push(relative);
    }
  }

  return files;
}

export default {
  ssr: false,
  future: {
    v8_middleware: true,
    v8_splitRouteModules: true,
    v8_viteEnvironmentApi: true,
    v8_passThroughRequests: true,
    v8_trailingSlashAwareDataRequests: true,
    v8_fetcherPersist: true,
    v8_normalizeDeferredBoundaryKey: true,
    v8_startTransition: true,
  },
  async prerender({ getStaticPaths }) {
    const paths: string[] = [];
    const excluded: string[] = [];

    for (const path of getStaticPaths()) {
      if (!excluded.includes(path)) paths.push(path);
    }

    for (const entry of await findMdxFiles("content/docs")) {
      const slugs = getSlugs(entry);
      paths.push(
        getUrl(slugs),
        `/llms.mdx/docs/${[...slugs, "content.md"].join("/")}`,
      );
    }

    return paths;
  },
} satisfies Config;
