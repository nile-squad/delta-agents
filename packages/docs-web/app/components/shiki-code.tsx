"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { codeToHtml } from "shiki";

function subscribe(callback: () => void) {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot() {
  return document.documentElement.classList.contains("dark");
}

function getServerSnapshot() {
  return false;
}

type ShikiCodeProps = {
  code: string;
  lang?: string;
};

export function ShikiCode({ code, lang = "typescript" }: ShikiCodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const isDark = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  useEffect(() => {
    let cancelled = false;

    void codeToHtml(code, {
      lang,
      themes: {
        light: "catppuccin-latte",
        dark: "tokyo-night",
      },
      defaultColor: "light-dark()",
    }).then((html) => {
      if (cancelled || !ref.current) return;
      ref.current.innerHTML = html;
      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div style={{ colorScheme: isDark ? "dark" : "light" }}>
      <div
        ref={ref}
        className={`transition-opacity duration-200 ${ready ? "opacity-100" : "opacity-0"}`}
      />
      {!ready && (
        <pre className="text-sm leading-7 font-mono">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
