import type { Indicators } from "./types";

/** Короткая расшифровка индикаторов словами — для карточки и для промпта. */
export function readIndicators(ind: Indicators): { text: string; tone: "good" | "bad" | "neutral" }[] {
  const out: { text: string; tone: "good" | "bad" | "neutral" }[] = [];

  if (ind.rsi14 != null) {
    const v = ind.rsi14;
    out.push({
      text:
        v >= 70
          ? `RSI ${v.toFixed(0)} — перекупленность, покупатели выдохлись`
          : v <= 30
            ? `RSI ${v.toFixed(0)} — перепроданность, продавцы выдохлись`
            : `RSI ${v.toFixed(0)} — без крайностей`,
      tone: v >= 70 ? "bad" : v <= 30 ? "good" : "neutral",
    });
  }
  if (ind.aboveSma50 != null) {
    out.push({
      text: ind.aboveSma50 ? "Цена выше средней за 50 дней" : "Цена ниже средней за 50 дней",
      tone: ind.aboveSma50 ? "good" : "bad",
    });
  }
  if (ind.goldenCross != null) {
    out.push({
      text: ind.goldenCross ? "Средняя за 50 дней выше годовой — тренд вверх" : "Средняя за 50 дней ниже годовой — тренд вниз",
      tone: ind.goldenCross ? "good" : "bad",
    });
  }
  if (ind.rangePosition != null) {
    const p = ind.rangePosition;
    out.push({
      text: `В месячном коридоре цена на ${p.toFixed(0)}% пути от минимума к максимуму`,
      tone: p >= 75 ? "good" : p <= 25 ? "bad" : "neutral",
    });
  }
  if (ind.volumeTrendPct != null) {
    const v = ind.volumeTrendPct;
    out.push({
      text:
        v > 25
          ? `Объёмы за неделю выше месячных на ${v.toFixed(0)}% — интерес растёт`
          : v < -25
            ? `Объёмы за неделю ниже месячных на ${Math.abs(v).toFixed(0)}% — интерес уходит`
            : "Объёмы держатся на уровне месяца",
      tone: v > 25 ? "good" : v < -25 ? "bad" : "neutral",
    });
  }
  if (ind.atrPct != null) {
    out.push({ text: `Средний дневной размах ${ind.atrPct.toFixed(1)}%`, tone: "neutral" });
  }
  return out;
}
