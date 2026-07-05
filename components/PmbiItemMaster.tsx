"use client";

import React, { useState, useEffect, useRef } from "react";
import { collection, doc, runTransaction, serverTimestamp, deleteDoc } from "firebase/firestore";

interface PmbiItem {
  id: string;
  drugCode: string;
  genericName: string;
  unitSize: string;
  mrp: number;
  groupName: string;
}

interface PmbiItemMasterProps {
  db: any;
  storeId: string;
  storeCode: string;
  user: any;
  pmbiItems: PmbiItem[];
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
    background: t === "primary" ? C.navy : t === "teal" ? C.teal : t === "green" ? C.green : t === "red" ? C.red : "#fff",
    color: t === "outline" ? C.text2 : "#fff",
    borderStyle: t === "outline" ? "solid" : "none",
    borderWidth: t === "outline" ? "1.5px" : "0px",
    borderColor: t === "outline" ? C.border2 : "transparent"
  } as React.CSSProperties),
  th: { padding: "12px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap", background: "#F8FAFC" } as React.CSSProperties,
  td: { padding: "12px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.text2 } as React.CSSProperties,
};

export default function PmbiItemMaster({ db, storeId, storeCode, user, pmbiItems }: PmbiItemMasterProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 20;

  // Import Panel States
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState("");
  const [parsedItems, setParsedItems] = useState<any[]>([]);
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<any[][]>([]);
  const [mapping, setMapping] = useState({
    drugCode: -1,
    genericName: -1,
    unitSize: -1,
    mrp: -1,
    groupName: -1
  });

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filter items based on search query
  const filteredItems = pmbiItems.filter(item => {
    const q = searchQuery.toLowerCase();
    return (
      (item.drugCode || "").toLowerCase().includes(q) ||
      (item.genericName || "").toLowerCase().includes(q) ||
      (item.groupName || "").toLowerCase().includes(q)
    );
  });

  // Pagination calculations
  const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentItems = filteredItems.slice(indexOfFirstItem, indexOfLastItem);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  // Load xlsx dynamically and parse CSV/Excel
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelFile(file);
    setImportStatus("Parsing spreadsheet file...");
    setImporting(true);

    try {
      const XLSX = await import("xlsx");
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const data = evt.target?.result;
          const workbook = XLSX.read(data, { type: "binary" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const json = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as any[][];

          if (!json || json.length === 0) {
            throw new Error("File is empty.");
          }

          // Locate header row containing standard PMBI catalog headers
          let headerIdx = -1;
          for (let i = 0; i < json.length; i++) {
            const hasKeywords = json[i].some(cell => {
              const s = String(cell || "").toLowerCase();
              return s.includes("code") || s.includes("generic") || s.includes("mrp") || s.includes("group");
            });
            if (hasKeywords) {
              headerIdx = i;
              break;
            }
          }

          if (headerIdx === -1) {
            headerIdx = 0; // fallback to first row
          }

          const headers = json[headerIdx].map(h => String(h || "").trim().toLowerCase());
          const rows = json.slice(headerIdx + 1);

          setRawHeaders(json[headerIdx].map(h => String(h || "").trim()));
          setRawRows(rows);

          // Auto-mapping columns
          const autoMap = {
            drugCode: headers.findIndex(h => h.includes("code") || h.includes("drug")),
            genericName: headers.findIndex(h => h.includes("generic") || h.includes("name") || h.includes("product") || h.includes("description")),
            unitSize: headers.findIndex(h => h.includes("unit") || h.includes("size") || h.includes("pack")),
            mrp: headers.findIndex(h => h.includes("mrp") || h.includes("price") || h.includes("rate")),
            groupName: headers.findIndex(h => h.includes("group") || h.includes("category"))
          };

          setMapping(autoMap);
          setImportStatus("Auto-mapped headers. Please verify and ingest.");
        } catch (err: any) {
          alert("Error parsing file: " + err.message);
        } finally {
          setImporting(false);
        }
      };
      reader.readAsBinaryString(file);
    } catch (err: any) {
      alert("Failed loading XLSX compiler sub-library: " + err.message);
      setImporting(false);
    }
  };

  // Re-map rows dynamically when mapping changes
  useEffect(() => {
    if (rawRows.length === 0) return;
    const resolved = rawRows.map((row, ri) => {
      const dCode = mapping.drugCode !== -1 ? String(row[mapping.drugCode] || "").trim() : "";
      const gName = mapping.genericName !== -1 ? String(row[mapping.genericName] || "").trim() : "";
      const uSize = mapping.unitSize !== -1 ? String(row[mapping.unitSize] || "").trim() : "10's";
      const rawMrp = mapping.mrp !== -1 ? parseFloat(String(row[mapping.mrp])) : 0;
      const gNameGroup = mapping.groupName !== -1 ? String(row[mapping.groupName] || "").trim() : "General";

      return {
        srNo: ri + 1,
        drugCode: dCode,
        genericName: gName,
        unitSize: uSize,
        mrp: isNaN(rawMrp) ? 0 : rawMrp,
        groupName: gNameGroup,
        valid: !!dCode && !!gName
      };
    });
    setParsedItems(resolved.filter(i => i.drugCode || i.genericName));
  }, [mapping, rawRows]);

  // Bulk chunked database writes
  const handleIngestCatalog = async () => {
    if (parsedItems.length === 0) return;
    if (!storeId) { alert("Error: No store linked to user."); return; }
    if (!window.confirm(`Are you sure you want to import ${parsedItems.length} PMBI master drugs into your catalog?`)) return;

    setImporting(true);
    setImportProgress(0);
    setImportStatus("Initializing batch transactions...");

    const itemsToSave = parsedItems.filter(i => i.valid);
    const chunkSize = 250;
    let successCount = 0;

    try {
      for (let i = 0; i < itemsToSave.length; i += chunkSize) {
        const chunk = itemsToSave.slice(i, i + chunkSize);
        setImportStatus(`Ingesting items ${i + 1} to ${Math.min(i + chunkSize, itemsToSave.length)}...`);

        await runTransaction(db, async (transaction) => {
          for (const item of chunk) {
            const medColRef = collection(db, "pmbi_items");
            const qCode = item.drugCode.toUpperCase();
            
            // Generate deterministic ID based on store + drugCode to allow easy updates/deduplication
            const docId = `${storeId}_${qCode}`;
            const docRef = doc(db, "pmbi_items", docId);
            
            transaction.set(docRef, {
              storeId,
              storeCode,
              drugCode: qCode,
              genericName: item.genericName.trim(),
              unitSize: item.unitSize.trim(),
              mrp: item.mrp,
              groupName: item.groupName.trim(),
              category: "PMBI",
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            });
          }
        });

        successCount += chunk.length;
        setImportProgress(Math.round((successCount / itemsToSave.length) * 100));
      }

      alert(`✓ Success! ${successCount} PMBI medicines successfully cataloged in Item Master.`);
      // Reset states
      setShowImportPanel(false);
      setExcelFile(null);
      setParsedItems([]);
      setRawRows([]);
      setRawHeaders([]);
    } catch (err: any) {
      console.error(err);
      alert("Error ingesting catalog: " + err.message);
    } finally {
      setImporting(false);
    }
  };

  // Delete all catalog entries for reset
  const handleClearCatalog = async () => {
    if (pmbiItems.length === 0) return;
    if (!window.confirm("⚠️ WARNING: This will permanently wipe all PMBI Item Master catalog definitions from your store! This does NOT delete your active inventory. Proceed?")) return;

    setImporting(true);
    setImportStatus("Wiping Item Master entries...");
    try {
      for (const item of pmbiItems) {
        await deleteDoc(doc(db, "pmbi_items", item.id));
      }
      alert("✓ PMBI Item Master catalog wiped successfully.");
    } catch (e: any) {
      alert("Failed wiping catalog: " + e.message);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div style={{ padding: "0 4px" }}>
      {/* Dossier Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, color: C.navy, margin: 0 }}>📋 PMBI Item Master Catalog</h2>
          <p style={{ fontSize: 12, color: C.text3, margin: "2px 0 0 0" }}>
            Baseline catalog database containing <strong>{pmbiItems.length} drugs</strong>. Matches code and compositions during purchase imports.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {pmbiItems.length > 0 && (
            <button onClick={handleClearCatalog} style={S.btn("red")} disabled={importing}>
              🗑️ Clear Catalog
            </button>
          )}
          <button onClick={() => setShowImportPanel(prev => !prev)} style={S.btn("primary")}>
            {showImportPanel ? "Close Importer" : "📥 Import PMBI Catalog (Excel/CSV)"}
          </button>
        </div>
      </div>

      {/* CSV/Excel Importer Panel */}
      {showImportPanel && (
        <div style={S.card}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.navy, textTransform: "uppercase", marginBottom: 14 }}>
            📥 Excel / CSV Master Product List Ingestor
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Drag & Drop Area */}
            <div style={{
              border: `2px dashed ${C.border2}`, borderRadius: 10, padding: "26px",
              textAlign: "center", background: "#F8FAFC", cursor: "pointer"
            }} onClick={() => fileInputRef.current?.click()}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>
                {excelFile ? excelFile.name : "Select or drag & drop CSV or Excel catalog file"}
              </div>
              <span style={{ fontSize: 11, color: C.text3 }}>Accepts .xlsx, .xls, or .csv catalogs</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
            </div>

            {/* Importer Loader Status */}
            {importing && (
              <div style={{ padding: 12, background: "#EBF4FF", borderRadius: 8, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 6 }}>{importStatus}</div>
                {importProgress > 0 && (
                  <div style={{ height: 6, background: "#E2E8F0", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${importProgress}%`, background: C.blue, transition: "width 0.2s" }} />
                  </div>
                )}
              </div>
            )}

            {/* Column Mapping Configuration */}
            {rawHeaders.length > 0 && !importing && (
              <div style={{ padding: 16, background: "#F8FAFC", borderRadius: 8, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.navy, marginBottom: 12, textTransform: "uppercase" }}>
                  ⚙️ Document Header Field Mapping
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                  {[
                    { key: "drugCode", label: "Drug Code *" },
                    { key: "genericName", label: "Generic Composition *" },
                    { key: "unitSize", label: "Unit Size (Pack)" },
                    { key: "mrp", label: "Baseline Printed MRP *" },
                    { key: "groupName", label: "Group/Therapeutic Area" }
                  ].map(field => (
                    <div key={field.key}>
                      <label style={{ ...S.label, fontSize: 10 }}>{field.label}</label>
                      <select
                        style={S.input}
                        value={mapping[field.key as keyof typeof mapping]}
                        onChange={e => setMapping(prev => ({ ...prev, [field.key]: parseInt(e.target.value) }))}
                      >
                        <option value="-1">-- Unmapped --</option>
                        {rawHeaders.map((rh, rhi) => (
                          <option key={rh} value={rhi}>{rh}</option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>

                {/* Import Action */}
                {parsedItems.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 18, borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
                    <span style={{ fontSize: 12, color: C.text2 }}>
                      Mapped Rows: <strong>{parsedItems.filter(i => i.valid).length} valid</strong> / {parsedItems.length} total rows
                    </span>
                    <button
                      onClick={handleIngestCatalog}
                      style={S.btn("green")}
                      disabled={parsedItems.filter(i => i.valid).length === 0}
                    >
                      🚀 Ingest to PMBI Item Master
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Catalog View Grid */}
      <div style={S.card}>
        {/* Search controls */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, gap: 16 }}>
          <div style={{ width: "100%", maxWidth: 350 }}>
            <input
              style={S.input}
              placeholder="Search by code, generic name, or group..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <span style={{ fontSize: 12, color: C.text3 }}>
            Showing {indexOfFirstItem + 1} - {Math.min(indexOfLastItem, filteredItems.length)} of {filteredItems.length} drugs
          </span>
        </div>

        {/* Catalog Table */}
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
            <thead>
              <tr style={{ background: "#F8FAFC" }}>
                <th style={{ ...S.th, width: "60px", textAlign: "center" }}>Sr No.</th>
                <th style={{ ...S.th, width: "110px" }}>Drug Code</th>
                <th style={S.th}>Generic Composition</th>
                <th style={{ ...S.th, width: "100px", textAlign: "center" }}>Unit Size</th>
                <th style={{ ...S.th, width: "120px", textAlign: "right" }}>Printed MRP</th>
                <th style={S.th}>Group Name / Therapeutic Area</th>
              </tr>
            </thead>
            <tbody>
              {currentItems.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ ...S.td, padding: 32, textAlign: "center", color: C.text3, fontStyle: "italic" }}>
                    {pmbiItems.length === 0 ? "PMBI Item Master is empty. Import the catalog above!" : "No results match your search."}
                  </td>
                </tr>
              ) : (
                currentItems.map((item, idx) => (
                  <tr key={item.id} onMouseEnter={e => e.currentTarget.style.background = "#F8FAFC"} onMouseLeave={e => e.currentTarget.style.background = ""}>
                    <td style={{ ...S.td, textAlign: "center", color: C.text3 }}>{indexOfFirstItem + idx + 1}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: C.navy, fontFamily: "monospace" }}>{item.drugCode}</td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{item.genericName}</td>
                    <td style={{ ...S.td, textAlign: "center", color: C.text3 }}>{item.unitSize || "10's"}</td>
                    <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.blue }}>₹{(item.mrp || 0).toFixed(2)}</td>
                    <td style={S.td}>
                      <span style={{ fontSize: 11, background: "#E2E8F0", padding: "2px 8px", borderRadius: 4, color: C.text2 }}>
                        {item.groupName || "General"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 14, alignItems: "center" }}>
            <button
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              style={{ ...S.btn("outline"), padding: "6px 12px", fontSize: 11 }}
            >
              Previous
            </button>
            <span style={{ fontSize: 12, color: C.text2, margin: "0 6px" }}>
              Page <strong>{currentPage}</strong> of {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              style={{ ...S.btn("outline"), padding: "6px 12px", fontSize: 11 }}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
