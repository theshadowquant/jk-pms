"use client";

import React, { useState, useEffect, useRef } from "react";
import { collection, addDoc, doc, updateDoc, runTransaction, serverTimestamp } from "firebase/firestore";

interface PmbiPurchaseEntryProps {
  db: any;
  storeId: string;
  storeCode: string;
  user: any;
  medicines: any[];
  suppliers: any[];
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

export default function PmbiPurchaseEntry({ db, storeId, storeCode, user, medicines, suppliers }: PmbiPurchaseEntryProps) {
  // Invoice Header
  const [supplierName, setSupplierName] = useState("");
  const [supplierGstin, setSupplierGstin] = useState("");
  const [supplierPhone, setSupplierPhone] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("Unpaid");
  const [gstType, setGstType] = useState("Local State"); // "Local State" | "Interstate"
  
  const [supplierSearchFocused, setSupplierSearchFocused] = useState(false);

  // Active items in current invoice
  const [invoiceItems, setInvoiceItems] = useState<any[]>([]);

  // Item Form Entry
  const [drugCode, setDrugCode] = useState("");
  const [drugName, setDrugName] = useState("");
  const [companyName, setCompanyName] = useState("PMBI");
  const [batchNumber, setBatchNumber] = useState("");
  const [manufacturingDate, setManufacturingDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [mrp, setMrp] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [quantity, setQuantity] = useState("");
  const [freeQuantity, setFreeQuantity] = useState("0");
  const [gstRate, setGstRate] = useState("12");
  const [discount, setDiscount] = useState("0");
  const [isH1Drug, setIsH1Drug] = useState(false);

  const [drugSearchFocused, setDrugSearchFocused] = useState(false);
  const [drugResults, setDrugResults] = useState<any[]>([]);

  // Auto-fill from selected PMBI medicine
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
    setCompanyName(med.companyName || "PMBI");
    setMrp(med.mrp ? String(med.mrp) : "");
    setPurchasePrice(med.purchasePrice ? String(med.purchasePrice) : "");
    setSellingPrice(med.sellingPrice ? String(med.sellingPrice) : "");
    setGstRate(med.gstRate ? String(med.gstRate) : "12");
    setIsH1Drug(med.isH1Drug || false);
    setDrugResults([]);
  };

  const handleAddItem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!drugCode.trim()) { alert("Drug Code is mandatory."); return; }
    if (!drugName.trim()) { alert("Drug Name is mandatory."); return; }
    if (!batchNumber.trim()) { alert("Batch Number is mandatory."); return; }
    if (!manufacturingDate.trim()) { alert("Manufacturing Date is mandatory."); return; }
    if (!expiryDate.trim()) { alert("Expiry Date is mandatory."); return; }
    if (!mrp.trim() || +mrp <= 0) { alert("Please enter a valid MRP."); return; }
    if (!purchasePrice.trim() || +purchasePrice < 0) { alert("Please enter a valid Purchase Rate."); return; }
    if (!quantity.trim() || +quantity <= 0) { alert("Please enter a valid quantity."); return; }

    const qtyVal = +quantity;
    const freeQtyVal = +freeQuantity || 0;
    const rateVal = +purchasePrice;
    const mrpVal = +mrp;
    const sellVal = +sellingPrice || mrpVal;
    const discVal = +discount || 0;
    const gstRateVal = +gstRate || 0;

    // Calculations
    const grossAmount = rateVal * qtyVal;
    const discountAmt = grossAmount * (discVal / 100);
    const taxableAmount = grossAmount - discountAmt;
    const totalGst = taxableAmount * (gstRateVal / 100);

    const cgst = gstType === "Local State" ? totalGst / 2 : 0;
    const sgst = gstType === "Local State" ? totalGst / 2 : 0;
    const igst = gstType === "Interstate" ? totalGst : 0;

    const totalAmount = taxableAmount + totalGst;

    const newItem = {
      drugCode: drugCode.toUpperCase().trim(),
      genericName: drugName.trim(),
      brandName: drugName.trim(), // PMBI drugs generic name acts as brand/product name
      companyName: companyName.trim() || "PMBI",
      batchNumber: batchNumber.toUpperCase().trim(),
      manufacturingDate: manufacturingDate.trim(),
      expiryDate: expiryDate.trim(),
      mrp: mrpVal,
      purchasePrice: rateVal,
      sellingPrice: sellVal,
      quantity: qtyVal,
      freeQuantity: freeQtyVal,
      gstRate: gstRateVal,
      discount: discVal,
      taxableAmount,
      cgst,
      sgst,
      igst,
      totalAmount,
      isH1Drug
    };

    setInvoiceItems(prev => [...prev, newItem]);

    // Reset Item inputs
    setDrugCode("");
    setDrugName("");
    setCompanyName("PMBI");
    setBatchNumber("");
    setManufacturingDate("");
    setExpiryDate("");
    setMrp("");
    setPurchasePrice("");
    setSellingPrice("");
    setQuantity("");
    setFreeQuantity("0");
    setGstRate("12");
    setDiscount("0");
    setIsH1Drug(false);
  };

  const handleRemoveItem = (index: number) => {
    setInvoiceItems(prev => prev.filter((_, i) => i !== index));
  };

  const calculateTotals = () => {
    return invoiceItems.reduce((acc, item) => {
      acc.taxable += item.taxableAmount;
      acc.cgst += item.cgst;
      acc.sgst += item.sgst;
      acc.igst += item.igst;
      acc.grandTotal += item.totalAmount;
      acc.totalQty += (item.quantity + item.freeQuantity);
      return acc;
    }, { taxable: 0, cgst: 0, sgst: 0, igst: 0, grandTotal: 0, totalQty: 0 });
  };

  const totals = calculateTotals();

  const handleSavePmbiInvoice = async () => {
    if (!supplierName.trim()) { alert("Please enter or select a Supplier."); return; }
    if (!invoiceNumber.trim()) { alert("Please enter the Invoice Number."); return; }
    if (!invoiceDate.trim()) { alert("Please select the Invoice Date."); return; }
    if (invoiceItems.length === 0) { alert("Please add at least one medicine item."); return; }
    if (!storeId) { alert("Error: No store linked to user."); return; }

    try {
      await runTransaction(db, async (transaction) => {
        // 1. Resolve Supplier & Update Balance
        let distId = "";
        const existingDist = suppliers.find((s: any) => s.name?.toLowerCase() === supplierName.toLowerCase());
        if (existingDist) {
          distId = existingDist.id;
          transaction.update(doc(db, "suppliers", existingDist.id), {
            totalPurchases: (existingDist.totalPurchases || 0) + totals.grandTotal,
            outstanding: paymentStatus === "Unpaid" ? (existingDist.outstanding || 0) + totals.grandTotal : (existingDist.outstanding || 0)
          });
        } else {
          const supplierColRef = collection(db, "suppliers");
          const newSupDoc = doc(supplierColRef);
          distId = newSupDoc.id;
          transaction.set(newSupDoc, {
            storeId,
            storeCode,
            name: supplierName.trim(),
            gstin: supplierGstin.toUpperCase().trim(),
            phone: supplierPhone.trim(),
            totalPurchases: totals.grandTotal,
            outstanding: paymentStatus === "Unpaid" ? totals.grandTotal : 0,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }

        // 2. Save PMBI Purchase Invoice Document
        const purchaseColRef = collection(db, "purchases");
        const newPurchDoc = doc(purchaseColRef);
        transaction.set(newPurchDoc, {
          storeId,
          storeCode,
          supplierName: supplierName.trim(),
          supplierGstin: supplierGstin.toUpperCase().trim(),
          supplierPhone: supplierPhone.trim(),
          invoiceNumber: invoiceNumber.trim(),
          invoiceDate: invoiceDate.trim(),
          paymentStatus,
          gstType,
          purchaseType: "PMBI",
          items: invoiceItems,
          distributorId: distId,
          totalAmount: totals.grandTotal,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });

        // 3. Update inventory & batches for each medicine item
        for (const item of invoiceItems) {
          const existingMed = medicines.find((m: any) => 
            m.category === "PMBI" && 
            m.drugCode?.toLowerCase() === item.drugCode.toLowerCase()
          );

          const packQty = item.quantity + item.freeQuantity;
          const incomingBatch = {
            batchNumber: item.batchNumber,
            expiryDate: item.expiryDate,
            manufacturingDate: item.manufacturingDate,
            quantity: packQty,
            purchasePrice: item.purchasePrice,
            mrp: item.mrp,
            sellingPrice: item.sellingPrice,
            discount: item.discount,
            isPmbi: true
          };

          if (existingMed) {
            const medRef = doc(db, "medicines", existingMed.id);
            const currentBatches = Array.isArray(existingMed.batches) ? existingMed.batches.map((b: any) => ({ ...b })) : [];
            const bIdx = currentBatches.findIndex((b: any) => b.batchNumber === incomingBatch.batchNumber);

            let prevQty = 0;
            if (bIdx >= 0) {
              prevQty = currentBatches[bIdx].quantity || 0;
              currentBatches[bIdx] = {
                ...currentBatches[bIdx],
                quantity: prevQty + packQty,
                purchasePrice: item.purchasePrice,
                mrp: item.mrp,
                sellingPrice: item.sellingPrice,
                manufacturingDate: item.manufacturingDate,
                expiryDate: item.expiryDate
              };
            } else {
              currentBatches.push(incomingBatch);
            }

            const totalStock = currentBatches.reduce((sum: number, b: any) => sum + (b.quantity || 0), 0);

            transaction.update(medRef, {
              mrp: item.mrp,
              sellingPrice: item.sellingPrice,
              purchasePrice: item.purchasePrice,
              expiryDate: item.expiryDate,
              stockQty: totalStock,
              batches: currentBatches,
              lastDistributorId: distId,
              lastDistributorName: supplierName.trim(),
              lastPurchasePrice: item.purchasePrice,
              isH1Drug: item.isH1Drug || existingMed.isH1Drug || false,
              updatedAt: serverTimestamp()
            });

            // Write audit log
            const auditDoc = doc(collection(db, "inventory_audit_logs"));
            transaction.set(auditDoc, {
              storeId,
              medicineId: existingMed.id,
              genericName: item.genericName,
              brandName: item.genericName,
              batchNumber: item.batchNumber,
              type: "PURCHASE",
              actionSource: "PMBI_PURCHASE",
              referenceId: newPurchDoc.id,
              quantityChanged: packQty,
              previousQuantity: prevQty,
              newQuantity: prevQty + packQty,
              purchasePrice: item.purchasePrice,
              createdAt: serverTimestamp(),
              createdBy: user.uid
            });

          } else {
            // Create a new PMBI medicine catalog record
            const medColRef = collection(db, "medicines");
            const newMedDoc = doc(medColRef);

            transaction.set(newMedDoc, {
              storeId,
              storeCode,
              category: "PMBI",
              drugCode: item.drugCode,
              genericName: item.genericName,
              brandName: item.genericName,
              companyName: item.companyName,
              mrp: item.mrp,
              sellingPrice: item.sellingPrice,
              purchasePrice: item.purchasePrice,
              stockQty: packQty,
              lowStockAlert: 20,
              gstRate: item.gstRate,
              isH1Drug: item.isH1Drug,
              batches: [incomingBatch],
              lastDistributorId: distId,
              lastDistributorName: supplierName.trim(),
              lastPurchasePrice: item.purchasePrice,
              bestPurchasePrice: item.purchasePrice,
              createdAt: serverTimestamp(),
              createdBy: user.uid
            });

            // Write audit log
            const auditDoc = doc(collection(db, "inventory_audit_logs"));
            transaction.set(auditDoc, {
              storeId,
              medicineId: newMedDoc.id,
              genericName: item.genericName,
              brandName: item.genericName,
              batchNumber: item.batchNumber,
              type: "PURCHASE",
              actionSource: "PMBI_PURCHASE",
              referenceId: newPurchDoc.id,
              quantityChanged: packQty,
              previousQuantity: 0,
              newQuantity: packQty,
              purchasePrice: item.purchasePrice,
              createdAt: serverTimestamp(),
              createdBy: user.uid
            });
          }
        }
      });

      // Clear Form state
      setInvoiceItems([]);
      setSupplierName("");
      setSupplierGstin("");
      setSupplierPhone("");
      setInvoiceNumber("");
      setInvoiceDate("");
      setPaymentStatus("Unpaid");
      alert("✓ PMBI Purchase Inward entry registered successfully. Stock and supplier ledger updated!");
    } catch (e: any) {
      console.error(e);
      alert("Error saving PMBI Purchase invoice: " + e.message);
    }
  };

  return (
    <div>
      {/* HEADER BAR */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: C.navy, margin: 0 }}>📦 PMBI Purchase Invoice Inward</h2>
          <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>Dedicated entry register for Jan Aushadhi (PMBI) medicines. Fully compliant GST & inventory mappings.</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
        {/* INVOICE METADATA */}
        <div style={{ ...S.card, background: "#F8FAFC", border: `1.5px solid ${C.teal}` }}>
          <h3 style={{ fontSize: 13, fontWeight: 800, color: C.teal, margin: "0 0 12px 0", textTransform: "uppercase" }}>🧾 Invoice Header Details</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div style={{ position: "relative" }}>
              <label style={S.label}>Supplier Name *</label>
              <input
                style={S.input}
                value={supplierName}
                onChange={e => setSupplierName(e.target.value)}
                onFocus={() => setSupplierSearchFocused(true)}
                onBlur={() => setTimeout(() => setSupplierSearchFocused(false), 250)}
                placeholder="Type or select supplier..."
              />
              {supplierSearchFocused && (
                <div style={{
                  position: "absolute", top: "100%", left: 0, right: 0, background: "#fff",
                  border: `1.5px solid ${C.border2}`, borderRadius: 8, maxHeight: 160,
                  overflowY: "auto", zIndex: 100, boxShadow: "0 4px 12px rgba(0,0,0,0.1)", marginTop: 4
                }}>
                  {suppliers
                    .filter(s => s.name?.toLowerCase().includes(supplierName.toLowerCase()))
                    .map(s => (
                      <div
                        key={s.id}
                        style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}
                        onMouseDown={() => {
                          setSupplierName(s.name);
                          setSupplierGstin(s.gstin || "");
                          setSupplierPhone(s.phone || "");
                        }}
                      >
                        <strong>{s.name}</strong> <span style={{ color: C.text3, fontSize: 11 }}>(GSTIN: {s.gstin || "N/A"})</span>
                      </div>
                    ))}
                </div>
              )}
            </div>

            <div>
              <label style={S.label}>Supplier GSTIN</label>
              <input style={S.input} value={supplierGstin} onChange={e => setSupplierGstin(e.target.value)} placeholder="e.g. 29AAAAA1111A1Z1" />
            </div>

            <div>
              <label style={S.label}>Supplier Phone</label>
              <input style={S.input} value={supplierPhone} onChange={e => setSupplierPhone(e.target.value)} placeholder="e.g. 9876543210" />
            </div>

            <div>
              <label style={S.label}>Invoice Number *</label>
              <input style={S.input} value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} placeholder="e.g. PMBI/26/1029" />
            </div>

            <div>
              <label style={S.label}>Invoice Date *</label>
              <input type="date" style={S.input} value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
            </div>

            <div>
              <label style={S.label}>GST Type *</label>
              <select style={S.input} value={gstType} onChange={e => setGstType(e.target.value)}>
                <option value="Local State">Local SGST + CGST (Intrastate)</option>
                <option value="Interstate">IGST only (Interstate)</option>
              </select>
            </div>

            <div>
              <label style={S.label}>Payment Status *</label>
              <select style={S.input} value={paymentStatus} onChange={e => setPaymentStatus(e.target.value)}>
                <option value="Unpaid">Unpaid (Add to Supplier Balance)</option>
                <option value="Paid">Paid (Cash/Bank Outflow)</option>
              </select>
            </div>
          </div>
        </div>

        {/* ADD ITEM CONTAINER */}
        <div style={S.card}>
          <h3 style={{ fontSize: 13, fontWeight: 800, color: C.navy, margin: "0 0 12px 0", textTransform: "uppercase" }}>💊 Add Medicine Item</h3>
          <form onSubmit={handleAddItem} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <div style={{ position: "relative" }}>
              <label style={S.label}>Drug Code *</label>
              <input
                style={S.input}
                value={drugCode}
                onChange={e => setDrugCode(e.target.value)}
                onFocus={() => setDrugSearchFocused(true)}
                onBlur={() => setTimeout(() => setDrugSearchFocused(false), 250)}
                placeholder="Lookup or enter code..."
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
                      <strong>{m.drugCode}</strong> - {m.genericName} <span style={{ color: C.text3 }}>({m.strength})</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <label style={S.label}>Drug / Generic Name *</label>
              <input style={S.input} value={drugName} onChange={e => setDrugName(e.target.value)} placeholder="e.g. Paracetamol 500mg" />
            </div>

            <div>
              <label style={S.label}>Company Name</label>
              <input style={S.input} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Default: PMBI" />
            </div>

            <div>
              <label style={S.label}>Batch Number *</label>
              <input style={S.input} value={batchNumber} onChange={e => setBatchNumber(e.target.value)} placeholder="e.g. B-OS-200" />
            </div>

            <div>
              <label style={S.label}>Mfg Date (YYYY-MM) *</label>
              <input style={S.input} value={manufacturingDate} onChange={e => setManufacturingDate(e.target.value)} placeholder="e.g. 2026-01" />
            </div>

            <div>
              <label style={S.label}>Expiry Date (YYYY-MM) *</label>
              <input style={S.input} value={expiryDate} onChange={e => setExpiryDate(e.target.value)} placeholder="e.g. 2029-01" />
            </div>

            <div>
              <label style={S.label}>MRP *</label>
              <input type="number" step="0.01" style={S.input} value={mrp} onChange={e => setMrp(e.target.value)} placeholder="0.00" />
            </div>

            <div>
              <label style={S.label}>Purchase Rate *</label>
              <input type="number" step="0.01" style={S.input} value={purchasePrice} onChange={e => setPurchasePrice(e.target.value)} placeholder="0.00" />
            </div>

            <div>
              <label style={S.label}>Selling Rate</label>
              <input type="number" step="0.01" style={S.input} value={sellingPrice} onChange={e => setSellingPrice(e.target.value)} placeholder="Defaults to MRP" />
            </div>

            <div>
              <label style={S.label}>Quantity *</label>
              <input type="number" style={S.input} value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="e.g. 50" />
            </div>

            <div>
              <label style={S.label}>Free Quantity</label>
              <input type="number" style={S.input} value={freeQuantity} onChange={e => setFreeQuantity(e.target.value)} placeholder="e.g. 0" />
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

            <div>
              <label style={S.label}>Discount %</label>
              <input type="number" step="0.01" style={S.input} value={discount} onChange={e => setDiscount(e.target.value)} placeholder="0.00" />
            </div>

            <div style={{ display: "flex", alignItems: "center", height: "100%", paddingTop: 20 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12, fontWeight: 700, color: C.red }}>
                <input
                  type="checkbox"
                  checked={isH1Drug}
                  onChange={e => setIsH1Drug(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                ⚠️ SCHEDULE H1 COMPLIANCE
              </label>
            </div>

            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
              <button type="submit" style={S.btn("teal")}>
                ➕ Add Item to Invoice
              </button>
            </div>
          </form>
        </div>

        {/* INVOICE BILL ITEMS TABLE */}
        <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
          <div style={{ background: C.navy, color: "#fff", padding: "12px 16px", fontSize: 13, fontWeight: 800, textTransform: "uppercase" }}>
            📋 Invoice Line Items
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
              <thead>
                <tr>
                  <th style={S.th}>Code</th>
                  <th style={S.th}>Drug Name</th>
                  <th style={S.th}>Batch</th>
                  <th style={S.th}>Expiry</th>
                  <th style={{ ...S.th, textAlign: "right" }}>MRP</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Rate</th>
                  <th style={{ ...S.th, textAlign: "center" }}>Qty + Free</th>
                  <th style={{ ...S.th, textAlign: "center" }}>GST%</th>
                  <th style={{ ...S.th, textAlign: "center" }}>Disc %</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Taxable Amt</th>
                  <th style={{ ...S.th, textAlign: "right" }}>Total (₹)</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {invoiceItems.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ ...S.td, textAlign: "center", padding: "30px 0", color: C.text3, fontStyle: "italic" }}>
                      No items added yet. Fill out the form above to add items to this PMBI purchase invoice.
                    </td>
                  </tr>
                ) : (
                  invoiceItems.map((item, idx) => (
                    <tr key={idx} style={{ background: item.isH1Drug ? "#FFF5F5" : "" }}>
                      <td style={{ ...S.td, fontWeight: 700 }}>{item.drugCode}</td>
                      <td style={S.td}>
                        <div style={{ fontWeight: 600 }}>{item.genericName}</div>
                        <div style={{ fontSize: 9.5, color: C.text3 }}>Mfg: {item.companyName}</div>
                      </td>
                      <td style={{ ...S.td, fontFamily: "monospace", fontWeight: 700 }}>{item.batchNumber}</td>
                      <td style={S.td}>{item.expiryDate}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{item.mrp.toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{item.purchasePrice.toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "center", fontWeight: 600 }}>
                        {item.quantity} <span style={{ color: C.teal, fontSize: 11 }}>+{item.freeQuantity}F</span>
                      </td>
                      <td style={{ ...S.td, textAlign: "center" }}>{item.gstRate}%</td>
                      <td style={{ ...S.td, textAlign: "center" }}>{item.discount}%</td>
                      <td style={{ ...S.td, textAlign: "right" }}>₹{item.taxableAmount.toFixed(2)}</td>
                      <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.green }}>₹{item.totalAmount.toFixed(2)}</td>
                      <td style={{ ...S.td, width: 60 }}>
                        <button type="button" onClick={() => handleRemoveItem(idx)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontWeight: 700, fontSize: 14 }}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* TOTALS & PERSISTENCE */}
        {invoiceItems.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
            {/* Tax break summary */}
            <div style={S.card}>
              <h4 style={{ fontSize: 12, fontWeight: 800, color: C.navy, margin: "0 0 10px 0", textTransform: "uppercase" }}>⚖️ Taxation Summary</h4>
              <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Total Taxable Amount:</span>
                  <strong>₹{totals.taxable.toFixed(2)}</strong>
                </div>
                {gstType === "Local State" ? (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>CGST (Central Tax):</span>
                      <strong>₹{totals.cgst.toFixed(2)}</strong>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>SGST (State Tax):</span>
                      <strong>₹{totals.sgst.toFixed(2)}</strong>
                    </div>
                  </>
                ) : (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>IGST (Integrated Tax):</span>
                    <strong>₹{totals.igst.toFixed(2)}</strong>
                  </div>
                )}
                <hr style={{ border: "none", borderTop: `1px solid ${C.border}`, margin: "6px 0" }} />
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: C.green }}>
                  <span>Total Invoice Value:</span>
                  <strong>₹{totals.grandTotal.toFixed(2)}</strong>
                </div>
              </div>
            </div>

            {/* Action panel */}
            <div style={{ ...S.card, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 13, color: C.text2, textAlign: "center" }}>
                Items: <strong>{invoiceItems.length}</strong> | Total Quantity: <strong>{totals.totalQty} units</strong>
              </div>
              <button
                type="button"
                onClick={handleSavePmbiInvoice}
                style={{ ...S.btn("green"), width: "100%", padding: "14px 28px", fontSize: 14, boxShadow: "0 4px 12px rgba(27,122,78,0.15)" }}
              >
                💾 Save PMBI Invoice + Inward Stock
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
