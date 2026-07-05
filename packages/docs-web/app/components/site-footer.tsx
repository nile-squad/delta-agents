import { Link } from "react-router-dom";
import { appName, githubUrl } from "@/lib/site-config";

export function SiteFooter() {
  return (
    <footer className="border-t border-fd-border">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <img
            src="/delta-logo.svg"
            alt=""
            width="20"
            height="20"
            className="size-5 rounded"
          />
          <span className="text-sm font-semibold text-fd-foreground">
            {appName}
          </span>
          <span className="font-mono text-xs text-fd-muted-foreground/70">
            free and open source
          </span>
        </div>
        <nav className="flex items-center gap-6 font-mono text-xs text-fd-muted-foreground">
          <Link
            className="transition-colors hover:text-fd-foreground"
            to="/docs"
          >
            Docs
          </Link>
          
          <Link
            className="transition-colors hover:text-fd-foreground"
            to="/showcase"
          >
            Showcase
          </Link>
          <Link
            className="transition-colors hover:text-fd-foreground"
            to="/use-cases"
          >
            Use Cases
          </Link>
          <a
            className="transition-colors hover:text-fd-foreground"
            href={githubUrl}
            rel="noreferrer"
            target="_blank"
          >
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
