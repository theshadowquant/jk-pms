"use client";

import React, { useState, useEffect } from "react";
import { collection, doc, runTransaction, serverTimestamp } from "firebase/firestore";

interface PmbiOpeningStockProps {
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
    background: t === "primary" ? C.navy : t === "teal" ? C.teal : t === "green" ? C.green : "#fff",
    color: t === "outline" ? C.text2 : "#fff",
    borderStyle: t === "outline" ? "solid" : "none",
    borderWidth: t === "outline" ? "1.5px" : "0px",
    borderColor: t === "outline" ? C.border2 : "transparent"
  } as React.CSSProperties),
  th: { padding: "12px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap", background: "#F8FAFC" } as React.CSSProperties,
  td: { padding: "12px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.text2 } as React.CSSProperties,
};

export default function PmbiOpeningStock({ db, storeId, storeCode, user, medicines }: PmbiOpeningStockProps) {
  // Opening Stock Fields
  const [drugCode, setDrugCode] = useState("");
  const [drugName, setDrugName] = useState("");
  const [companyName] = useState("PMBI");
  const [batchNumber, setBatchNumber] = useState("");
  const [manufacturingDate, setManufacturingDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [mrp, setMrp] = useState("");
  const [purchasePrice, setPurchasePrice] = useState(""); // Needed to establish landing cost for financial tracking
  const [sellingPrice, setSellingPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [gstRate, setGstRate] = useState("12");
  const [isH1Drug, setIsH1Drug] = useState(false);

  const [drugSearchFocused, setDrugSearchFocused] = useState(false);
  const [drugResults, setDrugResults] = useState<any[]>([]);

  // Autocomplete search of catalog
  useEffect(() => {
    if (drugCode.length >= 2) {
      const results = medicines.filter((m: any) => 
        m.category === "PMBI" && 
        ((m.drugCode || "").toLowerCase().includes(drugCode.toLowerCase()) || 
         (m.genericName || "").toLowerCase().includes(drugCode.toLowerCase()))
      );
      setDrugResults(results.slice(0, 5));
    } else {
      setDrugResults([]);
    }
  }, [drugCode, medicines]);

  const handleSelectPmbiDrug = (med: any) => {
    setDrugCode(med.drugCode || "");
    setDrugName(med.genericName || "");
    setMrp(med.mrp ? String(med.mrp) : "");
    setPurchasePrice(med.purchasePrice ? String(med.purchasePrice) : "");
    setSellingPrice(med.sellingPrice ? String(med.sellingPrice) : "");
    setGstRate(med.gstRate ? String(med.gstRate) : "12");
    setIsH1Drug(med.isH1Drug || false);
    setDrugResults([]);
  };

  const handleSaveOpeningStock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!drugCode.trim()) { alert("Drug Code is mandatory."); return; }
    if (!drugName.trim()) { alert("Drug Name is mandatory."); return; }
    if (!batchNumber.trim()) { alert("Batch Number is mandatory."); return; }
    if (!manufacturingDate.trim()) { alert("Manufacturing Date is mandatory."); return; }
    if (!expiryDate.trim()) { alert("Expiry Date is mandatory."); return; }
    if (!mrp.trim() || +mrp <= 0) { alert("Please enter a valid MRP."); return; }
    if (!purchasePrice.trim() || +purchasePrice <= 0) { alert("Landed purchase price is mandatory to track gross margins."); return; }
    if (!quantity.trim() || +quantity <= 0) { alert("Please enter a valid quantity."); return; }
    if (!storeId) { alert("Error: No store linked to user."); return; }

    const qtyVal = parseInt(quantity) || 0;
    const mrpVal = parseFloat(mrp) || 0;
    const purchaseVal = parseFloat(purchasePrice) || 0;
    const sellVal = parseFloat(sellingPrice) || mrpVal;
    const gstRateVal = parseFloat(gstRate) || 12;

    try {
      await runTransaction(db, async (transaction) => {
        // Find existing medicine by drugCode
        const existingMed = medicines.find((m: any) => 
          m.category === "PMBI" && 
          m.drugCode?.toLowerCase() === drugCode.toLowerCase()
        );

        const newBatch = {
          batchNumber: batchNumber.toUpperCase().trim(),
          expiryDate: expiryDate.trim(),
          manufacturingDate: manufacturingDate.trim(),
          quantity: qtyVal,
          purchasePrice: purchaseVal,
          mrp: mrpVal,
          sellingPrice: sellVal,
          isOpeningStock: true,
          openingStockDate: new Date().toISOString().substring(0, 10)
        };

        if (existingMed) {
          const medRef = doc(db, "medicines", existingMed.id);
          const currentBatches = Array.isArray(existingMed.batches) ? existingMed.batches.map((b: any) => ({ ...b })) : [];
          const bIdx = currentBatches.findIndex((b: any) => b.batchNumber === newBatch.batchNumber);

          let prevQty = 0;
          if (bIdx >= 0) {
            prevQty = currentBatches[bIdx].quantity || 0;
            currentBatches[bIdx] = {
              ...currentBatches[bIdx],
              quantity: prevQty + qtyVal,
              purchasePrice: purchaseVal,
              mrp: mrpVal,
              sellingPrice: sellVal,
              manufacturingDate: manufacturingDate.trim(),
              expiryDate: expiryDate.trim()
            };
          } else {
            currentBatches.push(newBatch);
          }

          const totalStock = currentBatches.reduce((sum: number, b: any) => sum + (b.quantity || 0), 0);

          transaction.update(medRef, {
            mrp: mrpVal,
            sellingPrice: sellVal,
            purchasePrice: purchaseVal,
            expiryDate: expiryDate.trim(),
            stockQty: totalStock,
            batches: currentBatches,
            isH1Drug: isH1Drug || existingMed.isH1Drug || false,
            updatedAt: serverTimestamp()
          });

          // Write audit log
          const auditDoc = doc(collection(db, "inventory_audit_logs"));
          transaction.set(auditDoc, {
            storeId,
            medicineId: existingMed.id,
            genericName: drugName.trim(),
            brandName: drugName.trim(),
            batchNumber: newBatch.batchNumber,
            type: "OPENING_STOCK",
            actionSource: "PMBI_OPENING_STOCK",
            referenceId: "OPENING-STOCK-ENTRY",
            quantityChanged: qtyVal,
            previousQuantity: prevQty,
            newQuantity: prevQty + qtyVal,
            purchasePrice: purchaseVal,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });

        } else {
          // Create new PMBI medicine catalog record
          const medColRef = collection(db, "medicines");
          const newMedDoc = doc(medColRef);

          transaction.set(newMedDoc, {
            storeId,
            storeCode,
            category: "PMBI",
            drugCode: drugCode.toUpperCase().trim(),
            genericName: drugName.trim(),
            brandName: drugName.trim(),
            companyName: "PMBI",
            mrp: mrpVal,
            sellingPrice: sellVal,
            purchasePrice: purchaseVal,
            stockQty: qtyVal,
            lowStockAlert: 20,
            gstRate: gstRateVal,
            isH1Drug,
            batches: [newBatch],
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });

          // Write audit log
          const auditDoc = doc(collection(db, "inventory_audit_logs"));
          transaction.set(auditDoc, {
            storeId,
            medicineId: newMedDoc.id,
            genericName: drugName.trim(),
            brandName: drugName.trim(),
            batchNumber: newBatch.batchNumber,
            type: "OPENING_STOCK",
            actionSource: "PMBI_OPENING_STOCK",
            referenceId: "OPENING-STOCK-ENTRY",
            quantityChanged: qtyVal,
            previousQuantity: 0,
            newQuantity: qtyVal,
            purchasePrice: purchaseVal,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }
      });

      // Clear Form state
      setDrugCode("");
      setDrugName("");
      setBatchNumber("");
      setManufacturingDate("");
      setExpiryDate("");
      setMrp("");
      setPurchasePrice("");
      setSellingPrice("");
      setQuantity("");
      setGstRate("12");
      setIsH1Drug(false);
      alert("✓ PMBI Opening Stock registered successfully. Catalog and batch files initialized!");
    } catch (err: any) {
      console.error(err);
      alert("Error adding PMBI opening stock: " + err.message);
    }
  };

  // Get only PMBI medicines
  const pmbiMeds = medicines.filter((m: any) => m.category === "PMBI");

  return (
    <div>
      {/* HEADER BAR */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: C.navy, margin: 0 }}>➕ PMBI Opening Stock Entry</h2>
          <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>Directly upload initial inventory levels for Jan Aushadhi medicines. Safe Mode isolated ingestion.</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
        {/* OPENING STOCK INPUT FORM */}
        <div style={S.card}>
          <style>{`
            .notice-banner {
              background: #FFF8E7;
              border: 1.5px solid #FEF3DC;
              border-radius: 8px;
              padding: 10px 14px;
              font-size: 12px;
              color: ${C.amber};
              margin-bottom: 16px;
              line-height: 1.4;
            }
          `}</style>
          <div className="notice-banner">
            📌 <strong>Onboarding Safe Mode:</strong> Opening stock directly initializes inventory levels. This entry is isolated and will <u>not</u> generate GST liability documents or write to supplier balance sheet ledgers.
          </div>

          <form onSubmit={handleSaveOpeningStock} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div style={{ position: "relative" }}>
              <label style={S.label}>Drug Code *</label>
              <input
                style={S.input}
                value={drugCode}
                onChange={e => setDrugCode(e.target.value)}
                onFocus={() => setDrugSearchFocused(true)}
                onBlur={() => setTimeout(() => setDrugSearchFocused(false), 250)}
                placeholder="Lookup or type code..."
                autoComplete="off"
              />
              {drugSearchFocused && drugResults.length > 0 && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, right: 0, background: "#fff",
                  border: `1.5px solid ${C.teal}`, borderRadius: 8, maxHeight: 180,
                  overflowY: "auto", zIndex: 100, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", marginTop: 4
                }}>
                  {drugResults.map(m => (
                    <div
                      key={m.id}
                      style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}
                      onMouseDown={() => handleSelectPmbiDrug(m)}
                    >
                      <strong>{m.drugCode}</strong> - {m.genericName}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label style={S.label}>Drug Name *</label>
              <input style={S.input} value={drugName} onChange={e => setDrugName(e.target.value)} placeholder="e.g. Paracetamol 500mg" />
            </div>

            <div>
              <label style={S.label}>Company Name</label>
              <input style={{ ...S.input, background: "#F1F5F9", cursor: "not-allowed" }} value={companyName} readOnly />
            </div>

            <div>
              <label style={S.label}>Batch Number *</label>
              <input style={S.input} value={batchNumber} onChange={e => setBatchNumber(e.target.value)} placeholder="e.g. OS-B100" />
            </div>

            <div>
              <label style={S.label}>Mfg Date (YYYY-MM) *</label>
              <input style={S.input} value={manufacturingDate} onChange={e => setManufacturingDate(e.target.value)} placeholder="e.g. 2026-02" />
            </div>

            <div>
              <label style={S.label}>Expiry Date (YYYY-MM) *</label>
              <input style={S.input} value={expiryDate} onChange={e => setExpiryDate(e.target.value)} placeholder="e.g. 2029-02" />
            </div>

            <div>
              <label style={S.label}>MRP *</label>
              <input type="number" step="0.01" style={S.input} value={mrp} onChange={e => setMrp(e.target.value)} placeholder="0.00" />
            </div>

            <div>
              <label style={S.label}>Purchase Price *</label>
              <input type="number" step="0.01" style={S.input} value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} placeholder="0.00" />
            </div>

            <div>
              <label style={S.label}>Selling Price</label>
              <input type="number" step="0.01" style={S.input} value={sellingPrice} onChange={e => setSellingPrice(e.target.value)} placeholder="Defaults to MRP" />
            </div>

            <div>
              <label style={S.label}>Quantity *</label>
              <input type="number" style={S.input} value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="e.g. 100" />
            </div>

            <div>
              <label style={S.label}>GST Rate %</label>
              <select style={S.input} value={gstRate} onChange={e => setGstRate(e.target.value)}>
                <option value="0">0% GST</option>
                <option value="5">5% GST</option>
                <option value="12">12% GST</option>
                <option value="18">18% GST</option>
                <option value="28">28% GST</option>
              </select>
            </div>

            <div style={{ display: "flex", alignItems: "center", height: "100%", paddingTop: 20 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: C.red }}>
                <input
                  type="checkbox"
                  checked={isH1Drug}
                  onChange={e => setIsH1Drug(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                ⚠️ SCHEDULE H1 DRUG
              </label>
            </div>

            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button type="submit" style={S.btn("teal")}>
                ＋ Save PMBI Opening Stock Batch
              </button>
            </div>
          </form>
        </div>

        {/* PMBI MEDICINE LIST */}
        <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
          <div style={{ background: C.navy, color: "#fff", padding: "12px 16px", fontSize: 13, fontWeight: 800, textTransform: "uppercase" }}>
            💊 Existing PMBI Opening Stock Records
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={S.th}>Drug Code</th>
                  <th style={S.th}>Drug Name</th>
                  <th style={S.th}>Mfg Company</th>
                  <th style={{ ...S.th, textAlign: "right" }}>MRP</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Purchase Price</th>
                  <th style={{ ...S.th, textAlign: "center" }}>GST Rate</th>
                  <th style={{ ...S.th, textAlign: "center" }}>Current Stock</th>
                  <th style={S.th}>Compliance</th>
                  <th style={S.th}>Active Batches</th>
                </tr>
              </thead>
              <tbody>
                {pmbiMeds.length === 0 ? (
                  <tr>
                    <td colSpan={9} style={{ ...S.td, textAlign: "center", padding: "30px 0", color: C.text3, fontStyle: "italic" }}>
                      No PMBI opening stocks registered yet. Enter the drug details above to initialize inventory.
                    </td>
                  </tr>
                ) : (
                  pmbiMeds.map((med) => (
                    <tr key={med.id}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{med.drugCode}</td>
                      <td style={{ ...S.td, fontWeight: 600 }}>{med.genericName}</td>
                      <td style={S.td}>{med.companyName || "PMBI"}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{(med.mrp || 0).toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{(med.purchasePrice || 0).toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{med.gstRate || 12}%</td>
                      <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: med.stockQty <= med.lowStockAlert ? C.red : C.green }}>
                        {med.stockQty}
                      </td>
                      <td style={S.td}>
                        {med.isH1Drug && (
                          <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: C.red, borderRadius: 4, padding: "2px 6px" }}>
                            SCHEDULE H1
                          </span>
                        )}
                      </td>
                      <td style={S.td}>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          {(med.batches || []).map((b: any, bi: number) => (
                            <span key={bi} style={{ fontSize: 10, fontFamily: "monospace", color: C.text2 }}>
                              Batch: <strong>{b.batchNumber}</strong> (Qty: {b.quantity}) · Exp: {b.expiryDate}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
