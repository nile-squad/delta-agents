import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { appName, githubUrl } from "./site-config";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2 font-semibold">
          <img
            src="/delta-logo.svg"
            alt="Delta Agents logo"
            width="24"
            height="24"
            className="size-6 rounded-md"
          />
          {appName}
        </span>
      ),
    },
    links: [
      {
        text: "Showcase",
        url: "/showcase",
      },
      {
        text: "Use Cases",
        url: "/use-cases",
      },
      {
        text: "GitHub",
        url: githubUrl,
        active: "none",
      },
    ],
    githubUrl,
  };
}
