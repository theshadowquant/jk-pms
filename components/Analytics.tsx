"use client";

import React, { useMemo, useState } from "react";
import {
  TrendingUp, TrendingDown, DollarSign, ShoppingBag, Package,
  BarChart3, PieChart, ArrowUpRight, ArrowDownRight, Activity,
  ChevronDown, Minus, Award, AlertCircle,
} from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────────────
interface SaleItem {
  medicineId?: string;
  genericName?: string;
  brandName?: string;
  quantity?: number;
  total?: number;
  cogs?: number;
  profit?: number;
  totalGst?: number;
}

interface Sale {
  id?: string;
  grandTotal?: number;
  cogs?: number;
  profit?: number;
  totalGst?: number;
  paymentMode?: string;
  items?: SaleItem[];
  createdAt?: any;
  date?: string;
}

interface PurchaseItem {
  genericName?: string;
  quantity?: number;
  purchasePrice?: number;
  mrp?: number;
}

interface Purchase {
  id?: string;
  totalAmount?: number;
  supplierName?: string;
  invoiceDate?: string;
  items?: PurchaseItem[];
  createdAt?: any;
}

interface Medicine {
  id?: string;
  genericName?: string;
  brandName?: string;
  stockQty?: number;
  purchasePrice?: number;
  sellingPrice?: number;
  mrp?: number;
  category?: string;
}

interface AnalyticsProps {
  sales: Sale[];
  purchases: Purchase[];
  medicines: Medicine[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────
const fmt = (n: number) =>
  "\u20B9" + n.toLocaleString("en-IN", { maximumFractionDigits: 0 });

const fmtDec = (n: number) =>
  "\u20B9" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const pctOf = (n: number, d: number) =>
  d === 0 ? "0.0" : ((n / d) * 100).toFixed(1);

function getDateObj(sale: Sale): Date {
  if (sale.createdAt?.toDate) return sale.createdAt.toDate();
  if (sale.createdAt?.seconds) return new Date(sale.createdAt.seconds * 1000);
  if (sale.date) return new Date(sale.date);
  return new Date(0);
}

function getPurchaseDate(p: Purchase): Date {
  if (p.createdAt?.toDate) return p.createdAt.toDate();
  if (p.createdAt?.seconds) return new Date(p.createdAt.seconds * 1000);
  if (p.invoiceDate) return new Date(p.invoiceDate);
  return new Date(0);
}

function startOf(period: Period): Date {
  const d = new Date();
  if (period === "today") { d.setHours(0, 0, 0, 0); return d; }
  if (period === "week") { d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d; }
  if (period === "month") { d.setDate(1); d.setHours(0, 0, 0, 0); return d; }
  d.setMonth(0, 1); d.setHours(0, 0, 0, 0); return d; // year
}

// ─── Colour Tokens ─────────────────────────────────────────────────────────
const C = {
  bg:     "#F5F7FA",
  card:   "#FFFFFF",
  navy:   "#0B192C",
  teal:   "#0D7377",
  teal2:  "#14A085",
  green:  "#16A34A",
  red:    "#DC2626",
  amber:  "#D97706",
  blue:   "#2563EB",
  purple: "#7C3AED",
  indigo: "#4338CA",
  text:   "#1E293B",
  text2:  "#64748B",
  text3:  "#94A3B8",
  border: "#E2E8F0",
  border2:"#CBD5E1",
};

const PALETTE = [C.teal, C.blue, C.purple, C.amber, C.green, C.indigo, C.red];

const PERIOD_OPTIONS = [
  { id: "today", label: "Today" },
  { id: "week",  label: "Last 7 Days" },
  { id: "month", label: "This Month" },
  { id: "year",  label: "This Year" },
] as const;
type Period = typeof PERIOD_OPTIONS[number]["id"];

// ─── KPI Card ──────────────────────────────────────────────────────────────
function KpiCard({
  title, value, sub, icon: Icon, color, trend, trendVal,
}: {
  title: string; value: string; sub?: string;
  icon: React.ComponentType<any>; color: string;
  trend?: "up" | "down" | "flat"; trendVal?: string;
}) {
  const TrendIcon = trend === "up" ? ArrowUpRight : trend === "down" ? ArrowDownRight : Minus;
  const trendColor = trend === "up" ? C.green : trend === "down" ? C.red : C.text3;
  return (
    <div style={{
      background: C.card, borderRadius: 16, padding: "20px 22px",
      boxShadow: "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)",
      display: "flex", flexDirection: "column", gap: 10,
      flex: "1 1 180px", borderTop: `3px solid ${color}`,
      transition: "transform .18s,box-shadow .18s", cursor: "default",
    }}
    onMouseEnter={e => {
      (e.currentTarget as HTMLDivElement).style.transform = "translateY(-3px)";
      (e.currentTarget as HTMLDivElement).style.boxShadow = "0 6px 24px rgba(0,0,0,.10)";
    }}
    onMouseLeave={e => {
      (e.currentTarget as HTMLDivElement).style.transform = "translateY(0)";
      (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)";
    }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.text2, textTransform: "uppercase", letterSpacing: ".6px", marginBottom: 6 }}>
            {title}
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: C.navy, lineHeight: 1.1 }}>{value}</div>
          {sub && <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>{sub}</div>}
        </div>
        <div style={{ width: 40, height: 40, borderRadius: 12, background: color + "18", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon size={20} color={color} strokeWidth={1.8} />
        </div>
      </div>
      {trendVal && (
        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: trendColor, fontWeight: 600 }}>
          <TrendIcon size={14} />
          {trendVal}
        </div>
      )}
    </div>
  );
}

// ─── Section Header ────────────────────────────────────────────────────────
function SH({ icon: Icon, color, children }: { icon: React.ComponentType<any>; color: string; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
      <Icon size={14} color={color} strokeWidth={2} />
      {children}
    </div>
  );
}

// ─── Mini Progress Bar ─────────────────────────────────────────────────────
function MiniBar({ label, value, max, color, secondary }: { label: string; value: number; max: number; color: string; secondary?: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 11 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span style={{ color: C.text, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "60%" }}>{label}</span>
        <span style={{ color: C.text2, display: "flex", gap: 10 }}>
          {secondary && <span style={{ color: C.text3 }}>{secondary}</span>}
          <span style={{ color: C.navy, fontWeight: 700 }}>{fmt(value)}</span>
        </span>
      </div>
      <div style={{ height: 7, borderRadius: 4, background: C.border, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${w}%`, background: `linear-gradient(90deg,${color},${color}99)`, borderRadius: 4, transition: "width .5s ease" }} />
      </div>
    </div>
  );
}

// ─── SVG Trend Chart ───────────────────────────────────────────────────────
function TrendChart({ sales, period }: { sales: Sale[]; period: Period }) {
  const isYear = period === "year";
  const days = period === "today" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 12;

  const buckets = useMemo(() => {
    if (isYear) {
      const arr = Array.from({ length: 12 }, (_, i) => {
        const d = new Date(); d.setMonth(i, 1); d.setHours(0, 0, 0, 0);
        return { label: d.toLocaleString("en-IN", { month: "short" }), revenue: 0, profit: 0 };
      });
      sales.forEach(s => {
        const mo = getDateObj(s).getMonth();
        arr[mo].revenue += s.grandTotal || 0;
        arr[mo].profit  += s.profit  || 0;
      });
      return arr;
    }
    const arr = Array.from({ length: days }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (days - 1 - i)); d.setHours(0, 0, 0, 0);
      return { label: d.toLocaleString("en-IN", { day: "numeric", month: "short" }), revenue: 0, profit: 0, dateStr: d.toDateString() };
    });
    sales.forEach(s => {
      const ds = getDateObj(s).toDateString();
      const idx = arr.findIndex(b => (b as any).dateStr === ds);
      if (idx >= 0) { arr[idx].revenue += s.grandTotal || 0; arr[idx].profit += s.profit || 0; }
    });
    return arr;
  }, [sales, period, days, isYear]);

  const W = 620, H = 130, PAD = 22;
  const cW = W - PAD * 2;
  const step = cW / Math.max(buckets.length - 1, 1);
  const maxR = Math.max(...buckets.map(b => b.revenue), 1);
  const maxP = Math.max(...buckets.map(b => b.profit), 1);
  const ry = (v: number) => H - PAD - (v / maxR) * (H - PAD * 2);
  const py = (v: number) => H - PAD - (v / maxP) * (H - PAD * 2);
  const rPts = buckets.map((b, i) => `${PAD + i * step},${ry(b.revenue)}`).join(" ");
  const pPts = buckets.map((b, i) => `${PAD + i * step},${py(b.profit)}`).join(" ");
  const last = PAD + (buckets.length - 1) * step;

  return (
    <div style={{ background: C.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <SH icon={Activity} color={C.teal}>Revenue &amp; Profit Trend</SH>
        <div style={{ display: "flex", gap: 16, fontSize: 11 }}>
          {[["Revenue", C.teal], ["Profit", C.green]].map(([lbl, col]) => (
            <span key={lbl} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 10, height: 3, borderRadius: 2, background: col as string, display: "inline-block" }} />
              <span style={{ color: C.text2 }}>{lbl}</span>
            </span>
          ))}
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 280, height: H, display: "block" }}>
          <defs>
            <linearGradient id="ag_rGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.teal} stopOpacity={0.18} /><stop offset="100%" stopColor={C.teal} stopOpacity={0} />
            </linearGradient>
            <linearGradient id="ag_pGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.green} stopOpacity={0.18} /><stop offset="100%" stopColor={C.green} stopOpacity={0} />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75, 1].map(f => (
            <line key={f} x1={PAD} y1={H - PAD - f * (H - PAD * 2)} x2={W - PAD} y2={H - PAD - f * (H - PAD * 2)}
              stroke={C.border} strokeWidth={0.7} strokeDasharray="4,4" />
          ))}
          <polygon points={`${PAD},${H - PAD} ${rPts} ${last},${H - PAD}`} fill="url(#ag_rGrad)" />
          <polygon points={`${PAD},${H - PAD} ${pPts} ${last},${H - PAD}`} fill="url(#ag_pGrad)" />
          <polyline points={rPts} fill="none" stroke={C.teal} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          <polyline points={pPts} fill="none" stroke={C.green} strokeWidth={2.2} strokeLinejoin="round" strokeLinecap="round" />
          {buckets.map((b, i) => (
            <g key={i}>
              <circle cx={PAD + i * step} cy={ry(b.revenue)} r={3.2} fill={C.teal} />
              <circle cx={PAD + i * step} cy={py(b.profit)} r={3.2} fill={C.green} />
            </g>
          ))}
        </svg>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 22px 0", fontSize: 10, color: C.text3 }}>
          {buckets.filter((_, i) => buckets.length <= 12 || i % Math.ceil(buckets.length / 8) === 0).map((b, i) => (
            <span key={i}>{b.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Donut ─────────────────────────────────────────────────────────────────
function Donut({ data }: { data: { label: string; value: number; color: string }[] }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  let cum = -90;
  const slices = data.map(d => {
    const a = total > 0 ? (d.value / total) * 360 : 0;
    const s = cum; cum += a;
    return { ...d, angle: a, start: s };
  });
  const arc = (cx: number, cy: number, r: number, s: number, e: number) => {
    const R = (deg: number) => (deg * Math.PI) / 180;
    const x1 = cx + r * Math.cos(R(s)), y1 = cy + r * Math.sin(R(s));
    const x2 = cx + r * Math.cos(R(e)), y2 = cy + r * Math.sin(R(e));
    return `M${cx} ${cy}L${x1} ${y1}A${r} ${r} 0 ${e - s > 180 ? 1 : 0} 1 ${x2} ${y2}Z`;
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
      <svg width={96} height={96} viewBox="0 0 96 96" style={{ flexShrink: 0 }}>
        {total === 0 ? (
          <circle cx={48} cy={48} r={36} fill="none" stroke={C.border} strokeWidth={14} />
        ) : (
          slices.map((s, i) => <path key={i} d={arc(48, 48, 36, s.start, s.start + s.angle - 0.4)} fill={s.color} opacity={0.9} />)
        )}
        <circle cx={48} cy={48} r={21} fill={C.card} />
        <text x={48} y={45} textAnchor="middle" fontSize={7} fill={C.text2} fontWeight={600}>SALES</text>
        <text x={48} y={55} textAnchor="middle" fontSize={8} fill={C.navy} fontWeight={800}>{total > 0 ? fmt(total) : "\u20B90"}</text>
      </svg>
      <div style={{ flex: 1, minWidth: 130 }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: C.text, flex: 1 }}>{d.label}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>{pctOf(d.value, total)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────
export default function Analytics({ sales, purchases, medicines }: AnalyticsProps) {
  const [period, setPeriod] = useState<Period>("month");
  const [showMenu, setShowMenu] = useState(false);

  const filteredSales = useMemo(() => {
    const start = startOf(period);
    return sales.filter(s => getDateObj(s) >= start);
  }, [sales, period]);

  const filteredPurchases = useMemo(() => {
    const start = startOf(period);
    return purchases.filter(p => getPurchaseDate(p) >= start);
  }, [purchases, period]);

  // ── Core KPIs ────────────────────────────────────────────────────────────
  const totalRevenue  = filteredSales.reduce((s, b) => s + (b.grandTotal || 0), 0);
  const totalCogs     = filteredSales.reduce((s, b) => s + (b.cogs       || 0), 0);
  const totalProfit   = filteredSales.reduce((s, b) => s + (b.profit     || 0), 0);
  const totalGst      = filteredSales.reduce((s, b) => s + (b.totalGst   || 0), 0);
  const totalBills    = filteredSales.length;
  const grossMarginPct = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
  const totalPurchAmt = filteredPurchases.reduce((s, p) => s + (p.totalAmount || 0), 0);

  // ── Prev period comparison ────────────────────────────────────────────────
  const prevRevenue = useMemo(() => {
    const ms = { today: 864e5, week: 7 * 864e5, month: 30 * 864e5, year: 365 * 864e5 }[period];
    const pStart = new Date(startOf(period).getTime() - ms);
    const pEnd   = startOf(period);
    return sales.filter(s => { const d = getDateObj(s); return d >= pStart && d < pEnd; })
                .reduce((s, b) => s + (b.grandTotal || 0), 0);
  }, [sales, period]);
  const revTrend: "up" | "down" | "flat" = totalRevenue > prevRevenue ? "up" : totalRevenue < prevRevenue ? "down" : "flat";
  const revDiffStr = prevRevenue > 0 ? `${(((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1)}% vs prev period` : undefined;

  // ── Top medicines by profit ───────────────────────────────────────────────
  const topMeds = useMemo(() => {
    const map: Record<string, { name: string; profit: number; revenue: number; qty: number }> = {};
    filteredSales.forEach(s => {
      (s.items || []).forEach(item => {
        const key = item.medicineId || item.genericName || "?";
        const name = item.brandName || item.genericName || "Unknown";
        if (!map[key]) map[key] = { name, profit: 0, revenue: 0, qty: 0 };
        map[key].profit  += item.profit  || 0;
        map[key].revenue += item.total   || 0;
        map[key].qty     += item.quantity || 0;
      });
    });
    return Object.values(map).sort((a, b) => b.profit - a.profit).slice(0, 8);
  }, [filteredSales]);
  const maxMedProfit = topMeds[0]?.profit || 1;

  // ── Payment mode ──────────────────────────────────────────────────────────
  const paymentData = useMemo(() => {
    const modes: Record<string, number> = {};
    filteredSales.forEach(s => {
      const m = (s.paymentMode || "Cash").trim();
      modes[m] = (modes[m] || 0) + (s.grandTotal || 0);
    });
    return Object.entries(modes).sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: PALETTE[i % PALETTE.length] }));
  }, [filteredSales]);

  // ── Category breakdown ────────────────────────────────────────────────────
  const catRevenue = useMemo(() => {
    const map: Record<string, number> = {};
    filteredSales.forEach(s => {
      (s.items || []).forEach(item => {
        const med = medicines.find(m => m.id === item.medicineId);
        const cat = med?.category || "General";
        map[cat] = (map[cat] || 0) + (item.total || 0);
      });
    });
    return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 5);
  }, [filteredSales, medicines]);
  const maxCat = catRevenue[0]?.[1] || 1;

  // ── Inventory value ───────────────────────────────────────────────────────
  const invCost = medicines.reduce((s, m) => s + ((m.stockQty || 0) * (m.purchasePrice || 0)), 0);
  const invMrp  = medicines.reduce((s, m) => s + ((m.stockQty || 0) * (m.mrp          || 0)), 0);

  const periodLabel = PERIOD_OPTIONS.find(p => p.id === period)?.label ?? "";

  // ── P&L rows ─────────────────────────────────────────────────────────────
  const netEst = totalProfit - Math.max(0, totalPurchAmt - totalCogs);
  const plRows = [
    { label: "💰 Gross Revenue",        val: totalRevenue,  p: 100,                                    bold: true,  color: C.navy   },
    { label: "⬇ Cost of Goods (COGS)", val: totalCogs,     p: +pctOf(totalCogs, totalRevenue),         bold: false, color: C.red    },
    { label: "🧾 GST Collected",         val: totalGst,      p: +pctOf(totalGst, totalRevenue),          bold: false, color: C.purple },
    { label: "✅ Gross Profit",           val: totalProfit,   p: +pctOf(totalProfit, totalRevenue),       bold: true,  color: C.green  },
    { label: "🛒 Total Purchases",        val: totalPurchAmt, p: +pctOf(totalPurchAmt, totalRevenue),     bold: false, color: C.blue   },
    { label: "📈 Net Margin (Est.)",      val: netEst,        p: +pctOf(netEst, totalRevenue),            bold: true,  color: netEst >= 0 ? C.teal : C.red },
  ];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1400, margin: "0 auto" }}>

      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 26, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: C.navy, margin: 0, letterSpacing: "-.3px" }}>
            📊 Profit &amp; Analytics
          </h2>
          <div style={{ fontSize: 13, color: C.text2, marginTop: 4 }}>
            Financial overview — <strong>{periodLabel}</strong> &nbsp;·&nbsp; {totalBills} bills
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setShowMenu(v => !v)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", background: C.card, border: `1.5px solid ${C.border2}`, borderRadius: 10, fontSize: 13, fontWeight: 600, color: C.navy, cursor: "pointer", boxShadow: "0 1px 4px rgba(0,0,0,.06)" }}
          >
            {periodLabel} <ChevronDown size={14} />
          </button>
          {showMenu && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 8px 28px rgba(0,0,0,.12)", zIndex: 200, minWidth: 150, overflow: "hidden" }}>
              {PERIOD_OPTIONS.map(opt => (
                <button key={opt.id} onClick={() => { setPeriod(opt.id); setShowMenu(false); }}
                  style={{ width: "100%", padding: "10px 16px", textAlign: "left", background: period === opt.id ? C.teal + "14" : "none", border: "none", fontSize: 13, fontWeight: period === opt.id ? 700 : 500, color: period === opt.id ? C.teal : C.text, cursor: "pointer", display: "block" }}>
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── KPI Cards ── */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
        <KpiCard title="Total Revenue"    value={fmt(totalRevenue)}  sub={`${totalBills} bills`}                  icon={DollarSign}   color={C.teal}   trend={revTrend}                   trendVal={revDiffStr} />
        <KpiCard title="Gross Profit"     value={fmt(totalProfit)}   sub={`Margin: ${grossMarginPct.toFixed(1)}%`} icon={TrendingUp}   color={C.green}  trend={totalProfit >= 0 ? "up" : "down"} trendVal={`COGS: ${fmt(totalCogs)}`} />
        <KpiCard title="Total Purchases"  value={fmt(totalPurchAmt)} sub={`${filteredPurchases.length} invoices`} icon={ShoppingBag}  color={C.blue}   />
        <KpiCard title="GST Collected"    value={fmt(totalGst)}      sub="Tax collected"                          icon={BarChart3}    color={C.purple} />
        <KpiCard title="Inventory Value"  value={fmt(invCost)}       sub={`MRP: ${fmt(invMrp)}`}                  icon={Package}      color={C.amber}  trend="flat" trendVal={`${medicines.length} SKUs`} />
      </div>

      {/* ── Trend Chart ── */}
      <div style={{ marginBottom: 24 }}>
        <TrendChart sales={filteredSales} period={period} />
      </div>

      {/* ── Grid: Top Meds + Side panels ── */}
      <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 20, marginBottom: 24 }}>

        {/* Top Medicines */}
        <div style={{ background: C.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)" }}>
          <SH icon={Award} color={C.green}>Top Medicines by Profit</SH>
          {topMeds.length === 0 ? (
            <div style={{ textAlign: "center", color: C.text3, fontSize: 13, padding: "32px 0" }}>
              <AlertCircle size={32} color={C.text3} style={{ marginBottom: 8 }} /><br />No sales data for this period
            </div>
          ) : topMeds.map((m, i) => (
            <MiniBar key={i}
              label={`#${i + 1}  ${m.name}`}
              value={m.profit}
              max={maxMedProfit}
              color={i === 0 ? C.green : i === 1 ? C.teal : i === 2 ? C.blue : C.text3}
              secondary={`${m.qty} units`}
            />
          ))}
        </div>

        {/* Right column: Donut + Category */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ background: C.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)", flex: 1 }}>
            <SH icon={PieChart} color={C.blue}>Payment Modes</SH>
            <Donut data={paymentData.length > 0 ? paymentData : [{ label: "No Data", value: 1, color: C.border }]} />
          </div>
          <div style={{ background: C.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)", flex: 1 }}>
            <SH icon={BarChart3} color={C.purple}>Revenue by Category</SH>
            {catRevenue.length === 0 ? (
              <div style={{ color: C.text3, fontSize: 12, textAlign: "center", padding: "14px 0" }}>No data</div>
            ) : catRevenue.map(([cat, val], i) => (
              <MiniBar key={i} label={cat} value={val} max={maxCat} color={PALETTE[i % PALETTE.length]} />
            ))}
          </div>
        </div>
      </div>

      {/* ── P&L Table ── */}
      <div style={{ background: C.card, borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 4px rgba(0,0,0,.07),0 4px 16px rgba(0,0,0,.04)" }}>
        <SH icon={TrendingUp} color={C.teal}>Profit &amp; Loss Summary</SH>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F8FAFC" }}>
                {["Metric", "Amount", "% of Revenue"].map(h => (
                  <th key={h} style={{ padding: "10px 14px", textAlign: "left", color: C.text2, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: ".5px", borderBottom: `1.5px solid ${C.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {plRows.map((row, i) => (
                <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#FAFBFD" }}>
                  <td style={{ padding: "11px 14px", color: C.text, fontWeight: row.bold ? 700 : 400 }}>{row.label}</td>
                  <td style={{ padding: "11px 14px", color: row.color, fontWeight: row.bold ? 800 : 600 }}>{fmtDec(row.val)}</td>
                  <td style={{ padding: "11px 14px", color: C.text2 }}>{row.p.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
