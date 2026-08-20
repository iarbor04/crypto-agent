"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, ShieldAlert, Wallet, type LucideIcon } from "lucide-react";

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Портфель", icon: Wallet },
  { href: "/risks", label: "Рейтинг риска", icon: ShieldAlert },
  { href: "/agent", label: "Агент", icon: Bot },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const current = NAV.find((item) => item.href === path) ?? NAV[0];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-tile">
            <Image className="brand-emblem" src="/emblem.svg" width={26} height={26} alt="ASCN.AI" priority />
          </span>
          <span>ASCN.AI Portfolio</span>
        </div>

        <nav className="main-nav">
          <p>РАБОЧЕЕ ПРОСТРАНСТВО</p>
          {NAV.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className={path === item.href ? "active" : ""}>
                <Icon className="nav-icon" aria-hidden="true" strokeWidth={1.8} />
                {item.label}
              </Link>
            );
          })}
        </nav>

      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Мой портфель</span>
            <i>/</i>
            <strong>{current.label}</strong>
          </div>
        </header>

        <div className="content">{children}</div>
      </section>
    </main>
  );
}
