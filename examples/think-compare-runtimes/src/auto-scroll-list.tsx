import { type ReactNode, useEffect, useRef } from "react";

export function AutoScrollList({
  ariaLabel,
  children,
  className,
  watchKey,
}: {
  ariaLabel: string;
  children: ReactNode;
  className?: string;
  watchKey: string | number;
}) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    void watchKey;
    const list = listRef.current;
    if (!list) return;

    if (typeof list.scrollTo === "function") {
      list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
      return;
    }

    list.scrollTop = list.scrollHeight;
  }, [watchKey]);

  return (
    <ol aria-label={ariaLabel} className={className} ref={listRef}>
      {children}
    </ol>
  );
}
