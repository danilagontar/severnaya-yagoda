// Конвертирует Данные_к_кейсу_04.xlsx в src/data/case.json (данные как есть, без интерпретации).
import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2] ?? "data/Данные_к_кейсу_04.xlsx";
const wb = XLSX.read(fs.readFileSync(src));
const sheet = (i) => XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[i]], { header: 1, raw: false, defval: "" });
const body = (rows, headerIdx) => rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim()));
const headerRow = (rows, first) => rows.findIndex((r) => String(r[0]).trim() === first);

const L = sheet(0), O = sheet(1), A = sheet(2), R = sheet(3);
const letters = body(L, headerRow(L, "№")).map(([id, received, sender, text]) => ({ id, received, sender, text }));
const orders = body(O, headerRow(O, "Заказ")).map(([id, date, supplier, buyer, material, unit, ordered, accepted, lastAcceptance, price, approvals]) => ({
  id, date, supplier: supplier.replace(/[«»]/g, ""), buyer, material, unit,
  ordered: Number(ordered), accepted: Number(accepted), lastAcceptance: lastAcceptance || null,
  price: Number(String(price).replace(",", ".")), approvals: approvals ? approvals.split(/[,;\s]+/).filter(Boolean) : [],
}));
const approvals = body(A, headerRow(A, "№")).map(([id, date, order, text, status, signer]) => ({ id, date, order, text, status, signer: signer || null }));
const rules = body(R, headerRow(R, "№")).map(([id, topic, text]) => ({ id, topic, text }));
const meta = { source: path.basename(src), snapshot: "16.11.2026 12:00", note: String(L[1]?.[0] ?? "") };

fs.writeFileSync("src/data/case.json", JSON.stringify({ meta, letters, orders, approvals, rules }, null, 2));
console.log(`letters ${letters.length}, orders ${orders.length}, approvals ${approvals.length}, rules ${rules.length}`);
