"use client";

import React, { useState, useMemo } from "react";

interface PmbiReportsProps {
  db: any;
  storeId: string;
  storeCode: string;
  user: any;
  medicines: any[];
  purchases: any[];
  sales: any[];
  suppliers: any[];
  runWorkerExport: (type: string, payload: any, fileName: string) => void;
  isWorkerExporting: boolean;
  storeDetails: any;
}

const C = {
  navy: "#0A2342",
  teal: "#0D7377",
  teal2: "#14A085",
  blue: "#1565C0",
  green: "#1B7A4E",
  amber: "#92600A",
  red: "#C0392B",
  bg: "#F4F6F9",
  surface: "#ffffff",
  border: "#E2E8F0",
  border2: "#CBD5E0",
  text: "#0A2342",
  text2: "#4A5568",
  text3: "#8A96A3",
};

const S = {
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  input: { fontFamily: "inherit", fontSize: 13, border: `1.5px solid ${C.border2}`, borderRadius: 8, padding: "8px 12px", background: "#fff", color: C.text, outline: "none", width: "100%" },
  label: { display: "block", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 5 },
  btn: (t: string) => ({
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, borderRadius: 8, padding: "10px 18px",
    cursor: "pointer", border: "none", letterSpacing: "0.2px", transition: "all 0.12s",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    background: t === "primary" ? C.navy : t === "teal" ? C.teal : t === "green" ? C.green : t === "red" ? C.red : "#fff",
    color: (t === "outline" || t === "white") ? C.text2 : "#fff",
    borderStyle: t === "outline" ? "solid" : "none",
    borderWidth: t === "outline" ? "1.5px" : "0px",
    borderColor: t === "outline" ? C.border2 : "transparent"
  } as React.CSSProperties),
  badge: (t: string) => ({
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    fontWeight: 700, borderRadius: 12, padding: "3px 8px", textTransform: "uppercase",
    background: t === "red" ? `${C.red}15` : t === "teal" ? `${C.teal}15` : `${C.navy}15`,
    color: t === "red" ? C.red : t === "teal" ? C.teal : C.navy,
    border: `1px solid ${t === "red" ? C.red : t === "teal" ? C.teal : C.navy}30`
  } as React.CSSProperties),
  th: { padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap", background: "#F8FAFC" } as React.CSSProperties,
  td: { padding: "10px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 12.5, color: C.text2 } as React.CSSProperties,
};

export default function PmbiReports({ db, storeId, storeCode, user, medicines, purchases, sales, suppliers, runWorkerExport, isWorkerExporting, storeDetails }: PmbiReportsProps) {
  // Filtering States
  const [period, setPeriod] = useState("month"); // "today" | "week" | "month" | "custom"
  const [startDate, setStartDate] = useState(() => {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];
  });
  const [endDate, setEndDate] = useState(() => new Date().toISOString().split("T")[0]);
  const [searchText, setSearchText] = useState("");

  // Sorting States
  const [sortField, setSortField] = useState("genericName");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  // Determine active date range for purchased/sold quantity aggregations
  const dateRange = useMemo(() => {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    if (period === "today") {
      const s = new Date(); s.setHours(0, 0, 0, 0);
      const e = new Date(); e.setHours(23, 59, 59, 999);
      return { start: s, end: e };
    } else if (period === "week") {
      const s = new Date(); s.setDate(s.getDate() - 7); s.setHours(0, 0, 0, 0);
      const e = new Date(); e.setHours(23, 59, 59, 999);
      return { start: s, end: e };
    } else if (period === "month") {
      const s = new Date(); s.setDate(1); s.setHours(0, 0, 0, 0);
      const e = new Date(); e.setHours(23, 59, 59, 999);
      return { start: s, end: e };
    }
    return { start, end };
  }, [period, startDate, endDate]);

  // Aggregate PMBI batch records and invoice references
  const pmbiReportsData = useMemo(() => {
    const pmbiMeds = medicines.filter((m: any) => m.category === "PMBI");
    
    // Filter sales and purchases in timeframe for quick query aggregation
    const rangePurchases = purchases.filter((p: any) => {
      const pDate = p.invoiceDate ? new Date(p.invoiceDate) : (p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || 0));
      return pDate >= dateRange.start && pDate <= dateRange.end;
    });

    const rangeSales = sales.filter((s: any) => {
      const sDate = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0);
      return sDate >= dateRange.start && sDate <= dateRange.end;
    });

    const records: any[] = [];

    pmbiMeds.forEach((med: any) => {
      const batches = Array.isArray(med.batches) ? med.batches : [];

      batches.forEach((batch: any) => {
        // Find Supplier and Invoice reference from purchases database
        // Matches by drugCode and batchNumber
        let supplierName = "Opening Stock";
        let invoiceNumber = "N/A (OS)";
        let purchaseDate = batch.openingStockDate || "—";

        // Search in ALL purchases to find the original invoice mapping
        const originPurch = purchases.find((p: any) => 
          p.purchaseType === "PMBI" && 
          (p.items || []).some((item: any) => item.drugCode === med.drugCode && item.batchNumber === batch.batchNumber)
        );

        if (originPurch) {
          supplierName = originPurch.supplierName || "—";
          invoiceNumber = originPurch.invoiceNumber || "—";
          purchaseDate = originPurch.invoiceDate || "—";
        } else if (med.lastDistributorName && med.batches.length === 1) {
          supplierName = med.lastDistributorName;
        }

        // Calculate Qty Purchased in selected timeframe
        let qtyPurchased = 0;
        rangePurchases.forEach((p: any) => {
          if (p.purchaseType !== "PMBI") return;
          (p.items || []).forEach((item: any) => {
            if (item.drugCode === med.drugCode && item.batchNumber === batch.batchNumber) {
              qtyPurchased += (item.quantity + (item.freeQuantity || 0));
            }
          });
        });

        // Calculate Qty Sold in selected timeframe
        let qtySold = 0;
        rangeSales.forEach((s: any) => {
          (s.items || []).forEach((item: any) => {
            if (item.medicineId === med.id && Array.isArray(item.batchesUsed)) {
              item.batchesUsed.forEach((bu: any) => {
                if (bu.batchNumber === batch.batchNumber) {
                  qtySold += bu.quantity;
                }
              });
            } else if (item.medicineId === med.id && item.batchNumber === batch.batchNumber) {
              qtySold += (item.quantity || item.qty || 0);
            }
          });
        });

        const mrpVal = batch.mrp || med.mrp || 0;
        const purchaseVal = batch.purchasePrice || med.purchasePrice || 0;
        const sellVal = batch.sellingPrice || med.sellingPrice || mrpVal;

        const record = {
          drugCode: med.drugCode || "—",
          genericName: med.genericName || "—",
          companyName: med.companyName || "PMBI",
          batchNumber: batch.batchNumber || "—",
          manufacturingDate: batch.manufacturingDate || "—",
          expiryDate: batch.expiryDate || "—",
          mrp: mrpVal,
          purchasePrice: purchaseVal,
          sellingPrice: sellVal,
          gstRate: med.gstRate || 0,
          discount: batch.discount || 0,
          qtyPurchased,
          qtySold,
          stockQty: batch.quantity || 0,
          stockValue: (batch.quantity || 0) * purchaseVal,
          supplierName,
          invoiceNumber,
          purchaseDate
        };

        // Text Search Filter
        const searchMatches = 
          record.drugCode.toLowerCase().includes(searchText.toLowerCase()) ||
          record.genericName.toLowerCase().includes(searchText.toLowerCase()) ||
          record.batchNumber.toLowerCase().includes(searchText.toLowerCase()) ||
          record.supplierName.toLowerCase().includes(searchText.toLowerCase());

        if (searchText && !searchMatches) return;

        records.push(record);
      });
    });

    // Client-side Sorting
    records.sort((a: any, b: any) => {
      let valA = a[sortField];
      let valB = b[sortField];
      if (typeof valA === "string") {
        return sortDirection === "asc" 
          ? valA.localeCompare(valB) 
          : valB.localeCompare(valA);
      } else {
        if (valA < valB) return sortDirection === "asc" ? -1 : 1;
        if (valA > valB) return sortDirection === "asc" ? 1 : -1;
        return 0;
      }
    });

    return records;
  }, [medicines, purchases, sales, dateRange, searchText, sortField, sortDirection]);

  // Aggregate overall figures
  const totalStockValue = useMemo(() => {
    return pmbiReportsData.reduce((acc: number, row: any) => acc + row.stockValue, 0);
  }, [pmbiReportsData]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(prev => prev === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const handleExcelExport = () => {
    const fileName = `pmbi_inventory_report_${new Date().toISOString().split("T")[0]}.xlsx`;
    runWorkerExport("EXPORT_PMBI_REPORTS_EXCEL", pmbiReportsData, fileName);
  };

  const handlePdfExport = () => {
    const fileName = `pmbi_inventory_report_${new Date().toISOString().split("T")[0]}.pdf`;
    runWorkerExport("EXPORT_PMBI_REPORTS_PDF", { items: pmbiReportsData, storeInfo: storeDetails }, fileName);
  };

  const getPresetLabel = () => {
    if (period === "today") return "Today";
    if (period === "week") return "Last 7 Days";
    if (period === "month") return "This Month";
    return `${startDate} To ${endDate}`;
  };

  return (
    <div>
      <style>{`
        @media print {
          body, html {
            background: #fff !important;
            color: #000 !important;
          }
          body * {
            visibility: hidden !important;
          }
          .printable-pmbi-report, .printable-pmbi-report * {
            visibility: visible !important;
          }
          .printable-pmbi-report {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            border: none !important;
            box-shadow: none !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .printable-pmbi-report table {
            width: 100% !important;
            border-collapse: collapse !important;
            font-size: 9px !important;
          }
          .printable-pmbi-report th, .printable-pmbi-report td {
            border: 1px solid #000 !important;
            padding: 4px 5px !important;
          }
          .no-print {
            display: none !important;
          }
          tr {
            page-break-inside: avoid !important;
          }
        }
      `}</style>

      {/* HEADER SECTION */}
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: C.navy, margin: 0 }}>📊 PMBI Drug Inventory & Sales Reports</h2>
          <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>Unified ledger displaying current stocks, historical purchases, velocities, and valuations.</div>
        </div>
      </div>

      {/* FILTERS PANEL */}
      <div className="no-print" style={{ ...S.card, padding: 16 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          {[
            ["today", "Today"],
            ["week", "Last 7 Days"],
            ["month", "This Month"],
            ["custom", "Custom Range"]
          ].map(([val, label]) => {
            const isActive = period === val;
            return (
              <button
                key={val}
                onClick={() => setPeriod(val)}
                style={{
                  padding: "6px 14px", borderRadius: 6,
                  border: `1.5px solid ${isActive ? C.teal : C.border2}`,
                  background: isActive ? "#E0F7F4" : "#fff",
                  color: isActive ? C.teal : C.text2,
                  cursor: "pointer", fontFamily: "inherit", fontSize: 12, fontWeight: isActive ? 700 : 500
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
          {period === "custom" && (
            <>
              <div>
                <label style={S.label}>Start Date</label>
                <input type="date" style={S.input} value={startDate} onChange={e => setStartDate(e.target.value)} />
              </div>
              <div>
                <label style={S.label}>End Date</label>
                <input type="date" style={S.input} value={endDate} onChange={e => setEndDate(e.target.value)} />
              </div>
            </>
          )}
          <div style={{ gridColumn: period === "custom" ? "span 1" : "span 2" }}>
            <label style={S.label}>Fuzzy Text Filter (Code, Name, Batch, Supplier)</label>
            <input
              type="text"
              style={S.input}
              placeholder="Search PMBI inventory..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* EXPORT OPTIONS BAR */}
      <div className="no-print" style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: 14 }}>
        <div>
          <span style={{ fontSize: 12, fontWeight: 700, color: C.teal }}>📁 EXPORT PMBI DATA LEDGERS</span>
          <div style={{ fontSize: 11.5, color: C.text2, marginTop: 2 }}>Scope Total Value: <strong style={{ color: C.green }}>₹{totalStockValue.toFixed(2)}</strong></div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={S.btn("primary")} onClick={handleExcelExport} disabled={isWorkerExporting}>
            📊 Export Excel
          </button>
          <button style={S.btn("teal")} onClick={handlePdfExport} disabled={isWorkerExporting}>
            📄 Export PDF
          </button>
          <button style={S.btn("outline")} onClick={() => window.print()}>
            🖨️ Print Layout
          </button>
        </div>
      </div>

      {/* DETAILED REPORT TABLE */}
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }} className="printable-pmbi-report">
        <div className="printable-pmbi-header" style={{ display: "none", marginBottom: 12 }}>
          <h2 style={{ fontSize: 14, fontWeight: 800, textTransform: "uppercase" }}>
            PMBI MEDICINES INVENTORY & COMPLIANCE LEDGER
          </h2>
          <div style={{ fontSize: 9 }}>Period: {getPresetLabel()} | Generated: {new Date().toLocaleString("en-IN")} | Scope Stock Value: ₹{totalStockValue.toFixed(2)}</div>
        </div>

        <div style={{ background: "#F1F5F9", borderBottom: `1px solid ${C.border}`, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }} className="no-print">
          <span style={{ fontSize: 12, fontWeight: 800, color: C.navy, textTransform: "uppercase" }}>
            📋 PMBI Stock & Purchase Registers
          </span>
          <span style={{ ...S.badge("teal"), fontSize: 9.5 }}>
            {pmbiReportsData.length} records in scope
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1400 }}>
            <thead>
              <tr>
                <th onClick={() => handleSort("drugCode")} style={{ ...S.th, cursor: "pointer" }}>Drug Code {sortField === "drugCode" ? (sortDirection === "asc" ? "▲" : "▼") : ""}</th>
                <th onClick={() => handleSort("genericName")} style={{ ...S.th, cursor: "pointer" }}>Drug Name {sortField === "genericName" ? (sortDirection === "asc" ? "▲" : "▼") : ""}</th>
                <th style={S.th}>Company</th>
                <th style={S.th}>Batch</th>
                <th style={S.th}>Mfg Date</th>
                <th style={S.th}>Expiry</th>
                <th style={{ ...S.th, textAlign: "right" }}>MRP</th>
                <th style={{ ...S.th, textAlign: "right" }}>Pur. Price</th>
                <th style={{ ...S.th, textAlign: "right" }}>Sel. Price</th>
                <th style={{ ...S.th, textAlign: "center" }}>GST %</th>
                <th style={{ ...S.th, textAlign: "center" }}>Disc %</th>
                <th style={{ ...S.th, textAlign: "center" }}>Purch. (Period)</th>
                <th style={{ ...S.th, textAlign: "center" }}>Sold (Period)</th>
                <th style={{ ...S.th, textAlign: "center" }}>Current Stock</th>
                <th style={{ ...S.th, textAlign: "right" }}>Stock Value</th>
                <th style={S.th}>Supplier</th>
                <th style={S.th}>Invoice No</th>
                <th style={S.th}>Purch Date</th>
              </tr>
            </thead>
            <tbody>
              {pmbiReportsData.length === 0 ? (
                <tr>
                  <td colSpan={18} style={{ ...S.td, textAlign: "center", color: C.text3, fontStyle: "italic", padding: "24px 0" }}>
                    No PMBI medicine records match the active filters.
                  </td>
                </tr>
              ) : (
                pmbiReportsData.map((row, idx) => (
                  <tr key={idx}>
                    <td style={{ ...S.td, fontWeight: 700 }}>{row.drugCode}</td>
                    <td style={{ ...S.td, fontWeight: 600, color: C.navy }}>{row.genericName}</td>
                    <td style={S.td}>{row.companyName}</td>
                    <td style={{ ...S.td, fontFamily: "monospace", fontWeight: 700 }}>{row.batchNumber}</td>
                    <td style={S.td}>{row.manufacturingDate}</td>
                    <td style={S.td}>{row.expiryDate}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>₹{row.mrp.toFixed(2)}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>₹{row.purchasePrice.toFixed(2)}</td>
                    <td style={{ ...S.td, textAlign: "right" }}>₹{row.sellingPrice.toFixed(2)}</td>
                    <td style={{ ...S.td, textAlign: "center" }}>{row.gstRate}%</td>
                    <td style={{ ...S.td, textAlign: "center" }}>{row.discount}%</td>
                    <td style={{ ...S.td, textAlign: "center", fontWeight: 600 }}>{row.qtyPurchased}</td>
                    <td style={{ ...S.td, textAlign: "center", fontWeight: 600 }}>{row.qtySold}</td>
                    <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: row.stockQty <= 10 ? C.red : C.text }}>{row.stockQty}</td>
                    <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.green }}>₹{row.stockValue.toFixed(2)}</td>
                    <td style={S.td}>{row.supplierName}</td>
                    <td style={{ ...S.td, color: C.blue, fontWeight: 600 }}>{row.invoiceNumber}</td>
                    <td style={S.td}>{row.purchaseDate}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
