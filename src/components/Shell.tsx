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
          <Image className="brand-emblem" src="/emblem.svg" width={36} height={36} alt="ASCN.AI" priority />
          <span>ASCN.AI Portfolio</span>
        </div>

        <div className="workspace-switcher">
          <div className="bot-avatar">P</div>
          <div>
            <strong>Мой портфель</strong>
            <span>агент следит 2 раза в день</span>
          </div>
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

        <div className="sidebar-footer">
          Данные: CoinGecko, DeFiLlama, новостные RSS.
          <br />
          Не инвестиционная рекомендация.
        </div>
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
