"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { CoinCandidate } from "@/lib/types";

export type PickedToken = { symbol: string; coinId?: string; name?: string; image?: string | null; rank?: number | null };

/**
 * Выбор токена как в кошельках и DEX: печатаешь тикер или название, видишь
 * логотипы и ранг, выбираешь — и в строке остаётся чип с иконкой.
 */
export function TokenPicker({
  value,
  onPick,
  autoOpen = false,
}: {
  value: PickedToken | null;
  onPick: (token: PickedToken) => void;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(autoOpen);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CoinCandidate[] | null>(null);
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect && window.innerHeight - rect.bottom < 300) setDropUp(true);
    const onDocClick = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    // сброс списка делает обработчик ввода: setState в теле эффекта запрещён правилами React
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      fetch(`/api/resolve?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((d: { candidates?: CoinCandidate[] }) => {
          setItems(d.candidates ?? []);
          setActive(0);
        })
        .catch(() => setItems([]));
    }, 280);
    return () => clearTimeout(timer);
  }, [query]);

  function choose(c: CoinCandidate) {
    onPick({ symbol: c.symbol, coinId: c.coinId, name: c.name, image: c.image, rank: c.rank });
    setOpen(false);
    setQuery("");
    setItems(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!items?.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="token-chip" onClick={() => setOpen(true)}>
        {value?.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value.image} alt="" width={24} height={24} />
        ) : (
          <span className="token-chip-blank">{value?.symbol?.slice(0, 2) || "?"}</span>
        )}
        <b>{value?.symbol || "Выбрать"}</b>
        {value?.name && <span className="token-chip-name">{value.name}</span>}
        {value?.rank ? <small>#{value.rank}</small> : null}
        <ChevronDown size={14} className="token-chip-arrow" />
      </button>
    );
  }

  return (
    <div className="token-search" ref={boxRef}>
      <Search size={14} className="token-search-icon" />
      <input
        ref={inputRef}
        value={query}
        placeholder="Тикер или название: ETH, Solana…"
        onChange={(e) => {
          setQuery(e.target.value);
          if (e.target.value.trim().length < 2) setItems(null);
        }}
        onKeyDown={onKeyDown}
      />

      {query.trim().length >= 2 && (
        <div className={`token-dropdown ${dropUp ? "up" : ""}`}>
          {items === null && <div className="token-empty">Ищу…</div>}
          {items?.length === 0 && <div className="token-empty">Ничего не нашлось</div>}
          {items?.map((c, i) => (
            <button
              type="button"
              key={c.coinId}
              className={`token-option ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              {c.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={c.image} alt="" width={24} height={24} />
              ) : (
                <span className="token-chip-blank">{c.symbol.slice(0, 2)}</span>
              )}
              <b>{c.symbol}</b>
              <span className="token-option-name">{c.name}</span>
              <small>{c.rank ? `#${c.rank}` : "вне рейтинга"}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
