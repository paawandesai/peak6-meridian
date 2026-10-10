"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Markets", href: "/", icon: "chart" },
  { label: "Portfolio", href: "/portfolio", icon: "briefcase" },
  { label: "History", href: "/history", icon: "clock" },
  { label: "Status", href: "/status", icon: "checkCircle" },
] as const;

/**
 * Bottom tab bar for mobile navigation (P1-3).
 * - 4 tabs: Markets, Portfolio, History, Status
 * - Shown below md breakpoint only (< 768px)
 * - Safe-area insets for devices with notches
 * - 44px touch targets (Apple HIG minimum)
 * - aria-current on active route
 * - Visible focus ring
 */
export function BottomTabBar() {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (!pathname) return false;
    if (href === "/") {
      return pathname === "/" || pathname.startsWith("/trade/");
    }
    return pathname.startsWith(href);
  };

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-mer-rule bg-mer-paper md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Main navigation"
    >
      <div className="flex">
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`
                flex flex-1 flex-col items-center justify-center gap-1
                py-2 text-mer-xs transition-colors
                focus:ring-2 focus:ring-inset focus:ring-mer-focus
                ${active ? "text-mer-yes" : "text-mer-ink-muted hover:text-mer-ink"}
              `}
              style={{ minHeight: "44px" }}
              aria-current={active ? "page" : undefined}
            >
              <TabIcon icon={tab.icon} />
              <span className="font-mer-medium">{tab.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

type TabIconProps = {
  readonly icon: "chart" | "briefcase" | "clock" | "checkCircle";
};

function TabIcon({ icon }: TabIconProps) {
  const iconClass = "h-5 w-5";

  switch (icon) {
    case "chart":
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={iconClass}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M2.5 4A1.5 1.5 0 001 5.5v9A1.5 1.5 0 002.5 16h15a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0017.5 4h-15zm4.5 7.5a.75.75 0 00-1.5 0v2a.75.75 0 001.5 0v-2zm3.75-4.5a.75.75 0 01.75.75v5.5a.75.75 0 01-1.5 0v-5.5a.75.75 0 01.75-.75zm3.75 1.75a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "briefcase":
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={iconClass}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M6 3.75A2.75 2.75 0 018.75 1h2.5A2.75 2.75 0 0114 3.75v.443c.572.055 1.14.122 1.706.2C17.053 4.582 18 5.75 18 7.07v3.469c0 1.126-.694 2.191-1.83 2.54-1.952.599-4.024.921-6.17.921s-4.219-.322-6.17-.921C2.694 12.73 2 11.665 2 10.539V7.07c0-1.321.947-2.489 2.294-2.676A41.047 41.047 0 016 4.193V3.75zm6.5 0v.325a41.622 41.622 0 00-5 0V3.75c0-.69.56-1.25 1.25-1.25h2.5c.69 0 1.25.56 1.25 1.25zM10 10a1 1 0 00-1 1v.01a1 1 0 001 1h.01a1 1 0 001-1V11a1 1 0 00-1-1H10z"
            clipRule="evenodd"
          />
          <path d="M3 15.055v-.684c.126.053.255.1.39.142 2.092.642 4.313.987 6.61.987 2.297 0 4.518-.345 6.61-.987.135-.041.264-.089.39-.142v.684c0 1.347-.985 2.53-2.363 2.686a41.454 41.454 0 01-9.274 0C3.985 17.585 3 16.402 3 15.055z" />
        </svg>
      );
    case "clock":
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={iconClass}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-13a.75.75 0 00-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 000-1.5h-3.25V5z"
            clipRule="evenodd"
          />
        </svg>
      );
    case "checkCircle":
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={iconClass}
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z"
            clipRule="evenodd"
          />
        </svg>
      );
  }
}
