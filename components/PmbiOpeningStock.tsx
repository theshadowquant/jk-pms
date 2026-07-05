"use client";

import React, { useState, useEffect } from "react";
import { collection, doc, runTransaction, serverTimestamp } from "firebase/firestore";

interface PmbiOpeningStockProps {
  db: any;
  storeId: string;
  storeCode: string;
  user: any;
  medicines: any[];
  pmbiItems: any[];
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

export default function PmbiOpeningStock({ db, storeId, storeCode, user, medicines, pmbiItems }: PmbiOpeningStockProps) {
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
  const [editingMedId, setEditingMedId] = useState<string | null>(null);
  const [editingBatchIndex, setEditingBatchIndex] = useState<number | null>(null);

  const [drugSearchFocused, setDrugSearchFocused] = useState(false);
  const [drugResults, setDrugResults] = useState<any[]>([]);

  // PMBI Catalog Excel Import States
  const [showImportPanel, setShowImportPanel] = useState(false);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState(0);
  const [importStatus, setImportStatus] = useState("");
  const [parsedItems, setParsedItems] = useState<any[]>([]);
  const [mapping, setMapping] = useState({
    drugCode: -1,
    genericName: -1,
    unitSize: -1,
    mrp: -1,
    groupName: -1
  });
  const [rawHeaders, setRawHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<any[][]>([]);

  // Autocomplete search of catalog
  useEffect(() => {
    if (drugCode.length >= 2) {
      const medResults = medicines.filter((m: any) => 
        m.category === "PMBI" && 
        ((m.drugCode || "").toLowerCase().includes(drugCode.toLowerCase()) || 
         (m.genericName || "").toLowerCase().includes(drugCode.toLowerCase()))
      );

      const catalogResults = Array.isArray(pmbiItems)
        ? pmbiItems.filter((item: any) =>
            (item.drugCode || "").toLowerCase().includes(drugCode.toLowerCase()) || 
            (item.genericName || "").toLowerCase().includes(drugCode.toLowerCase())
          ).map(item => ({
            id: `catalog_${item.drugCode}`,
            drugCode: item.drugCode,
            genericName: item.genericName,
            brandName: item.genericName,
            mrp: item.mrp || 0,
            sellingPrice: item.mrp || 0,
            purchasePrice: 0,
            gstRate: 12,
            companyName: "PMBI",
            category: "PMBI",
            isH1Drug: false,
            isCatalogOnly: true
          }))
        : [];

      // Merge and deduplicate by drugCode
      const merged = [...medResults];
      catalogResults.forEach(cat => {
        if (!merged.some(m => m.drugCode?.toLowerCase() === cat.drugCode?.toLowerCase())) {
          merged.push(cat);
        }
      });

      setDrugResults(merged.slice(0, 8));
    } else {
      setDrugResults([]);
    }
  }, [drugCode, medicines, pmbiItems]);

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

  const handleEditBatch = (med: any, batch: any, index: number) => {
    setEditingMedId(med.id);
    setEditingBatchIndex(index);
    setDrugCode(med.drugCode || "");
    setDrugName(med.genericName || "");
    setBatchNumber(batch.batchNumber || "");
    setManufacturingDate(batch.manufacturingDate || "");
    setExpiryDate(batch.expiryDate || "");
    setMrp(String(batch.mrp || med.mrp || ""));
    setPurchasePrice(String(batch.purchasePrice || med.purchasePrice || ""));
    setSellingPrice(String(batch.sellingPrice || med.sellingPrice || ""));
    setQuantity(String(batch.quantity || ""));
    setGstRate(String(med.gstRate || "12"));
    setIsH1Drug(med.isH1Drug || false);
  };

  const handleCancelEdit = () => {
    setEditingMedId(null);
    setEditingBatchIndex(null);
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
  };

  const handleDeleteBatch = async (med: any, index: number) => {
    const batch = med.batches?.[index];
    if (!batch) return;
    if (!window.confirm(`Are you sure you want to delete batch "${batch.batchNumber}"?`)) return;

    try {
      await runTransaction(db, async (transaction) => {
        const medRef = doc(db, "medicines", med.id);
        const currentBatches = Array.isArray(med.batches) ? med.batches.map((b: any) => ({ ...b })) : [];
        const deletedQty = currentBatches[index].quantity || 0;
        currentBatches.splice(index, 1);

        if (currentBatches.length === 0) {
          transaction.delete(medRef);
        } else {
          const totalStock = currentBatches.reduce((sum: number, b: any) => sum + (b.quantity || 0), 0);
          transaction.update(medRef, {
            stockQty: totalStock,
            batches: currentBatches,
            updatedAt: serverTimestamp()
          });
        }

        // Write audit log
        const auditDoc = doc(collection(db, "inventory_audit_logs"));
        transaction.set(auditDoc, {
          storeId,
          medicineId: med.id,
          genericName: med.genericName,
          brandName: med.brandName,
          batchNumber: batch.batchNumber,
          type: "DELETE_BATCH",
          actionSource: "PMBI_OPENING_STOCK",
          referenceId: "OPENING-STOCK-DELETE",
          quantityChanged: -deletedQty,
          previousQuantity: deletedQty,
          newQuantity: 0,
          purchasePrice: batch.purchasePrice || med.purchasePrice || 0,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });
      });

      alert("✓ PMBI Opening Stock batch deleted successfully.");
    } catch (err: any) {
      console.error(err);
      alert("Error deleting PMBI opening stock batch: " + err.message);
    }
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
        if (editingMedId) {
          const medRef = doc(db, "medicines", editingMedId);
          const existingMed = medicines.find((m: any) => m.id === editingMedId);
          if (!existingMed) {
            throw new Error("Medicine being edited was not found in catalog.");
          }

          const currentBatches = Array.isArray(existingMed.batches) ? existingMed.batches.map((b: any) => ({ ...b })) : [];
          if (editingBatchIndex === null || editingBatchIndex < 0 || editingBatchIndex >= currentBatches.length) {
            throw new Error("Batch being edited was not found.");
          }

          const oldQty = currentBatches[editingBatchIndex].quantity || 0;
          currentBatches[editingBatchIndex] = {
            ...currentBatches[editingBatchIndex],
            batchNumber: batchNumber.toUpperCase().trim(),
            expiryDate: expiryDate.trim(),
            manufacturingDate: manufacturingDate.trim(),
            quantity: qtyVal,
            purchasePrice: purchaseVal,
            mrp: mrpVal,
            sellingPrice: sellVal
          };

          const totalStock = currentBatches.reduce((sum: number, b: any) => sum + (b.quantity || 0), 0);

          transaction.update(medRef, {
            drugCode: drugCode.toUpperCase().trim(),
            genericName: drugName.trim(),
            brandName: drugName.trim(),
            mrp: mrpVal,
            sellingPrice: sellVal,
            purchasePrice: purchaseVal,
            gstRate: gstRateVal,
            expiryDate: expiryDate.trim(),
            stockQty: totalStock,
            batches: currentBatches,
            isH1Drug,
            updatedAt: serverTimestamp()
          });

          const auditDoc = doc(collection(db, "inventory_audit_logs"));
          transaction.set(auditDoc, {
            storeId,
            medicineId: editingMedId,
            genericName: drugName.trim(),
            brandName: drugName.trim(),
            batchNumber: batchNumber.toUpperCase().trim(),
            type: "OPENING_STOCK_EDIT",
            actionSource: "PMBI_OPENING_STOCK",
            referenceId: "OPENING-STOCK-EDIT",
            quantityChanged: qtyVal - oldQty,
            previousQuantity: oldQty,
            newQuantity: qtyVal,
            purchasePrice: purchaseVal,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });

          return;
        }

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

          const matchedCatalog = pmbiItems?.find(item => item.drugCode?.toLowerCase() === drugCode.trim().toLowerCase());
          const formVal = matchedCatalog?.unitSize || "Tablet";

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
            form: formVal,
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
      if (editingMedId) {
        setEditingMedId(null);
        setEditingBatchIndex(null);
        alert("✓ PMBI Opening Stock batch updated successfully!");
      } else {
        alert("✓ PMBI Opening Stock registered successfully. Catalog and batch files initialized!");
      }
    } catch (err: any) {
      console.error(err);
      alert("Error saving PMBI opening stock: " + err.message);
    }
  };

  // PMBI Catalog Excel Import Functions
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setExcelFile(file);
    setImportStatus("Reading file...");
    try {
      const XLSX = await import("xlsx");
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const bstr = evt.target?.result;
          if (!bstr) return;
          const wb = XLSX.read(bstr, { type: "binary" });
          const wsname = wb.SheetNames[0];
          const ws = wb.Sheets[wsname];
          const json = XLSX.utils.sheet_to_json(ws, { header: 1 }) as any[][];
          
          if (!json || json.length === 0) {
            alert("Error: The Excel file is empty.");
            return;
          }

          // Find header row
          let headerIdx = -1;
          for (let i = 0; i < json.length; i++) {
            if (json[i].some(cell => {
              const s = String(cell || "").toLowerCase();
              return s.includes("generic") || s.includes("item description") || s.includes("drug code") || s.includes("mrp");
            })) {
              headerIdx = i;
              break;
            }
          }

          if (headerIdx === -1) headerIdx = 0;

          const fileHeaders = json[headerIdx].map(h => String(h || "").trim());
          const rows = json.slice(headerIdx + 1);

          setRawHeaders(fileHeaders);
          setRawRows(rows);

          // Auto-map headers
          const headersLower = fileHeaders.map(h => h.toLowerCase());
          const mapped = {
            drugCode: headersLower.findIndex(h => h.includes("code")),
            genericName: headersLower.findIndex(h => h.includes("generic") || h.includes("item description") || h.includes("description") || h.includes("name")),
            unitSize: headersLower.findIndex(h => h.includes("unit") || h.includes("size") || h.includes("pack")),
            mrp: headersLower.findIndex(h => h.includes("mrp") || h.includes("price")),
            groupName: headersLower.findIndex(h => h.includes("group") || h.includes("category"))
          };

          setMapping(mapped);
          setImportStatus("File parsed. Verify column mapping below.");
          applyMapping(rows, mapped);
        } catch (err: any) {
          console.error(err);
          alert("Error reading file: " + err.message);
        }
      };
      reader.readAsBinaryString(file);
    } catch (err: any) {
      console.error(err);
      alert("Error loading xlsx parser: " + err.message);
    }
  };

  const applyMapping = (rows: any[][], curMapping: typeof mapping) => {
    const items = rows.map((row, idx) => {
      const getVal = (field: keyof typeof mapping) => {
        const colIdx = curMapping[field];
        return colIdx !== undefined && colIdx >= 0 ? row[colIdx] : null;
      };

      const drugCode = getVal("drugCode") ? String(getVal("drugCode")).trim() : "";
      const genericName = getVal("genericName") ? String(getVal("genericName")).trim() : "";
      const unitSize = getVal("unitSize") ? String(getVal("unitSize")).trim() : "";
      const mrpRaw = getVal("mrp");
      const mrp = mrpRaw !== null && mrpRaw !== undefined ? parseFloat(String(mrpRaw).replace(/[^\d.]/g, "")) || 0 : 0;
      const groupName = getVal("groupName") ? String(getVal("groupName")).trim() : "";

      const codeMissing = !drugCode;
      const nameMissing = !genericName;
      const mrpInvalid = mrp <= 0;

      return {
        id: idx,
        drugCode,
        genericName,
        unitSize,
        mrp,
        groupName,
        codeMissing,
        nameMissing,
        mrpInvalid
      };
    }).filter(item => item.drugCode || item.genericName);

    setParsedItems(items);
  };

  const handleMapChange = (field: keyof typeof mapping, colIdx: number) => {
    const updated = { ...mapping, [field]: colIdx };
    setMapping(updated);
    applyMapping(rawRows, updated);
  };

  const handleIngestPMBICatalog = async () => {
    if (!parsedItems.length) return;
    if (!storeId) { alert("Error: No store linked to user."); return; }

    const hasErrors = parsedItems.some(i => i.codeMissing || i.nameMissing || i.mrpInvalid);
    if (hasErrors) {
      if (!window.confirm("⚠️ Some records have missing drug codes, names, or invalid MRPs. Do you want to skip invalid items and import the rest?")) {
        return;
      }
    }

    setImporting(true);
    setImportProgress(0);
    setImportStatus("Importing catalog items...");

    const validItems = parsedItems.filter(i => !i.codeMissing && !i.nameMissing && !i.mrpInvalid);
    const chunkSize = 100;
    let processed = 0;

    try {
      const processChunk = async (startIndex: number) => {
        const chunk = validItems.slice(startIndex, startIndex + chunkSize);

        await runTransaction(db, async (transaction) => {
          for (const item of chunk) {
            // Check if item already exists by drugCode and category PMBI
            const existingMed = medicines.find((m: any) => 
              m.category === "PMBI" && 
              String(m.drugCode || "").toLowerCase() === String(item.drugCode).toLowerCase()
            );

            if (existingMed) {
              const medRef = doc(db, "medicines", existingMed.id);
              transaction.update(medRef, {
                genericName: item.genericName.trim(),
                brandName: item.genericName.trim(),
                mrp: item.mrp,
                sellingPrice: item.mrp,
                unitSize: item.unitSize,
                groupName: item.groupName,
                updatedAt: serverTimestamp()
              });
            } else {
              const medColRef = collection(db, "medicines");
              const newMedDoc = doc(medColRef);
              transaction.set(newMedDoc, {
                storeId,
                storeCode,
                category: "PMBI",
                drugCode: String(item.drugCode).toUpperCase().trim(),
                genericName: item.genericName.trim(),
                brandName: item.genericName.trim(),
                companyName: "PMBI",
                mrp: item.mrp,
                sellingPrice: item.mrp,
                purchasePrice: 0,
                stockQty: 0,
                lowStockAlert: 20,
                gstRate: 12,
                isH1Drug: false,
                batches: [],
                unitSize: item.unitSize,
                groupName: item.groupName,
                createdAt: serverTimestamp(),
                createdBy: user.uid
              });
            }
          }
        });

        processed += chunk.length;
        const progress = Math.round((processed / validItems.length) * 100);
        setImportProgress(progress);
        setImportStatus(`Ingesting catalog items... (${progress}%)`);

        if (processed < validItems.length) {
          await new Promise(resolve => setTimeout(resolve, 50));
          await processChunk(processed);
        }
      };

      if (validItems.length > 0) {
        await processChunk(0);
      }

      alert(`✓ Successfully processed and updated ${validItems.length} PMBI medicines in the catalog.`);
      setExcelFile(null);
      setParsedItems([]);
      setRawHeaders([]);
      setRawRows([]);
      setImportStatus("");
      setShowImportPanel(false);
    } catch (err: any) {
      console.error(err);
      alert("Error during PMBI catalog import: " + err.message);
    } finally {
      setImporting(false);
    }
  };

  // Get only PMBI medicines
  const pmbiMeds = medicines.filter((m: any) => m.category === "PMBI");

  return (
    <div>
      {/* HEADER BAR */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, color: C.navy, margin: 0 }}>
            {editingMedId !== null ? "✏️ Edit PMBI Opening Stock Batch" : "➕ PMBI Opening Stock Entry"}
          </h2>
          <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>Directly upload initial inventory levels for Jan Aushadhi medicines. Safe Mode isolated ingestion.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            style={S.btn("outline")}
            onClick={() => setShowImportPanel(p => !p)}
          >
            📊 {showImportPanel ? "Hide Excel Import" : "Import PMBI Catalog (Excel)"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 16 }}>
        {/* EXCEL MIGRATION IMPORT PANEL */}
        {showImportPanel && (
          <div style={{ ...S.card, border: `2px solid ${C.teal}` }}>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, marginTop: 0, marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
              📊 Batch Import PMBI Catalog
            </h3>
            <p style={{ fontSize: 12, color: C.text3, marginTop: 0, marginBottom: 16 }}>
              Select an Excel or CSV file containing the PMBI medicines list to batch-import items into the search database.
            </p>

            {/* Ingestion overlay progress */}
            {importing && (
              <div style={{ background: "#E8F5EE", border: `1.5px solid ${C.green}`, borderRadius: 8, padding: 16, marginBottom: 16, textAlign: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.green, marginBottom: 8 }}>⚡ {importStatus}</div>
                <div style={{ background: "#CBD5E0", height: 10, borderRadius: 5, overflow: "hidden", marginBottom: 6, maxWidth: 300, margin: "0 auto 6px" }}>
                  <div style={{ background: C.green, height: "100%", width: `${importProgress}%`, transition: "width 0.1s ease" }} />
                </div>
                <span style={{ fontSize: 11, color: C.text2, fontWeight: 600 }}>{importProgress}% Complete ({parsedItems.length} items total)</span>
              </div>
            )}

            {!importing && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleFileChange}
                    style={{ fontSize: 13 }}
                  />
                  {excelFile && (
                    <button
                      type="button"
                      style={S.btn("outline")}
                      onClick={() => {
                        setExcelFile(null);
                        setParsedItems([]);
                        setRawHeaders([]);
                        setRawRows([]);
                        setImportStatus("");
                      }}
                    >
                      Reset File
                    </button>
                  )}
                </div>

                {rawHeaders.length > 0 && (
                  <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, padding: 14, borderRadius: 8 }}>
                    <h4 style={{ fontSize: 12, fontWeight: 700, color: C.text, marginTop: 0, marginBottom: 10, textTransform: "uppercase" }}>
                      Column Field Mapping
                    </h4>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                      {[
                        { label: "Drug Code *", field: "drugCode" as const },
                        { label: "Generic Name *", field: "genericName" as const },
                        { label: "Unit Size", field: "unitSize" as const },
                        { label: "MRP *", field: "mrp" as const },
                        { label: "Group Name", field: "groupName" as const }
                      ].map(item => (
                        <div key={item.field} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <label style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>{item.label}</label>
                          <select
                            style={{ ...S.input, padding: "5px 8px", fontSize: 12 }}
                            value={mapping[item.field]}
                            onChange={e => handleMapChange(item.field, parseInt(e.target.value))}
                          >
                            <option value="-1">-- Unmapped --</option>
                            {rawHeaders.map((h, hi) => (
                              <option key={hi} value={hi}>{h}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {parsedItems.length > 0 && (
                  <div>
                    <h4 style={{ fontSize: 12, fontWeight: 700, color: C.text, marginTop: 10, marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
                      <span>📋 Preview parsed data ({parsedItems.length} items)</span>
                      {parsedItems.some(i => i.codeMissing || i.nameMissing || i.mrpInvalid) && (
                        <span style={{ color: C.red, fontSize: 11 }}>⚠️ Contains validation errors (highlighted in red)</span>
                      )}
                    </h4>
                    <div style={{ maxHeight: 180, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 8 }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                        <thead>
                          <tr style={{ background: "#F1F5F9", position: "sticky", top: 0, zIndex: 10 }}>
                            <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid ${C.border}` }}>Drug Code</th>
                            <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid ${C.border}` }}>Generic Name</th>
                            <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid ${C.border}` }}>Unit</th>
                            <th style={{ padding: "6px 10px", textAlign: "right", borderBottom: `1px solid ${C.border}` }}>MRP</th>
                            <th style={{ padding: "6px 10px", textAlign: "left", borderBottom: `1px solid ${C.border}` }}>Group</th>
                          </tr>
                        </thead>
                        <tbody>
                          {parsedItems.map((item, idx) => (
                            <tr key={idx} style={{ background: item.codeMissing || item.nameMissing || item.mrpInvalid ? "#FDFCEA" : idx % 2 === 0 ? "#fff" : "#F8FAFC" }}>
                              <td style={{ padding: "6px 10px", borderBottom: `1px solid ${C.border}`, color: item.codeMissing ? C.red : C.text2, fontWeight: item.codeMissing ? 700 : 400 }}>
                                {item.drugCode || "[MISSING]"}
                              </td>
                              <td style={{ padding: "6px 10px", borderBottom: `1px solid ${C.border}`, color: item.nameMissing ? C.red : C.text2, fontWeight: item.nameMissing ? 700 : 400 }}>
                                {item.genericName || "[MISSING]"}
                              </td>
                              <td style={{ padding: "6px 10px", borderBottom: `1px solid ${C.border}` }}>{item.unitSize || "-"}</td>
                              <td style={{ padding: "6px 10px", borderBottom: `1px solid ${C.border}`, textAlign: "right", color: item.mrpInvalid ? C.red : C.text2, fontWeight: item.mrpInvalid ? 700 : 400 }}>
                                ₹{item.mrp.toFixed(2)}
                              </td>
                              <td style={{ padding: "6px 10px", borderBottom: `1px solid ${C.border}` }}>{item.groupName || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    
                    <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 14 }}>
                      <button
                        type="button"
                        style={S.btn("outline")}
                        onClick={() => {
                          setExcelFile(null);
                          setParsedItems([]);
                          setRawHeaders([]);
                          setRawRows([]);
                          setImportStatus("");
                          setShowImportPanel(false);
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        style={S.btn("green")}
                        onClick={handleIngestPMBICatalog}
                        disabled={parsedItems.length === 0}
                      >
                        🚀 Import {parsedItems.filter(i => !i.codeMissing && !i.nameMissing && !i.mrpInvalid).length} Valid Items
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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

            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
              {editingMedId !== null && (
                <button type="button" style={S.btn("outline")} onClick={handleCancelEdit}>
                  Cancel Edit
                </button>
              )}
              <button type="submit" style={S.btn("teal")}>
                {editingMedId !== null ? "💾 Save Batch Changes" : "＋ Save PMBI Opening Stock Batch"}
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
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {(med.batches || []).map((b: any, bi: number) => (
                            <div key={bi} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottom: bi < (med.batches.length - 1) ? `1px solid ${C.border}` : "none", paddingBottom: bi < (med.batches.length - 1) ? 4 : 0 }}>
                              <span style={{ fontSize: 11, fontFamily: "monospace", color: C.text2 }}>
                                Batch: <strong>{b.batchNumber}</strong> (Qty: {b.quantity}) · Exp: {b.expiryDate}
                              </span>
                              <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                                <button
                                  type="button"
                                  onClick={() => handleEditBatch(med, b, bi)}
                                  style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 12, fontWeight: 700, padding: 2 }}
                                  title="Edit Batch"
                                >
                                  ✏️ Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteBatch(med, bi)}
                                  style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12, fontWeight: 700, padding: 2 }}
                                  title="Delete Batch"
                                >
                                  🗑️ Delete
                                </button>
                              </div>
                            </div>
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
