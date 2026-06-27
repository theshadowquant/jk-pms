"use client";

import React, { useState, useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";

interface StockInventoryReportProps {
  db: any;
  storeId: string;
  storeCode: string;
  user: any;
  medicines: any[];
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
  input: { fontFamily: "inherit", fontSize: 13, border: `1.5px solid ${C.border2}`, borderRadius: 8, padding: "9px 12px", background: "#fff", color: C.text, outline: "none", width: "100%" },
  label: { display: "block", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 5 },
  btn: (t: string) => ({
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, borderRadius: 8, padding: "10px 18px",
    cursor: "pointer", border: "none", letterSpacing: "0.2px", transition: "all 0.12s",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    background: t === "primary" ? C.navy : t === "teal" ? C.teal : t === "green" ? C.green : t === "whatsapp" ? "#25D366" : "#fff",
    color: t === "outline" ? C.text2 : "#fff",
    borderStyle: t === "outline" ? "solid" : "none",
    borderWidth: t === "outline" ? "1.5px" : "0px",
    borderColor: t === "outline" ? C.border2 : "transparent"
  } as React.CSSProperties),
  th: { padding: "12px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap", background: "#F8FAFC" } as React.CSSProperties,
  td: { padding: "12px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.text2 } as React.CSSProperties,
  kpi: {
    padding: "14px 18px",
    borderRadius: 10,
    background: "#F8FAFC",
    border: `1.5px solid ${C.border}`,
    display: "flex",
    flexDirection: "column" as const,
    gap: 4
  }
};

export default function StockInventoryReport({ db, storeId, storeCode, user, medicines }: StockInventoryReportProps) {
  const [searchText, setSearchText] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | "regular" | "pmbi"
  const [h1Filter, setH1Filter] = useState("all"); // "all" | "h1" | "non-h1"
  const [stockLevelFilter, setStockLevelFilter] = useState("all"); // "all" | "in-stock" | "low" | "out"
  
  const [storeDetails, setStoreDetails] = useState<any>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Fetch store details for print header
  useEffect(() => {
    if (!storeId) return;
    const fetchStore = async () => {
      try {
        const storeSnap = await getDoc(doc(db, "stores", storeId));
        if (storeSnap.exists()) {
          setStoreDetails(storeSnap.data());
        }
      } catch (err) {
        console.error("Error fetching store info in stock report:", err);
      }
    };
    fetchStore();
  }, [storeId, db]);

  // Apply filters
  const filteredMeds = medicines.filter(m => {
    const sTerm = searchText.toLowerCase().trim();
    const matchText = !sTerm || 
      (m.drugCode || "").toLowerCase().includes(sTerm) ||
      (m.barcode || "").toLowerCase().includes(sTerm) ||
      (m.genericName || "").toLowerCase().includes(sTerm) ||
      (m.brandName || "").toLowerCase().includes(sTerm);

    let matchCat = true;
    if (categoryFilter === "pmbi") {
      matchCat = m.category === "PMBI";
    } else if (categoryFilter === "regular") {
      matchCat = m.category !== "PMBI";
    }

    let matchH1 = true;
    if (h1Filter === "h1") {
      matchH1 = m.isH1Drug === true;
    } else if (h1Filter === "non-h1") {
      matchH1 = m.isH1Drug !== true;
    }

    let matchStock = true;
    const stockQty = m.stockQty || 0;
    const lowLimit = m.lowStockAlert || 20;
    if (stockLevelFilter === "in-stock") {
      matchStock = stockQty > 0;
    } else if (stockLevelFilter === "low") {
      matchStock = stockQty > 0 && stockQty <= lowLimit;
    } else if (stockLevelFilter === "out") {
      matchStock = stockQty <= 0;
    }

    return matchText && matchCat && matchH1 && matchStock;
  });

  // Calculate Summary metrics
  const totalValuation = filteredMeds.reduce((sum, m) => sum + (m.stockQty || 0) * (m.purchasePrice || 0), 0);
  const totalStockQty = filteredMeds.reduce((sum, m) => sum + (m.stockQty || 0), 0);
  const lowStockCount = filteredMeds.filter(m => (m.stockQty || 0) > 0 && (m.stockQty || 0) <= (m.lowStockAlert || 20)).length;
  const h1Count = filteredMeds.filter(m => m.isH1Drug === true).length;

  // Trigger web worker exports
  const runWorkerExport = (type: string, fileName: string) => {
    if (isExporting) return;
    setIsExporting(true);

    try {
      const payload = {
        items: filteredMeds,
        storeInfo: {
          name: storeDetails?.name || "JANAUSHADHI PHARMACY",
          gstin: storeDetails?.gstin || "—",
          drugLicense: storeDetails?.drugLicense || "—",
          address: storeDetails?.address || "—",
          phone: storeDetails?.phone || "—",
        }
      };

      const worker = new Worker("/workers/report.worker.js?v=" + Date.now());
      worker.postMessage({ type, payload, fileName });

      worker.onmessage = (e) => {
        const { success, fileData, error } = e.data;
        if (success) {
          const mime = type.endsWith("PDF") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          const blob = new Blob([fileData], { type: mime });
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        } else {
          alert("Web Worker Export failed: " + error);
        }
        setIsExporting(false);
        worker.terminate();
      };

      worker.onerror = (err) => {
        console.error("Worker error:", err);
        alert("Web Worker failed executing.");
        setIsExporting(false);
        worker.terminate();
      };
    } catch (e) {
      console.error(e);
      alert("Failed to spawn background thread.");
      setIsExporting(false);
    }
  };

  // Direct CSV download
  const handleExportCSV = () => {
    const headers = [
      "Drug Code", "Barcode", "Generic Name", "Brand Name", "UOM", "Company", 
      "MRP", "Purchase Price", "Selling Price", "GST Rate %", "Schedule H1", 
      "Current Stock", "Stock Value (INR)", "Active Batches"
    ].join(",");
    
    const rows = filteredMeds.map(m => {
      const batchesStr = (m.batches || []).map((b: any) => `${b.batchNumber}(Qty:${b.quantity},Exp:${b.expiryDate})`).join(" | ");
      return [
        `"${m.drugCode || ""}"`,
        `"${m.barcode || ""}"`,
        `"${(m.genericName || "").replace(/"/g, '""')}"`,
        `"${(m.brandName || "").replace(/"/g, '""')}"`,
        `"${m.form || ""}"`,
        `"${(m.companyName || "").replace(/"/g, '""')}"`,
        (m.mrp || 0).toFixed(2),
        (m.purchasePrice || 0).toFixed(2),
        (m.sellingPrice || 0).toFixed(2),
        `${m.gstRate || 0}%`,
        m.isH1Drug ? "Yes" : "No",
        m.stockQty || 0,
        ((m.stockQty || 0) * (m.purchasePrice || 0)).toFixed(2),
        `"${batchesStr}"`
      ].join(",");
    });
    
    const csvContent = "\ufeff" + [headers, ...rows].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stock_report_${new Date().toISOString().substring(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Browser Print trigger
  const handlePrint = () => {
    window.print();
  };

  return (
    <div>
      {/* Print Stylesheet overrides */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .printable-report-area, .printable-report-area * {
            visibility: visible;
          }
          .printable-report-area {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          .no-print {
            display: none !important;
          }
          #print-header-details {
            display: block !important;
          }
        }
      `}</style>

      {/* HEADER SECTION */}
      <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: C.navy, margin: 0 }}>📋 Current Stock Inventory Report</h2>
          <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>
            Valuation list and catalog status. Real-time audit metrics.
          </div>
        </div>
      </div>

      {/* KPI METRICS OVERVIEW CARDS */}
      <div className="no-print" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14, marginBottom: 16 }}>
        <div style={S.kpi}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px" }}>TOTAL PRODUCTS</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: C.navy }}>{filteredMeds.length} items</span>
        </div>
        <div style={S.kpi}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px" }}>STOCK QUANTITY</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: C.blue }}>{totalStockQty} units</span>
        </div>
        <div style={S.kpi}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px" }}>LANDED VALUATION</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: C.green }}>₹{totalValuation.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
        <div style={S.kpi}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px" }}>LOW STOCK ITEMS</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: lowStockCount > 0 ? C.red : C.green }}>{lowStockCount} items</span>
        </div>
        <div style={S.kpi}>
          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px" }}>H1 COMPLIANT DRUGS</span>
          <span style={{ fontSize: 22, fontWeight: 800, color: C.amber }}>{h1Count} items</span>
        </div>
      </div>

      {/* FILTERS PANEL */}
      <div className="no-print" style={{ ...S.card, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
        <div>
          <label style={S.label}>Search Inventory</label>
          <input
            style={S.input}
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            placeholder="Search code, composition, brand..."
          />
        </div>

        <div>
          <label style={S.label}>Category Classification</label>
          <select style={S.input} value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
            <option value="all">All Products</option>
            <option value="regular">Branded & Generic Medicines</option>
            <option value="pmbi">PMBI Medicines Only</option>
          </select>
        </div>

        <div>
          <label style={S.label}>Schedule H1 Compliance</label>
          <select style={S.input} value={h1Filter} onChange={e => setH1Filter(e.target.value)}>
            <option value="all">All Items</option>
            <option value="h1">Schedule H1 Only</option>
            <option value="non-h1">Exclude Schedule H1</option>
          </select>
        </div>

        <div>
          <label style={S.label}>Stock Level Status</label>
          <select style={S.input} value={stockLevelFilter} onChange={e => setStockLevelFilter(e.target.value)}>
            <option value="all">All Levels</option>
            <option value="in-stock">In Stock (&gt; 0)</option>
            <option value="low">Warning Low Stock</option>
            <option value="out">Out of Stock (0)</option>
          </select>
        </div>
      </div>

      {/* ACTION TOOLBAR: EXPORTS */}
      <div className="no-print" style={{ ...S.card, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "12px 20px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, letterSpacing: "0.5px" }}>EXPORT INVENTORY</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={S.btn("primary")} onClick={() => runWorkerExport("EXPORT_STOCK_INVENTORY_PDF", "current_stock_report.pdf")} disabled={isExporting}>
            📄 Export PDF
          </button>
          <button style={S.btn("teal")} onClick={() => runWorkerExport("EXPORT_STOCK_INVENTORY_EXCEL", "current_stock_report.xlsx")} disabled={isExporting}>
            📊 Export Excel
          </button>
          <button style={S.btn("outline")} onClick={handleExportCSV}>
            📥 Export CSV
          </button>
          <button style={S.btn("outline")} onClick={handlePrint}>
            🖨️ Print Report
          </button>
        </div>
      </div>

      {/* DATA TABLE CONTAINER */}
      <div className="printable-report-area" style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        {/* Table Print Header Details (Visible only during prints) */}
        <div className="c" style={{ display: "none", marginBottom: 15 }} id="print-header-details">
          <h2 style={{ fontSize: 16, fontWeight: 800, color: "#000", textAlign: "center" }}>
            {(storeDetails?.name || "JANAUSHADHI PHARMACY").toUpperCase()}
          </h2>
          <div style={{ textAlign: "center", fontSize: 10, color: "#555", marginTop: 4 }}>
            GSTIN: {storeDetails?.gstin || "—"} | DL: {storeDetails?.drugLicense || "—"}
          </div>
          <h3 style={{ fontSize: 12, fontWeight: 700, textAlign: "center", marginTop: 10 }}>
            CURRENT STOCK INVENTORY REPORT
          </h3>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, marginTop: 8, borderBottom: "1.5px solid #000", paddingBottom: 6 }}>
            <span>Date: {new Date().toLocaleString("en-IN")}</span>
            <span>Valuation: ₹{totalValuation.toFixed(2)} | Items: {filteredMeds.length}</span>
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
            <thead>
              <tr>
                <th style={S.th}>Drug Code</th>
                <th style={S.th}>Composition (Generic)</th>
                <th style={S.th}>Brand Name</th>
                <th style={S.th}>Form</th>
                <th style={{ ...S.th, textAlign: "right" }}>MRP</th>
                <th style={{ ...S.th, textAlign: "right" }}>Landed Pur. Price</th>
                <th style={{ ...S.th, textAlign: "right" }}>Selling Price</th>
                <th style={{ ...S.th, textAlign: "center" }}>GST %</th>
                <th style={{ ...S.th, textAlign: "center" }}>H1?</th>
                <th style={{ ...S.th, textAlign: "center" }}>Stock Qty</th>
                <th style={{ ...S.th, textAlign: "right" }}>Valuation (Landed)</th>
                <th style={S.th}>Active Batches</th>
              </tr>
            </thead>
            <tbody>
              {filteredMeds.length === 0 ? (
                <tr>
                  <td colSpan={12} style={{ ...S.td, textAlign: "center", padding: "32px 0", color: C.text3, fontStyle: "italic" }}>
                    No medicines match the specified search and filter criteria.
                  </td>
                </tr>
              ) : (
                filteredMeds.map((med) => {
                  const valuation = (med.stockQty || 0) * (med.purchasePrice || 0);
                  const isLow = (med.stockQty || 0) > 0 && (med.stockQty || 0) <= (med.lowStockAlert || 20);
                  const isOut = (med.stockQty || 0) <= 0;
                  
                  return (
                    <tr key={med.id}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{med.drugCode || med.barcode || "—"}</td>
                      <td style={{ ...S.td, fontWeight: 600 }}>{med.genericName}</td>
                      <td style={S.td}>{med.brandName || "—"}</td>
                      <td style={S.td}>{med.form || "—"}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{(med.mrp || 0).toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{(med.purchasePrice || 0).toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{(med.sellingPrice || 0).toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{med.gstRate || 0}%</td>
                      <td style={{ ...S.td, textAlign: "center" }}>
                        {med.isH1Drug ? (
                          <span style={{ fontSize: 9, fontWeight: 800, color: C.red, background: "#FFF5F5", border: `1px solid ${C.red}`, borderRadius: 4, padding: "2px 4px" }}>
                            H1
                          </span>
                        ) : "No"}
                      </td>
                      <td style={{ 
                        ...S.td, 
                        textAlign: "center", 
                        fontWeight: 700, 
                        color: isOut ? C.red : isLow ? C.amber : C.green 
                      }}>
                        {med.stockQty || 0}
                      </td>
                      <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.green }}>
                        ₹{valuation.toFixed(2)}
                      </td>
                      <td style={{ ...S.td, fontSize: 11, fontFamily: "monospace" }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          {(med.batches || []).map((b: any, bi: number) => (
                            <span key={bi} style={{ color: C.text2 }}>
                              <strong>{b.batchNumber}</strong> ({b.quantity}) · Exp: {b.expiryDate}
                            </span>
                          ))}
                          {(med.batches || []).length === 0 && <span style={{ color: C.text3 }}>—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Web Worker Export Loading Overlay */}
      {isExporting && (
        <div className="no-print" style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.2)", backdropFilter: "blur(2px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 10000
        }}>
          <div style={{
            background: "#fff", border: `2px solid ${C.teal}`, borderRadius: 12,
            padding: "20px 30px", boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 12
          }}>
            <div style={{
              width: 24, height: 24, borderRadius: "50%",
              border: `3px solid ${C.teal}`, borderTopColor: "transparent",
              animation: "spin 1s linear infinite"
            }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>
              Web Worker compiling stock inventory worksheet... Please wait.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
