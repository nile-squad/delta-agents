import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { useLocation } from "react-router-dom";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { SeoTags } from "@/lib/seo";
import { gitConfig, githubUrl } from "@/lib/site-config";
import { getPageMarkdownUrl, source } from "@/lib/source";
import type { Route } from "./+types/docs";

export async function loader({ params }: Route.LoaderArgs) {
  const slugs = params["*"].split("/").filter((v) => v.length > 0);
  const page = source.getPage(slugs);
  if (!page) throw new Response("Not found", { status: 404 });

  return {
    path: page.path,
    markdownUrl: getPageMarkdownUrl(page).url,
    pageTree: await source.serializePageTree(source.getPageTree()),
  };
}

const clientLoader = browserCollections.docs.createClientLoader({
  component(
    { toc, frontmatter, default: Mdx },
    // you can define props for the component
    {
      markdownUrl,
      path,
      urlPath,
    }: {
      markdownUrl: string;
      path: string;
      urlPath: string;
    },
  ) {
    return (
      <DocsPage toc={toc}>
        <SeoTags
          title={`${frontmatter.title} | Delta Agents`}
          description={frontmatter.description}
          path={urlPath}
          image="/og/docs.png"
        />
        <DocsTitle>{frontmatter.title}</DocsTitle>
        <DocsDescription>{frontmatter.description}</DocsDescription>
        <div className="flex flex-row gap-2 items-center border-b -mt-4 pb-6">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`${githubUrl}/blob/${gitConfig.branch}/content/docs/${path}`}
          />
        </div>
        <DocsBody>
          <Mdx components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

export default function Page({ loaderData }: Route.ComponentProps) {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(loaderData);
  const location = useLocation();

  return (
    <DocsLayout {...baseOptions()} tree={pageTree}>
      {clientLoader.useContent(loaderData.path, {
        markdownUrl,
        path,
        urlPath: location.pathname,
      })}
    </DocsLayout>
  );
}
