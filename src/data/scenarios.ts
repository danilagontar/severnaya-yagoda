// Сценарии для показа: события из учётных систем, которых нет в почте.
// В пилоте это симуляция; в продукте приёмка придёт из 1С:ERP, подпись: из Directum RX.
import type { AppEvent } from "@/core/events";

type Body = Extract<AppEvent, { type: "acceptance" | "approval-signed" }> extends infer T ? (T extends AppEvent ? Omit<T, "id" | "at"> : never) : never;

export interface Scenario {
  id: string;
  title: string;
  why: string; // откуда это в данных кейса
  event: Body;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "acc-zp01",
    title: "Склад принял остальные 200 коробов по ЗП-01",
    why: "СГ-03: поставщик обещал довезти до 20.11. Счёт 116 на 1 000 шт ждёт приёмки, счёт 121 на 200 шт лишний.",
    event: { type: "acceptance", order: "ЗП-01", qty: 200, date: "16.11.2026" },
  },
  {
    id: "acc-zp05",
    title: "Склад принял 80 поддонов по ЗП-05",
    why: "В-19: «поддоны привезём сегодня после 17:00». Пока приёмки нет, счёт 88 не оплачивается (П-4).",
    event: { type: "acceptance", order: "ЗП-05", qty: 80, date: "16.11.2026" },
  },
  {
    id: "sign-sg05",
    title: "Подписано СГ-05: этикетка по 2,20 ₽",
    why: "В-11: допсоглашение заведено в Directum, подписи директора по снабжению ещё нет. Счёт 117 по 2,20 ждёт подписи (П-6).",
    event: { type: "approval-signed", approval: "СГ-05", date: "16.11.2026" },
  },
];
