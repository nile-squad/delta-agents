import type { MetaDescriptor } from "react-router";
import { appName } from "./site-config";

export const siteUrl = "https://delta.nilesquad.com";

export const defaultDescription =
  "The AI agent framework with built-in safety, governance, and provenance.";

export function absoluteUrl(path: string): string {
  return new URL(path, siteUrl).toString();
}

/** Canonical path form used across the site: no trailing slash (matches
 * every internal `<Link>` and the sitemap). React Router's static prerender
 * resolves index routes to a trailing-slash pathname at render time, so
 * this normalizes that back before it reaches a canonical/og:url tag. */
function canonicalPath(path: string): string {
  return path !== "/" && path.endsWith("/") ? path.slice(0, -1) : path;
}

type BuildMetaArgs = {
  title: string;
  description?: string;
  path: string;
  /** path under /og, e.g. "/og/docs.png"; defaults to the site-wide card */
  image?: string;
};

/**
 * Single source of truth for a route's SEO tags: title, description,
 * canonical link, Open Graph, and Twitter card. Consumed two ways:
 * as the return value of a route's `meta()` export (home, showcase,
 * use-cases, not-found), or rendered as JSX via `SeoTags` for routes
 * that resolve title/description at render time instead (docs pages,
 * whose frontmatter comes from a client loader).
 */
export function buildMeta({
  title,
  description = defaultDescription,
  path,
  image = "/og/default.png",
}: BuildMetaArgs): MetaDescriptor[] {
  const url = absoluteUrl(canonicalPath(path));
  const imageUrl = absoluteUrl(image);

  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: appName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: imageUrl },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: title },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: imageUrl },
  ];
}

function renderDescriptor(descriptor: MetaDescriptor, key: number) {
  // MetaDescriptor's catch-all `{ [name: string]: unknown }` member defeats
  // `in`-based narrowing, so read fields through an untyped view instead.
  const d = descriptor as Record<string, string>;

  if (typeof d.title === "string") {
    return <title key={key}>{d.title}</title>;
  }
  if (d.tagName === "link") {
    return <link key={key} rel={d.rel} href={d.href} />;
  }
  if (typeof d.name === "string") {
    return <meta key={key} name={d.name} content={d.content} />;
  }
  if (typeof d.property === "string") {
    return <meta key={key} property={d.property} content={d.content} />;
  }
  return null;
}

/** JSX form of `buildMeta`, for routes that render metadata at component
 * level instead of via a route `meta()` export (see `docs.tsx`). React 19
 * hoists `<title>`/`<meta>`/`<link>` rendered anywhere in the tree into
 * `<head>`, so this can sit inside the page body. */
export function SeoTags(args: BuildMetaArgs) {
  return <>{buildMeta(args).map(renderDescriptor)}</>;
}
