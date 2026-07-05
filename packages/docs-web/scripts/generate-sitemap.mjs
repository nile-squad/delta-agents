import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGetUrl, getSlugs } from "fumadocs-core/source";

const SITE_URL = "https://delta.nilesquad.com";
const CONTENT_DIR = "content/docs";
const OUT_FILE = "build/client/sitemap.xml";

const getUrl = createGetUrl("/docs");

/** Recursively find all .mdx files under a directory (Node 18+ compatible). */
async function findMdxFiles(dir, base = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

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

async function lastModOf(path) {
  const { mtime } = await stat(path);
  return mtime.toISOString().slice(0, 10);
}

const staticEntries = [
  { path: "/", priority: "1.0" },
  { path: "/showcase", priority: "0.6" },
  { path: "/use-cases", priority: "0.6" },
];

const urls = [];

for (const entry of staticEntries) {
  urls.push({ loc: entry.path, priority: entry.priority, lastmod: undefined });
}

const mdxFiles = await findMdxFiles(CONTENT_DIR);
for (const file of mdxFiles) {
  const slugs = getSlugs(file);
  urls.push({
    loc: getUrl(slugs),
    priority: "0.8",
    lastmod: await lastModOf(join(CONTENT_DIR, file)),
  });
}

const body = urls
  .map(
    (u) => `  <url>
    <loc>${SITE_URL}${u.loc}</loc>
    <priority>${u.priority}</priority>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ""}
  </url>`,
  )
  .join("\n");

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;

await writeFile(OUT_FILE, xml);
console.log(`wrote ${urls.length} urls to ${OUT_FILE}`);
