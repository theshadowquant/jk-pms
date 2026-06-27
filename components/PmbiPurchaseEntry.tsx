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

  // Import Panel States
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const [importPreviewData, setImportPreviewData] = useState<any>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  
  const excelInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  const downloadExcelTemplate = async () => {
    try {
      const XLSX = await import("xlsx");
      const wsData = [
        ["DC Code", "Product Name", "Unit", "HSN Code", "Batch", "Qty.", "Mnf Date", "Exp Date", "MRP", "Rate", "Amount", "CGST value (%)", "SGST value(%)", "IGST value(%)"],
        ["123", "LEVOCETIRIZINE 5MG", "Strip", "300490", "B-OS-200", "50", "2026-01", "2029-01", "120.00", "80.00", "4000.00", "6.0", "6.0", "0.0"]
      ];
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(wsData);
      XLSX.utils.book_append_sheet(wb, ws, "Purchase Template");
      XLSX.writeFile(wb, "pmbi_purchase_template.xlsx");
    } catch (e: any) {
      alert("Failed compiling template workbook.");
    }
  };

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsImporting(true);
    setImportStatus("Parsing spreadsheet file...");
    try {
      const XLSX = await import("xlsx");
      const reader = new FileReader();
      reader.onload = async (evt) => {
        try {
          const bstr = evt.target?.result;
          const wb = XLSX.read(bstr, { type: "binary" });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
          
          if (!json || json.length === 0) throw new Error("File is empty.");

          let headerIdx = -1;
          for (let i = 0; i < json.length; i++) {
            if (json[i].some(cell => {
              const s = String(cell || "").toLowerCase();
              return s.includes("code") || s.includes("generic") || s.includes("batch") || s.includes("mrp") || s.includes("dc");
            })) {
              headerIdx = i;
              break;
            }
          }

          if (headerIdx === -1) {
            throw new Error("Could not detect header row.");
          }

          const headers = json[headerIdx].map(h => String(h || "").trim().toLowerCase());
          const rows = json.slice(headerIdx + 1);

          const idxMap = {
            drugCode: headers.findIndex(h => h.includes("dc code") || h.includes("drug code") || h.includes("code")),
            genericName: headers.findIndex(h => h.includes("product name") || h.includes("generic") || h.includes("name") || h.includes("composition")),
            batchNumber: headers.findIndex(h => h.includes("batch")),
            manufacturingDate: headers.findIndex(h => h.includes("mnf date") || h.includes("mfg") || h.includes("manufactur")),
            expiryDate: headers.findIndex(h => h.includes("exp date") || h.includes("exp")),
            mrp: headers.findIndex(h => h.includes("mrp")),
            purchasePrice: headers.findIndex(h => h.includes("rate") || h.includes("pur") || h.includes("cost")),
            quantity: headers.findIndex(h => h.includes("qty") || h.includes("quant")),
            cgstRate: headers.findIndex(h => h.includes("cgst")),
            sgstRate: headers.findIndex(h => h.includes("sgst")),
            igstRate: headers.findIndex(h => h.includes("igst")),
          };

          const itemsList: any[] = [];
          rows.forEach((row, ri) => {
            if (!row || row.length === 0 || !row[idxMap.batchNumber || 0]) return;

            const rawCode = idxMap.drugCode !== -1 ? String(row[idxMap.drugCode] || "").trim() : "";
            const rawName = idxMap.genericName !== -1 ? String(row[idxMap.genericName] || "").trim() : "";

            let resolvedMed: any = null;
            if (rawCode) {
              resolvedMed = medicines.find(m => m.category === "PMBI" && m.drugCode?.toLowerCase() === rawCode.toLowerCase());
            }
            if (!resolvedMed && rawName) {
              resolvedMed = medicines.find(m => m.category === "PMBI" && m.genericName?.toLowerCase() === rawName.toLowerCase());
            }

            const mVal = resolvedMed || {};
            const mrpVal = idxMap.mrp !== -1 ? parseFloat(String(row[idxMap.mrp])) : parseFloat(mVal.mrp) || 0;
            const purVal = idxMap.purchasePrice !== -1 ? parseFloat(String(row[idxMap.purchasePrice])) : parseFloat(mVal.purchasePrice) || 0;
            const qtyVal = idxMap.quantity !== -1 ? parseInt(String(row[idxMap.quantity]), 10) : 0;
            const freeVal = 0;
            const discVal = 0;

            const cgstRateVal = idxMap.cgstRate !== -1 ? parseFloat(String(row[idxMap.cgstRate])) : 0;
            const sgstRateVal = idxMap.sgstRate !== -1 ? parseFloat(String(row[idxMap.sgstRate])) : 0;
            const igstRateVal = idxMap.igstRate !== -1 ? parseFloat(String(row[idxMap.igstRate])) : 0;
            let gstRateVal = igstRateVal > 0 ? igstRateVal : (cgstRateVal + sgstRateVal);
            if (isNaN(gstRateVal) || gstRateVal === 0) {
              gstRateVal = parseFloat(mVal.gstRate) || 12;
            }

            if (qtyVal <= 0) return;

            itemsList.push({
              drugCode: (rawCode || mVal.drugCode || `TEMP-${ri}`).toUpperCase(),
              genericName: rawName || mVal.genericName || "Imported Item",
              brandName: rawName || mVal.genericName || "Imported Item",
              companyName: mVal.companyName || "PMBI",
              batchNumber: String(row[idxMap.batchNumber] || "").toUpperCase().trim(),
              manufacturingDate: idxMap.manufacturingDate !== -1 ? String(row[idxMap.manufacturingDate] || "").trim() : new Date().toISOString().substring(0, 7),
              expiryDate: idxMap.expiryDate !== -1 ? String(row[idxMap.expiryDate] || "").trim() : "2028-12",
              mrp: isNaN(mrpVal) ? 0 : mrpVal,
              purchasePrice: isNaN(purVal) ? 0 : purVal,
              sellingPrice: parseFloat(mVal.sellingPrice) || mrpVal,
              quantity: isNaN(qtyVal) ? 0 : qtyVal,
              freeQuantity: freeVal,
              gstRate: gstRateVal,
              discount: discVal,
              isH1Drug: !!mVal.isH1Drug,
              catalogMatched: !!resolvedMed
            });
          });

          if (itemsList.length === 0) throw new Error("No items parsed.");

          setImportPreviewData({
            supplierName: "",
            invoiceNumber: "IMP-" + new Date().toISOString().substring(2, 10).replace(/-/g, ""),
            invoiceDate: new Date().toISOString().substring(0, 10),
            items: itemsList
          });
          setShowPreviewModal(true);
          setImportStatus("");
          setIsImporting(false);
        } catch (err: any) {
          alert("Error parsing file: " + err.message);
          setImportStatus("");
          setIsImporting(false);
        }
      };
      reader.readAsBinaryString(file);
    } catch (e: any) {
      alert("Spreadsheet Ingestion failed: " + e.message);
      setIsImporting(false);
      setImportStatus("");
    }
  };

  const handlePdfImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsImporting(true);
    setImportStatus("Uploading & analyzing purchase invoice with Gemini AI...");
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const rawResult = reader.result as string;
          const base64 = rawResult.split(",")[1];
          const mimeType = file.type || "application/pdf";

          const res = await fetch("/api/scan-invoice", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ base64, mimeType })
          });

          const resJson = await res.json();
          if (!resJson.success) {
            throw new Error(resJson.error || "Failed scanning invoice.");
          }

          const data = resJson.data;

          const parsedItems = (data.items || []).map((item: any) => {
            let resolvedMed = medicines.find(m => 
              m.category === "PMBI" && 
              ((item.genericName && m.genericName?.toLowerCase() === item.genericName.toLowerCase()) || 
               (item.brandName && m.brandName?.toLowerCase() === item.brandName.toLowerCase()))
            );

            if (!resolvedMed && item.genericName) {
              resolvedMed = medicines.find(m => m.category === "PMBI" && item.genericName.toLowerCase().includes((m.genericName || "").toLowerCase()));
            }

            const mVal = resolvedMed || {};
            return {
              drugCode: (mVal.drugCode || "TEMP").toUpperCase(),
              genericName: item.genericName || item.brandName || "Unknown Item",
              brandName: item.brandName || item.genericName || "Unknown Item",
              companyName: mVal.companyName || "PMBI",
              batchNumber: (item.batchNumber || "TEMP-BATCH").toUpperCase(),
              manufacturingDate: item.manufacturingDate || new Date().toISOString().substring(0, 7),
              expiryDate: item.expiryDate || "2029-12",
              mrp: parseFloat(item.mrp) || 0,
              purchasePrice: parseFloat(item.purchasePrice) || 0,
              sellingPrice: parseFloat(item.sellingPrice) || parseFloat(item.mrp) || 0,
              quantity: parseInt(item.quantity, 10) || 0,
              freeQuantity: parseInt(item.freeQuantity, 10) || 0,
              gstRate: parseFloat(item.gstRate) || parseFloat(mVal.gstRate) || 12,
              discount: parseFloat(item.discount) || 0,
              isH1Drug: !!mVal.isH1Drug,
              catalogMatched: !!resolvedMed
            };
          });

          setImportPreviewData({
            supplierName: data.supplierName || "",
            invoiceNumber: data.invoiceNumber || "",
            invoiceDate: data.invoiceDate || new Date().toISOString().substring(0, 10),
            items: parsedItems
          });

          setShowPreviewModal(true);
          setImportStatus("");
          setIsImporting(false);
        } catch (err: any) {
          alert("Gemini AI Scan failed: " + err.message);
          setImportStatus("");
          setIsImporting(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (e: any) {
      alert("AI Invoice Scan failed: " + e.message);
      setIsImporting(false);
      setImportStatus("");
    }
  };

  const handleConfirmImport = () => {
    if (!importPreviewData) return;

    if (importPreviewData.supplierName) {
      const matchSup = suppliers.find(s => s.name?.toLowerCase() === importPreviewData.supplierName.toLowerCase());
      setSupplierName(importPreviewData.supplierName);
      if (matchSup) {
        setSupplierGstin(matchSup.gstin || "");
        setSupplierPhone(matchSup.phone || "");
      }
    }
    if (importPreviewData.invoiceNumber) {
      setInvoiceNumber(importPreviewData.invoiceNumber);
    }
    if (importPreviewData.invoiceDate) {
      setInvoiceDate(importPreviewData.invoiceDate);
    }

    const itemsToLoad = importPreviewData.items.map((item: any) => {
      const qtyVal = item.quantity;
      const freeQtyVal = item.freeQuantity;
      const rateVal = item.purchasePrice;
      const mrpVal = item.mrp;
      const sellVal = item.sellingPrice || mrpVal;
      const discVal = item.discount;
      const gstRateVal = item.gstRate;

      const grossAmount = rateVal * qtyVal;
      const discountAmt = grossAmount * (discVal / 100);
      const taxableAmount = grossAmount - discountAmt;
      const totalGst = taxableAmount * (gstRateVal / 100);

      const cgst = gstType === "Local State" ? totalGst / 2 : 0;
      const sgst = gstType === "Local State" ? totalGst / 2 : 0;
      const igst = gstType === "Interstate" ? totalGst : 0;

      const totalAmount = taxableAmount + totalGst;

      return {
        ...item,
        taxableAmount,
        cgst,
        sgst,
        igst,
        totalAmount
      };
    });

    setInvoiceItems(prev => [...prev, ...itemsToLoad]);
    setShowPreviewModal(false);
    setImportPreviewData(null);
    setShowImportPanel(false);
  };

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
        {/* BULK IMPORT CONTROL DRAWER */}
        <div style={{ ...S.card, background: "#fff", border: `1.5px solid ${C.border2}`, padding: "16px 20px", marginBottom: 0 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={() => setShowImportPanel(!showImportPanel)}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18 }}>📥</span>
              <div>
                <strong style={{ fontSize: 14, color: C.navy }}>Bulk Import Purchase Invoice (AI Scanner / Excel / CSV)</strong>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>Upload spreadsheet worksheet or use Gemini AI to scan PDF/Image invoices instantly.</div>
              </div>
            </div>
            <button style={{ ...S.btn("outline"), padding: "6px 12px", fontSize: 12 }}>
              {showImportPanel ? "✕ Hide Panel" : "▼ Expand Import"}
            </button>
          </div>

          {showImportPanel && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
              {/* Zone A: AI PDF Scanner */}
              <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>📸</span>
                  <strong style={{ fontSize: 13, color: C.navy }}>AI Purchase PDF/Image Scanner</strong>
                </div>
                <p style={{ fontSize: 11, color: C.text2, margin: 0 }}>Upload PDF/image of PMBI challan invoice. Gemini AI parses supplier info, dates, and item grids automatically.</p>
                
                <input
                  type="file"
                  accept=".pdf,image/*"
                  ref={pdfInputRef}
                  onChange={handlePdfImport}
                  style={{ display: "none" }}
                />
                <button 
                  type="button" 
                  style={{ ...S.btn("primary"), marginTop: "auto" }} 
                  onClick={() => pdfInputRef.current?.click()}
                  disabled={isImporting}
                >
                  📸 Scan Invoice PDF / Image
                </button>
              </div>

              {/* Zone B: Excel/CSV Import */}
              <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 18 }}>📊</span>
                  <strong style={{ fontSize: 13, color: C.navy }}>Excel / CSV Spreadsheet Ingest</strong>
                </div>
                <p style={{ fontSize: 11, color: C.text2, margin: 0 }}>Import batches using our standard Excel layout structure. Matches item names and resolutions automatically.</p>
                
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  ref={excelInputRef}
                  onChange={handleExcelImport}
                  style={{ display: "none" }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: "auto" }}>
                  <button 
                    type="button" 
                    style={{ ...S.btn("teal"), flex: 1 }} 
                    onClick={() => excelInputRef.current?.click()}
                    disabled={isImporting}
                  >
                    📁 Upload Sheet
                  </button>
                  <button 
                    type="button" 
                    style={{ ...S.btn("outline"), flex: 1 }} 
                    onClick={downloadExcelTemplate}
                  >
                    📥 Get Template
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
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

      {/* PREVIEW IMPORT DIALOG */}
      {showPreviewModal && importPreviewData && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.3)", backdropFilter: "blur(3px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 10000
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "90%", maxWidth: 1000,
            maxHeight: "90vh", display: "flex", flexDirection: "column",
            boxShadow: "0 20px 50px rgba(0,0,0,0.15)", overflow: "hidden"
          }}>
            {/* Modal Header */}
            <div style={{ background: C.navy, color: "#fff", padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ fontSize: 15 }}>📋 Review Imported Purchase Details</strong>
              <button 
                type="button" 
                onClick={() => { setShowPreviewModal(false); setImportPreviewData(null); }} 
                style={{ background: "none", border: "none", color: "#fff", cursor: "pointer", fontSize: 16, fontWeight: 700 }}
              >
                ✕
              </button>
            </div>

            {/* Modal Body */}
            <div style={{ padding: 20, overflowY: "auto", flex: 1 }}>
              {/* Header mappings */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 20, padding: 14, background: "#F8FAFC", borderRadius: 10, border: `1px solid ${C.border}` }}>
                <div>
                  <label style={S.label}>Extracted Supplier</label>
                  <input 
                    style={S.input} 
                    value={importPreviewData.supplierName} 
                    onChange={e => setImportPreviewData({ ...importPreviewData, supplierName: e.target.value })} 
                    placeholder="Enter supplier name"
                  />
                </div>
                <div>
                  <label style={S.label}>Extracted Invoice Number</label>
                  <input 
                    style={S.input} 
                    value={importPreviewData.invoiceNumber} 
                    onChange={e => setImportPreviewData({ ...importPreviewData, invoiceNumber: e.target.value })} 
                    placeholder="Invoice No"
                  />
                </div>
                <div>
                  <label style={S.label}>Extracted Invoice Date</label>
                  <input 
                    type="date" 
                    style={S.input} 
                    value={importPreviewData.invoiceDate} 
                    onChange={e => setImportPreviewData({ ...importPreviewData, invoiceDate: e.target.value })} 
                  />
                </div>
              </div>

              {/* Items grid */}
              <strong style={{ fontSize: 12, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>Line Items Extracted ({importPreviewData.items.length})</strong>
              <div style={{ overflowX: "auto", marginTop: 8, border: `1.5px solid ${C.border}`, borderRadius: 10 }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      <th style={S.th}>Drug Code</th>
                      <th style={S.th}>Generic Name</th>
                      <th style={S.th}>Batch No</th>
                      <th style={S.th}>Mfg / Exp Date</th>
                      <th style={{ ...S.th, textAlign: "right" }}>MRP</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Pur. Price</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Qty + Free</th>
                      <th style={{ ...S.th, textAlign: "center" }}>GST %</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Catalog Match</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importPreviewData.items.map((item: any, idx: number) => (
                      <tr key={idx}>
                        <td style={S.td}>
                          <input 
                            style={{ ...S.input, padding: "5px 8px" }} 
                            value={item.drugCode} 
                            onChange={e => {
                              const updatedItems = [...importPreviewData.items];
                              updatedItems[idx].drugCode = e.target.value.toUpperCase();
                              const matched = medicines.find(m => m.category === "PMBI" && m.drugCode?.toLowerCase() === e.target.value.toLowerCase());
                              if (matched) {
                                updatedItems[idx].genericName = matched.genericName || updatedItems[idx].genericName;
                                updatedItems[idx].gstRate = parseFloat(matched.gstRate) || 12;
                                updatedItems[idx].isH1Drug = !!matched.isH1Drug;
                                updatedItems[idx].catalogMatched = true;
                              }
                              setImportPreviewData({ ...importPreviewData, items: updatedItems });
                            }}
                          />
                        </td>
                        <td style={S.td}>
                          <input 
                            style={{ ...S.input, padding: "5px 8px" }} 
                            value={item.genericName} 
                            onChange={e => {
                              const updatedItems = [...importPreviewData.items];
                              updatedItems[idx].genericName = e.target.value;
                              setImportPreviewData({ ...importPreviewData, items: updatedItems });
                            }}
                          />
                        </td>
                        <td style={S.td}>
                          <input 
                            style={{ ...S.input, padding: "5px 8px" }} 
                            value={item.batchNumber} 
                            onChange={e => {
                              const updatedItems = [...importPreviewData.items];
                              updatedItems[idx].batchNumber = e.target.value.toUpperCase();
                              setImportPreviewData({ ...importPreviewData, items: updatedItems });
                            }}
                          />
                        </td>
                        <td style={S.td}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <input 
                              style={{ ...S.input, padding: "5px 8px", width: 75 }} 
                              value={item.manufacturingDate} 
                              onChange={e => {
                                const updatedItems = [...importPreviewData.items];
                                updatedItems[idx].manufacturingDate = e.target.value;
                                setImportPreviewData({ ...importPreviewData, items: updatedItems });
                              }}
                            />
                            <input 
                              style={{ ...S.input, padding: "5px 8px", width: 75 }} 
                              value={item.expiryDate} 
                              onChange={e => {
                                const updatedItems = [...importPreviewData.items];
                                updatedItems[idx].expiryDate = e.target.value;
                                setImportPreviewData({ ...importPreviewData, items: updatedItems });
                              }}
                            />
                          </div>
                        </td>
                        <td style={S.td}>
                          <input 
                            type="number" 
                            step="0.01" 
                            style={{ ...S.input, padding: "5px 8px", textAlign: "right", width: 70 }} 
                            value={item.mrp} 
                            onChange={e => {
                              const updatedItems = [...importPreviewData.items];
                              updatedItems[idx].mrp = parseFloat(e.target.value) || 0;
                              setImportPreviewData({ ...importPreviewData, items: updatedItems });
                            }}
                          />
                        </td>
                        <td style={S.td}>
                          <input 
                            type="number" 
                            step="0.01" 
                            style={{ ...S.input, padding: "5px 8px", textAlign: "right", width: 70 }} 
                            value={item.purchasePrice} 
                            onChange={e => {
                              const updatedItems = [...importPreviewData.items];
                              updatedItems[idx].purchasePrice = parseFloat(e.target.value) || 0;
                              setImportPreviewData({ ...importPreviewData, items: updatedItems });
                            }}
                          />
                        </td>
                        <td style={S.td}>
                          <div style={{ display: "flex", gap: 4 }}>
                            <input 
                              type="number" 
                              style={{ ...S.input, padding: "5px 8px", textAlign: "center", width: 55 }} 
                              value={item.quantity} 
                              onChange={e => {
                                const updatedItems = [...importPreviewData.items];
                                updatedItems[idx].quantity = parseInt(e.target.value, 10) || 0;
                                setImportPreviewData({ ...importPreviewData, items: updatedItems });
                              }}
                            />
                            <input 
                              type="number" 
                              style={{ ...S.input, padding: "5px 8px", textAlign: "center", width: 45 }} 
                              value={item.freeQuantity} 
                              onChange={e => {
                                const updatedItems = [...importPreviewData.items];
                                updatedItems[idx].freeQuantity = parseInt(e.target.value, 10) || 0;
                                setImportPreviewData({ ...importPreviewData, items: updatedItems });
                              }}
                            />
                          </div>
                        </td>
                        <td style={S.td}>
                          <select 
                            style={{ ...S.input, padding: "5px 8px", width: 70 }} 
                            value={item.gstRate} 
                            onChange={e => {
                              const updatedItems = [...importPreviewData.items];
                              updatedItems[idx].gstRate = parseFloat(e.target.value) || 12;
                              setImportPreviewData({ ...importPreviewData, items: updatedItems });
                            }}
                          >
                            <option value="0">0%</option>
                            <option value="5">5%</option>
                            <option value="12">12%</option>
                            <option value="18">18%</option>
                            <option value="28">28%</option>
                          </select>
                        </td>
                        <td style={{ ...S.td, textAlign: "center" }}>
                          {item.catalogMatched ? (
                            <span style={{ fontSize: 10, fontWeight: 800, color: C.green, background: "#E8F5EE", borderRadius: 4, padding: "3px 6px" }}>
                              ✓ Catalog Matched
                            </span>
                          ) : (
                            <span style={{ fontSize: 10, fontWeight: 800, color: C.amber, background: "#FFF8E7", borderRadius: 4, padding: "3px 6px" }}>
                              ⚠ Temporary Row
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Modal Footer */}
            <div style={{ background: "#F8FAFC", borderTop: `1px solid ${C.border}`, padding: "12px 20px", display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button 
                type="button" 
                style={S.btn("outline")} 
                onClick={() => { setShowPreviewModal(false); setImportPreviewData(null); }}
              >
                ✕ Cancel Import
              </button>
              <button 
                type="button" 
                style={S.btn("green")} 
                onClick={handleConfirmImport}
              >
                💾 Import & Load Into Invoice
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Web Worker/AI Loading Overlay */}
      {isImporting && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.25)", backdropFilter: "blur(2px)",
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
              {importStatus}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
