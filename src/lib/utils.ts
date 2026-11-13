import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Русское склонение по числу: plural(1, ["счёт", "счёта", "счетов"]) → «счёт». */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const INVOICES: [string, string, string] = ["счёт", "счёта", "счетов"];
