// public/workers/report.worker.js
importScripts("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js");
importScripts("https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/pdfmake.min.js");
importScripts("https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.7/vfs_fonts.js");

self.onmessage = function (e) {
  const { type, payload, fileName } = e.data;

  try {
    if (type === "EXPORT_SALES_EXCEL") {
      const buffer = transformSalesToExcelBuffer(payload);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_PURCHASES_EXCEL") {
      const buffer = transformPurchasesToExcelBuffer(payload);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_EXPIRY_EXCEL") {
      const buffer = transformExpiryToExcelBuffer(payload);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_PMBI_REPORTS_EXCEL") {
      const buffer = transformPmbiToExcelBuffer(payload);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_H1_SALES_EXCEL") {
      const buffer = transformH1SalesToExcelBuffer(payload);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_H1_PURCHASES_EXCEL") {
      const buffer = transformH1PurchasesToExcelBuffer(payload);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_TAX_PDF") {
      transformTaxToPDFBuffer(payload, (buffer) => {
        self.postMessage({ success: true, fileData: buffer, type, fileName });
      }, (err) => {
        self.postMessage({ success: false, error: err.message, type });
      });
    } else if (type === "EXPORT_INVOICE_PDF") {
      transformInvoiceToPDFBuffer(payload, (buffer) => {
        self.postMessage({ success: true, fileData: buffer, type, fileName });
      }, (err) => {
        self.postMessage({ success: false, error: err.message, type });
      });
    } else if (type === "EXPORT_PMBI_REPORTS_PDF") {
      transformPmbiToPDFBuffer(payload, (buffer) => {
        self.postMessage({ success: true, fileData: buffer, type, fileName });
      }, (err) => {
        self.postMessage({ success: false, error: err.message, type });
      });
    } else if (type === "EXPORT_STOCK_INVENTORY_EXCEL") {
      const buffer = transformStockInventoryToExcelBuffer(payload.items);
      self.postMessage({ success: true, fileData: buffer, type, fileName });
    } else if (type === "EXPORT_STOCK_INVENTORY_PDF") {
      transformStockInventoryToPDFBuffer(payload, (buffer) => {
        self.postMessage({ success: true, fileData: buffer, type, fileName });
      }, (err) => {
        self.postMessage({ success: false, error: err.message, type });
      });
    }
  } catch (error) {
    self.postMessage({ success: false, error: error.message, type });
  }
};

function transformSalesToExcelBuffer(sales) {
  const wsData = [
    [
      "Invoice No", "Date", "Customer Name", "Customer Phone", "Drug Code",
      "Generic Name", "Brand Name", "Strength", "Form",
      "Batch Number", "Expiry Date", "Qty Sold", "MRP (Unit)",
      "Selling Price (Unit)", "Discount %", "Landed Purchase Price (Unit)",
      "Total Landed COGS", "Net Revenue (Total)", "CGST (Total)",
      "SGST (Total)", "GST Rate %", "Net Profit", "Payment Mode"
    ]
  ];

  sales.forEach(sale => {
    let dateStr = "—";
    if (sale.createdAt) {
      const d = sale.createdAt.seconds 
        ? new Date(sale.createdAt.seconds * 1000) 
        : new Date(sale.createdAt);
      dateStr = d.toLocaleDateString("en-IN");
    }

    (sale.items || []).forEach(item => {
      const gstRate = item.gstRate || 12;
      const discount = item.discount || 0;
      
      if (Array.isArray(item.batchesUsed) && item.batchesUsed.length > 0) {
        item.batchesUsed.forEach(batch => {
          const qty = batch.quantity || 0;
          const buyPrice = batch.purchasePrice || 0;
          const sellPrice = batch.sellingPrice || 0;
          
          const itemCogs = qty * buyPrice;
          const itemRev = qty * sellPrice * (1 - discount / 100);
          const profit = itemRev - itemCogs;
          
          const taxable = itemRev / (1 + (gstRate / 100));
          const gstTotal = itemRev - taxable;

          wsData.push([
            sale.billNumber || "—",
            dateStr,
            sale.customerName || "Walk-in Patient",
            sale.customerPhone || "—",
            item.drugCode || "—",
            item.genericName || "—",
            item.brandName || "—",
            item.strength || "—",
            item.form || "—",
            batch.batchNumber || "—",
            batch.expiryDate || "—",
            qty,
            batch.mrp || 0,
            sellPrice,
            discount,
            buyPrice,
            +itemCogs.toFixed(2),
            +itemRev.toFixed(2),
            +(gstTotal / 2).toFixed(2),
            +(gstTotal / 2).toFixed(2),
            `${gstRate}%`,
            +profit.toFixed(2),
            sale.paymentMode || "Cash"
          ]);
        });
      } else {
        const qty = item.quantity || 0;
        const buyPrice = item.purchasePrice || 0;
        const sellPrice = item.sellingPrice || item.mrp || 0;
        
        const itemCogs = qty * buyPrice;
        const itemRev = qty * sellPrice * (1 - discount / 100);
        const profit = itemRev - itemCogs;
        
        const taxable = itemRev / (1 + (gstRate / 100));
        const gstTotal = itemRev - taxable;

        wsData.push([
          sale.billNumber || "—",
          dateStr,
          sale.customerName || "Walk-in Patient",
          sale.customerPhone || "—",
          item.drugCode || "—",
          item.genericName || "—",
          item.brandName || "—",
          item.strength || "—",
          item.form || "—",
          item.batchNumber || "—",
          item.expiryDate || "—",
          qty,
          item.mrp || 0,
          sellPrice,
          discount,
          buyPrice,
          +itemCogs.toFixed(2),
          +itemRev.toFixed(2),
          +(gstTotal / 2).toFixed(2),
          +(gstTotal / 2).toFixed(2),
          `${gstRate}%`,
          +profit.toFixed(2),
          sale.paymentMode || "Cash"
        ]);
      }
    });
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  const wscols = wsData[0].map((_, colIdx) => {
    let maxLen = 0;
    for (let r = 0; r < wsData.length; r++) {
      const val = wsData[r][colIdx];
      if (val !== undefined && val !== null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    }
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
  });
  ws["!cols"] = wscols;

  XLSX.utils.book_append_sheet(wb, ws, "Sales Details");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return out;
}

function transformPurchasesToExcelBuffer(purchases) {
  const wsData = [
    [
      "Invoice No", "Invoice Date", "Supplier Name", "Supplier GSTIN", "Drug Code",
      "Generic Name", "Brand Name", "Strength", "Form", "Batch Number", 
      "Expiry Date", "Quantity", "Purchase Price (Unit)", "MRP", "GST Rate %",
      "CGST Amount", "SGST Amount", "Taxable Amount", "Landed Total"
    ]
  ];

  purchases.forEach(invoice => {
    const invoiceDateStr = invoice.invoiceDate || "—";
    (invoice.items || []).forEach(item => {
      const qty = item.quantity || 0;
      const rate = item.purchasePrice || 0;
      const gstRate = parseFloat(item.gstRate || 12);
      const subtotal = qty * rate;
      const taxable = subtotal / (1 + (gstRate / 100));
      const gstAmount = subtotal - taxable;

      wsData.push([
        invoice.invoiceNumber || "—",
        invoiceDateStr,
        invoice.supplierName || "—",
        invoice.supplierGstin || "—",
        item.drugCode || "—",
        item.genericName || "—",
        item.brandName || "—",
        item.strength || "—",
        item.form || "—",
        item.batchNumber || "—",
        item.expiryDate || "—",
        qty,
        rate,
        item.mrp || 0,
        `${gstRate}%`,
        +(gstAmount / 2).toFixed(2),
        +(gstAmount / 2).toFixed(2),
        +taxable.toFixed(2),
        +subtotal.toFixed(2)
      ]);
    });
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  const wscols = wsData[0].map((_, colIdx) => {
    let maxLen = 0;
    for (let r = 0; r < wsData.length; r++) {
      const val = wsData[r][colIdx];
      if (val !== undefined && val !== null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    }
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
  });
  ws["!cols"] = wscols;

  XLSX.utils.book_append_sheet(wb, ws, "Purchase Records");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return out;
}

function transformExpiryToExcelBuffer(items) {
  const sortedItems = [...items].sort((a, b) => {
    const sA = a.supplierName || "No Vendor Linked";
    const sB = b.supplierName || "No Vendor Linked";
    return sA.localeCompare(sB);
  });

  const wsData = [
    [
      "Linked Supplier Name", "Drug Code", "Generic Name", "Brand Name", "Strength", 
      "Form", "Batch Number", "Expiry Date", "Days to Expiry",
      "Current Stock Qty", "Unit Purchase Price", "Stock Value (Landed Cost)"
    ]
  ];

  sortedItems.forEach(item => {
    wsData.push([
      item.supplierName || "No Vendor Linked",
      item.drugCode || "—",
      item.genericName || "—",
      item.brandName || "—",
      item.strength || "—",
      item.form || "—",
      item.batchNumber || "—",
      item.expiryDate || "—",
      item.daysRemaining !== undefined ? item.daysRemaining : "Expired",
      item.quantity || 0,
      item.purchasePrice || 0,
      +((item.quantity || 0) * (item.purchasePrice || 0)).toFixed(2)
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  const wscols = wsData[0].map((_, colIdx) => {
    let maxLen = 0;
    for (let r = 0; r < wsData.length; r++) {
      const val = wsData[r][colIdx];
      if (val !== undefined && val !== null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    }
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
  });
  ws["!cols"] = wscols;

  XLSX.utils.book_append_sheet(wb, ws, "Expiry Return Worksheet");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return out;
}

function transformTaxToPDFBuffer(payload, callback, errCallback) {
  try {
    const { sales, storeInfo, filtersLabel } = payload;
    
    const taxableSum = sales.reduce((a, s) => a + (s.taxableAmount || 0), 0);
    const cgstSum = sales.reduce((a, s) => a + (s.cgstAmount || 0), 0);
    const sgstSum = sales.reduce((a, s) => a + (s.sgstAmount || 0), 0);
    const gstSum = sales.reduce((a, s) => a + (s.totalGst || 0), 0);
    const grandSum = sales.reduce((a, s) => a + (s.grandTotal || 0), 0);
    
    const slabs = { 0: { taxable: 0, gst: 0 }, 5: { taxable: 0, gst: 0 }, 12: { taxable: 0, gst: 0 }, 18: { taxable: 0, gst: 0 }, 28: { taxable: 0, gst: 0 } };
    sales.forEach(s => {
      (s.items || []).forEach(item => {
        const rate = item.gstRate || 0;
        if (slabs[rate] === undefined) slabs[rate] = { taxable: 0, gst: 0 };
        slabs[rate].taxable += item.taxableValue || 0;
        slabs[rate].gst += item.totalGst || 0;
      });
    });

    const slabRows = Object.entries(slabs)
      .filter(([_, d]) => d.taxable > 0 || d.gst > 0)
      .map(([rate, data]) => [
        { text: `${rate}% Slab`, fontSize: 8, bold: true },
        { text: `₹${data.taxable.toFixed(2)}`, fontSize: 8, alignment: "right" },
        { text: `₹${(data.gst / 2).toFixed(2)}`, fontSize: 8, alignment: "right" },
        { text: `₹${(data.gst / 2).toFixed(2)}`, fontSize: 8, alignment: "right" },
        { text: `₹${data.gst.toFixed(2)}`, fontSize: 8, alignment: "right", bold: true, color: "#1B7A4E" }
      ]);

    if (slabRows.length === 0) {
      slabRows.push([{ text: "No tax collections in this period.", colSpan: 5, fontSize: 8, alignment: "center", color: "#8A96A3" }, {}, {}, {}, {}]);
    }

    const docDefinition = {
      pageSize: "A4",
      pageMargins: [30, 30, 30, 40],
      footer: function(currentPage, pageCount) {
        return { text: `Page ${currentPage} of ${pageCount}`, alignment: 'center', fontSize: 8, color: '#8A96A3', margin: [0, 10, 0, 0] };
      },
      content: [
        {
          columns: [
            {
              text: (storeInfo?.name || "JANAUSHADHI PHARMACY").toUpperCase(),
              fontSize: 14,
              bold: true,
              color: "#0A2342"
            },
            {
              text: "GST TAX LEDGER REPORT",
              alignment: "right",
              fontSize: 12,
              bold: true,
              color: "#0D7377"
            }
          ]
        },
        {
          columns: [
            {
              text: [
                { text: `GSTIN: ${storeInfo?.gstin || "—"}\n`, fontSize: 8 },
                { text: `Lic No: ${storeInfo?.drugLicense || "—"}\n`, fontSize: 8 },
                { text: `Address: ${storeInfo?.address || "—"}`, fontSize: 8 }
              ]
            },
            {
              text: [
                { text: `Report Preset: `, bold: true }, `${filtersLabel}\n`,
                { text: `Generated At: `, bold: true }, `${new Date().toLocaleString("en-IN")}\n`
              ],
              alignment: "right",
              fontSize: 8
            }
          ],
          margin: [0, 8, 0, 12]
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 535, y2: 0, lineWidth: 1.5, strokeColor: "#0A2342" }], margin: [0, 0, 0, 14] },
        
        {
          columns: [
            {
              stack: [
                { text: "TOTAL SALES REVENUE", fontSize: 7, color: "#8A96A3", bold: true },
                { text: `₹${grandSum.toFixed(2)}`, fontSize: 13, bold: true, color: "#1565C0", margin: [0, 3, 0, 0] }
              ],
              margin: [0, 0, 6, 0]
            },
            {
              stack: [
                { text: "NET TAXABLE VALUE", fontSize: 7, color: "#8A96A3", bold: true },
                { text: `₹${taxableSum.toFixed(2)}`, fontSize: 13, bold: true, color: "#0A2342", margin: [0, 3, 0, 0] }
              ],
              margin: [3, 0, 3, 0]
            },
            {
              stack: [
                { text: "CGST COLLECTED (50%)", fontSize: 7, color: "#8A96A3", bold: true },
                { text: `₹${cgstSum.toFixed(2)}`, fontSize: 13, bold: true, color: "#14A085", margin: [0, 3, 0, 0] }
              ],
              margin: [3, 0, 3, 0]
            },
            {
              stack: [
                { text: "SGST COLLECTED (50%)", fontSize: 7, color: "#8A96A3", bold: true },
                { text: `₹${sgstSum.toFixed(2)}`, fontSize: 13, bold: true, color: "#14A085", margin: [6, 0, 0, 0] }
              ],
              margin: [6, 0, 0, 0]
            }
          ],
          margin: [0, 0, 0, 20]
        },

        { text: "GST TAX SLAB BREAKDOWN", fontSize: 9, bold: true, color: "#0A2342", margin: [0, 0, 0, 6] },
        {
          table: {
            headerRows: 1,
            widths: ["20%", "20%", "20%", "20%", "20%"],
            body: [
              [
                { text: "GST Rate Slab", fontSize: 8, bold: true, fillColor: "#F4F6F9" },
                { text: "Taxable Value (Net)", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" },
                { text: "CGST Collected", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" },
                { text: "SGST Collected", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" },
                { text: "Total GST Collected", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" }
              ],
              ...slabRows
            ]
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 1 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => "#CBD5E0",
            vLineColor: () => "#CBD5E0"
          },
          margin: [0, 0, 0, 20]
        },

        { text: "SALES BILLS RECORD SUMMARY", fontSize: 9, bold: true, color: "#0A2342", margin: [0, 0, 0, 6] },
        {
          table: {
            headerRows: 1,
            widths: ["15%", "15%", "25%", "15%", "15%", "15%"],
            body: [
              [
                { text: "Bill No", fontSize: 8, bold: true, fillColor: "#F4F6F9" },
                { text: "Date", fontSize: 8, bold: true, fillColor: "#F4F6F9" },
                { text: "Patient Name", fontSize: 8, bold: true, fillColor: "#F4F6F9" },
                { text: "Net Value", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" },
                { text: "Total GST", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" },
                { text: "Grand Total", fontSize: 8, bold: true, fillColor: "#F4F6F9", alignment: "right" }
              ],
              ...sales.map(s => {
                let dateStr = "—";
                if (s.createdAt) {
                  const d = s.createdAt.seconds ? new Date(s.createdAt.seconds * 1000) : new Date(s.createdAt);
                  dateStr = d.toLocaleDateString("en-IN");
                }
                return [
                  { text: s.billNumber || "—", fontSize: 7 },
                  { text: dateStr, fontSize: 7 },
                  { text: s.customerName || "Walk-in Patient", fontSize: 7 },
                  { text: `₹${(s.taxableAmount || 0).toFixed(2)}`, fontSize: 7, alignment: "right" },
                  { text: `₹${(s.totalGst || 0).toFixed(2)}`, fontSize: 7, alignment: "right" },
                  { text: `₹${(s.grandTotal || 0).toFixed(2)}`, fontSize: 7, alignment: "right", bold: true }
                ];
              })
            ]
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 1 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => "#CBD5E0",
            vLineColor: () => "#CBD5E0"
          }
        }
      ]
    };

    pdfMake.createPdf(docDefinition).getBuffer((buffer) => {
      callback(buffer);
    });
  } catch (err) {
    errCallback(err);
  }
}

function transformInvoiceToPDFBuffer(payload, callback, errCallback) {
  try {
    const { bill, storeInfo, logo, qrCode } = payload;
    
    let dateStrOnly = "—";
    if (bill.date || bill.createdAt) {
      const d = bill.date ? new Date(bill.date) : (bill.createdAt.seconds ? new Date(bill.createdAt.seconds * 1000) : new Date(bill.createdAt));
      dateStrOnly = d.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
    }

    // Number to words utility
    function numberToWords(amount) {
      const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
      const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
      
      function convertHelper(num) {
        if (num < 20) return ones[num];
        if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? " " + ones[num % 10] : "");
        if (num < 1000) return ones[Math.floor(num / 100)] + " Hundred" + (num % 100 ? " and " + convertHelper(num % 100) : "");
        if (num < 100000) return convertHelper(Math.floor(num / 1000)) + " Thousand" + (num % 1000 ? " " + convertHelper(num % 1000) : "");
        if (num < 10000000) return convertHelper(Math.floor(num / 100000)) + " Lakh" + (num % 100000 ? " " + convertHelper(num % 100000) : "");
        return convertHelper(Math.floor(num / 10000000)) + " Crore" + (num % 10000000 ? " " + convertHelper(num % 10000000) : "");
      }
      
      const totalVal = Math.round(amount);
      if (totalVal === 0) return "Zero Rupees Only";
      return convertHelper(totalVal) + " Rupees Only";
    }

    let totalQty = 0;
    let totalTaxableVal = 0;
    let totalCgstAmt = 0;
    let totalSgstAmt = 0;
    let totalFinalAmt = 0;

    const itemRows = (bill.items || []).map((item, idx) => {
      const qty = parseInt(item.quantity || item.qty || 1);
      const gstRate = parseFloat(item.gstRate || 12);
      const itemTotal = parseFloat(item.total || 0);

      const gstFraction = gstRate / 100;
      const taxableValue = itemTotal / (1 + gstFraction); // Taxable value (Amount)
      const rate = taxableValue / qty; // Taxable rate (Rate)
      
      const cgstAmount = taxableValue * (gstRate / 2) / 100;
      const sgstAmount = taxableValue * (gstRate / 2) / 100;
      
      totalQty += qty;
      totalTaxableVal += taxableValue;
      totalCgstAmt += cgstAmount;
      totalSgstAmt += sgstAmount;
      totalFinalAmt += itemTotal;

      const name = item.brandName || item.genericName || "";
      const genericStr = item.genericName && item.genericName !== item.brandName ? ` (${item.genericName})` : "";
      const codePrefix = item.drugCode ? `[${item.drugCode}] ` : "";
      const desc = `${codePrefix}${name}${genericStr}`;

      // Retrieve Batch Number and Expiry Date
      let batchNo = "—";
      let expDate = "—";
      if (item.batchesUsed && item.batchesUsed.length > 0) {
        batchNo = item.batchesUsed.map(b => b.batchNumber || "—").join(", ");
        expDate = item.batchesUsed.map(b => b.expiryDate || "—").join(", ");
      } else if (item.batchNumber) {
        batchNo = item.batchNumber;
        expDate = item.expiryDate || "—";
      }

      const mrpVal = parseFloat(item.mrp || item.originalMrp || item.sellingPrice || 0);
      const discountVal = parseFloat(item.discount || 0);

      return [
        { text: `${idx + 1}.`, fontSize: 6.5, alignment: "center" },
        { text: desc, fontSize: 6.5, bold: true },
        { text: item.hsn || "3004", fontSize: 6.5, alignment: "center" },
        { text: batchNo, fontSize: 6.5, alignment: "center" },
        { text: expDate, fontSize: 6.5, alignment: "center" },
        { text: qty, fontSize: 6.5, alignment: "center" },
        { text: mrpVal > 0 ? mrpVal.toFixed(2) : "—", fontSize: 6.5, alignment: "right" },
        { text: discountVal > 0 ? `${discountVal}%` : "—", fontSize: 6.5, alignment: "right" },
        { text: `${gstRate}%`, fontSize: 6.5, alignment: "center" },
        { text: taxableValue.toFixed(2), fontSize: 6.5, alignment: "right" },
        { text: cgstAmount.toFixed(2), fontSize: 6.5, alignment: "right" },
        { text: sgstAmount.toFixed(2), fontSize: 6.5, alignment: "right" },
        { text: itemTotal.toFixed(2), fontSize: 6.5, alignment: "right", bold: true }
      ];
    });

    const totalRow = [
      { text: "Total", colSpan: 2, fontSize: 7.5, bold: true },
      {},
      { text: "", fontSize: 6.5 },
      { text: "", fontSize: 6.5 },
      { text: "", fontSize: 6.5 },
      { text: totalQty, fontSize: 7.5, bold: true, alignment: "center" },
      { text: "", fontSize: 6.5 },
      { text: "", fontSize: 6.5 },
      { text: "", fontSize: 6.5 },
      { text: `₹${totalTaxableVal.toFixed(2)}`, fontSize: 7.5, bold: true, alignment: "right" },
      { text: `₹${totalCgstAmt.toFixed(2)}`, fontSize: 6.5, alignment: "right" },
      { text: `₹${totalSgstAmt.toFixed(2)}`, fontSize: 6.5, alignment: "right" },
      { text: `₹${totalFinalAmt.toFixed(2)}`, fontSize: 7.5, bold: true, alignment: "right", color: "#1B7A4E" }
    ];

    const docDefinition = {
      pageSize: "A4",
      pageMargins: [30, 30, 30, 35],
      content: [
        {
          columns: [
            logo ? { image: logo, width: 60, height: 60 } : { text: "" },
            { text: "Sales Invoice", alignment: "right", fontSize: 20, bold: true, color: "#0A2342", margin: [0, 15, 0, 0] }
          ]
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 535, y2: 0, lineWidth: 1.0, strokeColor: "#0A2342" }], margin: [0, 8, 0, 8] },
        {
          table: {
            widths: ["32%", "40%", "28%"],
            body: [
              [
                {
                  stack: [
                    { text: [ { text: "Invoice No #: ", bold: true }, bill.billNumber || "—" ] },
                    { text: [ { text: "Invoice Date: ", bold: true }, dateStrOnly ] },
                    { text: [ { text: "Due Date:     ", bold: true }, dateStrOnly ] },
                    bill.doctorName ? { text: [ { text: "Doctor:       ", bold: true }, bill.doctorName ] } : null,
                    bill.prescriptionNo ? { text: [ { text: "Prescr. No:   ", bold: true }, bill.prescriptionNo ] } : null
                  ].filter(Boolean),
                  fontSize: 7.5,
                  lineHeight: 1.2
                },
                {
                  stack: [
                    { text: "Billed By", bold: true, fontSize: 8, color: "#0D7377" },
                    { text: storeInfo.name || "Pradhan Mantri Bharatiya Janaushadhi Kendra", bold: true },
                    { text: storeInfo.address || "Taluk General Hospital Premises, Honnalli - Ranebennur,\nState Highway, Ranebennur, Karnataka - 581115" },
                    { text: `Phone: ${storeInfo.phone || "+91 9964382376"}` }
                  ],
                  fontSize: 7.5,
                  lineHeight: 1.2
                },
                {
                  stack: [
                    { text: "Billed To", bold: true, fontSize: 8, color: "#0D7377" },
                    { text: bill.customerName || "Walk-in Patient", bold: true },
                    { text: "India" },
                    bill.customerPhone ? { text: `Phone: ${bill.customerPhone}` } : ""
                  ].filter(Boolean),
                  fontSize: 7.5,
                  lineHeight: 1.2
                }
              ]
            ]
          },
          layout: {
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
            hLineColor: () => "#000000",
            vLineColor: () => "#000000"
          },
          margin: [0, 0, 0, 12]
        },
        {
          table: {
            headerRows: 1,
            widths: [10, 155, 22, 38, 32, 14, 25, 18, 18, 35, 28, 28, 38],
            body: [
              [
                { text: "#", style: "th", alignment: "center" },
                { text: "Item Name", style: "th" },
                { text: "HSN", style: "th", alignment: "center" },
                { text: "Batch", style: "th", alignment: "center" },
                { text: "Expiry", style: "th", alignment: "center" },
                { text: "Qty", style: "th", alignment: "center" },
                { text: "MRP", style: "th", alignment: "right" },
                { text: "Disc", style: "th", alignment: "right" },
                { text: "GST", style: "th", alignment: "center" },
                { text: "Taxable", style: "th", alignment: "right" },
                { text: "CGST", style: "th", alignment: "right" },
                { text: "SGST", style: "th", alignment: "right" },
                { text: "Total", style: "th", alignment: "right" }
              ],
              ...itemRows,
              totalRow
            ]
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length - 1 || i === node.table.body.length ? 1 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => "#000000",
            vLineColor: () => "#000000",
            paddingLeft: () => 2,
            paddingRight: () => 2
          }
        },
        {
          columns: [
            {
              width: "60%",
              text: [
                { text: "Total (in words) : ", bold: true, fontSize: 8.5 },
                { text: numberToWords(totalFinalAmt), fontSize: 8.5, italic: true }
              ],
              margin: [0, 10, 0, 0]
            },
            {
              width: "40%",
              table: {
                widths: ["60%", "40%"],
                body: [
                  [{ text: "Amount", fontSize: 8, bold: true }, { text: `₹${totalTaxableVal.toFixed(2)}`, fontSize: 8, alignment: "right" }],
                  [{ text: "CGST", fontSize: 8, bold: true }, { text: `₹${totalCgstAmt.toFixed(2)}`, fontSize: 8, alignment: "right" }],
                  [{ text: "SGST", fontSize: 8, bold: true }, { text: `₹${totalSgstAmt.toFixed(2)}`, fontSize: 8, alignment: "right" }],
                  [{ text: "Discounts", fontSize: 8, bold: true }, { text: `₹${(bill.totalDiscount || 0).toFixed(2)}`, fontSize: 8, alignment: "right" }],
                  [{ text: "Total (INR)", fontSize: 9, bold: true, color: "#0A2342" }, { text: `₹${totalFinalAmt.toFixed(2)}`, fontSize: 9, bold: true, alignment: "right", color: "#1B7A4E" }]
                ]
              },
              layout: {
                hLineWidth: () => 0.5,
                vLineWidth: () => 0.5,
                hLineColor: () => "#000000",
                vLineColor: () => "#000000"
              },
              margin: [0, 8, 0, 0]
            }
          ],
          margin: [0, 0, 0, 15]
        },
        {
          columns: [
            {
              width: "60%",
              stack: [
                { text: "Terms and Conditions", bold: true, fontSize: 8.5, color: "#0A2342" },
                { text: "1. Interest will be charged @24% P.A. if bill remains unpaid within due date.", fontSize: 7.5, margin: [0, 3, 0, 0] },
                { text: "2. Subject To Ranebennur Jurisdictions.", fontSize: 7.5, margin: [0, 3, 0, 0] },
                { text: "3. Medicines once sold are cannot be taken back (or) exchanged.", fontSize: 7.5, margin: [0, 3, 0, 0] }
              ]
            },
            {
              width: "40%",
              alignment: "center",
              stack: [
                { text: "Scan to pay via UPI", bold: true, fontSize: 8.5, color: "#0D7377" },
                { text: "Maximum of 1 lakh can be transferred via upi in a single day", fontSize: 6.5, color: "#8A96A3", margin: [0, 1, 0, 4] },
                qrCode ? { image: qrCode, width: 80, height: 80 } : { text: "[QR Code Not Available]", fontSize: 7.5 },
                { text: "7676309842@jupiteraxis", fontSize: 7.5, bold: true, margin: [0, 4, 0, 0] }
              ]
            }
          ],
          margin: [0, 10, 0, 10]
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 535, y2: 0, lineWidth: 1.0, strokeColor: "#0A2342" }], margin: [0, 10, 0, 10] },
        {
          text: "For any enquiry, reach out via email at vishwapmbi@gmail.com, call on +91 9964382376",
          alignment: "center",
          fontSize: 8,
          color: "#4A5568",
          bold: true
        }
      ],
      styles: {
        th: {
          bold: true,
          fontSize: 6.5,
          fillColor: "#F4F6F9"
        }
      }
    };

    pdfMake.createPdf(docDefinition).getBuffer((buffer) => {
      callback(buffer);
    });
  } catch (err) {
    errCallback(err);
  }
}

function transformPmbiToExcelBuffer(payload) {
  const wsData = [
    [
      "Drug Code", "Drug Name", "Company Name", "Batch Number", 
      "Manufacturing Date", "Expiry Date", "MRP", "Purchase Rate", 
      "Selling Rate", "GST Rate %", "Discount %", "Qty Purchased", 
      "Qty Sold", "Current Stock", "Stock Value", "Supplier", 
      "Invoice Number", "Purchase Date"
    ]
  ];
  payload.forEach(item => {
    wsData.push([
      item.drugCode || "—",
      item.genericName || "—",
      item.companyName || "PMBI",
      item.batchNumber || "—",
      item.manufacturingDate || "—",
      item.expiryDate || "—",
      item.mrp || 0,
      item.purchasePrice || 0,
      item.sellingPrice || 0,
      item.gstRate || 0,
      item.discount || 0,
      item.qtyPurchased || 0,
      item.qtySold || 0,
      item.stockQty || 0,
      item.stockValue || 0,
      item.supplierName || "—",
      item.invoiceNumber || "—",
      item.purchaseDate || "—"
    ]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wscols = wsData[0].map((_, colIdx) => {
    let maxLen = 0;
    for (let r = 0; r < wsData.length; r++) {
      const val = wsData[r][colIdx];
      if (val !== undefined && val !== null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    }
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
  });
  ws["!cols"] = wscols;
  XLSX.utils.book_append_sheet(wb, ws, "PMBI Inventory Report");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function transformH1SalesToExcelBuffer(payload) {
  const wsData = [
    [
      "Sale Date", "Bill Number", "Patient Name", "Patient Phone", 
      "Doctor Name", "Prescription Number", "Drug Code", "Drug Name", 
      "Batch Number", "Expiry Date", "Qty Sold", "Rate", "Total (₹)"
    ]
  ];
  payload.forEach(item => {
    wsData.push([
      item.date || "—",
      item.billNumber || "—",
      item.customerName || "—",
      item.customerPhone || "—",
      item.doctorName || "—",
      item.prescriptionNo || "—",
      item.drugCode || "—",
      item.brandName || item.genericName || "—",
      item.batchNumber || "—",
      item.expiryDate || "—",
      item.qty || 0,
      item.sellingPrice || 0,
      item.total || 0
    ]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wscols = wsData[0].map((_, colIdx) => {
    let maxLen = 0;
    for (let r = 0; r < wsData.length; r++) {
      const val = wsData[r][colIdx];
      if (val !== undefined && val !== null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    }
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
  });
  ws["!cols"] = wscols;
  XLSX.utils.book_append_sheet(wb, ws, "H1 Sales Register");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function transformH1PurchasesToExcelBuffer(payload) {
  const wsData = [
    [
      "Purchase Date", "Invoice Number", "Supplier Name", "Supplier GSTIN", 
      "Supplier Phone", "Drug Code", "Drug Name", "Batch Number", 
      "Expiry Date", "Qty Purchased", "Purchase Rate", "Total (₹)"
    ]
  ];
  payload.forEach(item => {
    wsData.push([
      item.date || "—",
      item.invoiceNumber || "—",
      item.supplierName || "—",
      item.supplierGstin || "—",
      item.supplierPhone || "—",
      item.drugCode || "—",
      item.brandName || item.genericName || "—",
      item.batchNumber || "—",
      item.expiryDate || "—",
      item.qty || 0,
      item.purchasePrice || 0,
      item.total || 0
    ]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wscols = wsData[0].map((_, colIdx) => {
    let maxLen = 0;
    for (let r = 0; r < wsData.length; r++) {
      const val = wsData[r][colIdx];
      if (val !== undefined && val !== null) {
        maxLen = Math.max(maxLen, String(val).length);
      }
    }
    return { wch: Math.min(Math.max(maxLen + 2, 10), 30) };
  });
  ws["!cols"] = wscols;
  XLSX.utils.book_append_sheet(wb, ws, "H1 Purchases Register");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function transformPmbiToPDFBuffer(payload, callback, errCallback) {
  try {
    const { items, storeInfo } = payload;
    const stockValSum = items.reduce((a, s) => a + (s.stockValue || 0), 0);
    const docDefinition = {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: [20, 20, 20, 30],
      footer: function(currentPage, pageCount) {
        return { text: `Page ${currentPage} of ${pageCount}`, alignment: 'center', fontSize: 8, color: '#8A96A3', margin: [0, 10, 0, 0] };
      },
      content: [
        {
          columns: [
            { text: (storeInfo?.name || "JANAUSHADHI PHARMACY").toUpperCase(), fontSize: 12, bold: true, color: "#0A2342" },
            { text: "PMBI MEDICINES INVENTORY REPORT", alignment: "right", fontSize: 10, bold: true, color: "#0D7377" }
          ]
        },
        {
          text: `Generated: ${new Date().toLocaleString("en-IN")} | Total Stock Value: ₹${stockValSum.toFixed(2)}`,
          fontSize: 8,
          margin: [0, 4, 0, 8]
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 780, y2: 0, lineWidth: 1.0, strokeColor: "#0A2342" }], margin: [0, 0, 0, 10] },
        {
          table: {
            headerRows: 1,
            widths: ["8%", "18%", "8%", "8%", "8%", "7%", "7%", "5%", "6%", "6%", "7%", "12%"],
            body: [
              [
                { text: "Code", style: "th" },
                { text: "Drug Name", style: "th" },
                { text: "Batch", style: "th" },
                { text: "Expiry", style: "th" },
                { text: "MRP", style: "th", alignment: "right" },
                { text: "Pur. Rate", style: "th", alignment: "right" },
                { text: "Sel. Rate", style: "th", alignment: "right" },
                { text: "GST", style: "th", alignment: "center" },
                { text: "Purch Qty", style: "th", alignment: "center" },
                { text: "Sold Qty", style: "th", alignment: "center" },
                { text: "Stock", style: "th", alignment: "center" },
                { text: "Stock Val (₹)", style: "th", alignment: "right" }
              ],
              ...items.map(row => [
                { text: row.drugCode || "—", fontSize: 7 },
                { text: row.genericName || "—", fontSize: 7, bold: true },
                { text: row.batchNumber || "—", fontSize: 7 },
                { text: row.expiryDate || "—", fontSize: 7 },
                { text: (row.mrp || 0).toFixed(2), fontSize: 7, alignment: "right" },
                { text: (row.purchasePrice || 0).toFixed(2), fontSize: 7, alignment: "right" },
                { text: (row.sellingPrice || 0).toFixed(2), fontSize: 7, alignment: "right" },
                { text: `${row.gstRate || 0}%`, fontSize: 7, alignment: "center" },
                { text: row.qtyPurchased || 0, fontSize: 7, alignment: "center" },
                { text: row.qtySold || 0, fontSize: 7, alignment: "center" },
                { text: row.stockQty || 0, fontSize: 7, alignment: "center", bold: true },
                { text: (row.stockValue || 0).toFixed(2), fontSize: 7, alignment: "right", bold: true, color: "#1B7A4E" }
              ])
            ]
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 1 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => "#CBD5E0",
            vLineColor: () => "#CBD5E0"
          }
        }
      ],
      styles: {
        th: { bold: true, fontSize: 7.5, fillColor: "#F4F6F9" }
      }
    };
    pdfMake.createPdf(docDefinition).getBuffer((buffer) => {
      callback(buffer);
    });
  } catch (err) {
    errCallback(err);
  }
}

function transformStockInventoryToExcelBuffer(items) {
  const wsData = [
    [
      "Drug Code", "Barcode", "Generic Name (Composition)", "Brand Name", "Form (UOM)",
      "Company / Manufacturer", "MRP", "Landed Purchase Price", "Selling Price",
      "GST Rate %", "Schedule H1 Compliance", "Total Stock Qty", "Landed Stock Value (₹)",
      "Batches Detail"
    ]
  ];

  items.forEach(med => {
    const batchesStr = (med.batches || []).map(b => `${b.batchNumber} (Qty: ${b.quantity}, Exp: ${b.expiryDate})`).join(" | ");
    wsData.push([
      med.drugCode || "—",
      med.barcode || "—",
      med.genericName || "—",
      med.brandName || "—",
      med.form || "—",
      med.companyName || "—",
      med.mrp || 0,
      med.purchasePrice || 0,
      med.sellingPrice || 0,
      `${med.gstRate || 0}%`,
      med.isH1Drug ? "Yes" : "No",
      med.stockQty || 0,
      (med.stockQty || 0) * (med.purchasePrice || 0),
      batchesStr || "—"
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  const cols = [
    { wch: 12 }, { wch: 12 }, { wch: 35 }, { wch: 20 }, { wch: 10 },
    { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    { wch: 15 }, { wch: 12 }, { wch: 15 }, { wch: 45 }
  ];
  ws["!cols"] = cols;

  XLSX.utils.book_append_sheet(wb, ws, "Stock Inventory");
  const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return wbout;
}

function transformStockInventoryToPDFBuffer(payload, callback, errCallback) {
  try {
    const { items, storeInfo } = payload;
    const stockValSum = items.reduce((a, s) => a + (s.stockQty || 0) * (s.purchasePrice || 0), 0);
    const docDefinition = {
      pageSize: "A4",
      pageOrientation: "landscape",
      pageMargins: [20, 20, 20, 30],
      footer: function(currentPage, pageCount) {
        return { text: `Page ${currentPage} of ${pageCount}`, alignment: 'center', fontSize: 8, color: '#8A96A3', margin: [0, 10, 0, 0] };
      },
      content: [
        {
          columns: [
            { text: (storeInfo?.name || "JANAUSHADHI PHARMACY").toUpperCase(), fontSize: 12, bold: true, color: "#0A2342" },
            { text: "CURRENT STOCK INVENTORY REPORT", alignment: "right", fontSize: 10, bold: true, color: "#0D7377" }
          ]
        },
        {
          text: `Generated: ${new Date().toLocaleString("en-IN")} | Total Stock Valuation (Landed): ₹${stockValSum.toFixed(2)}`,
          fontSize: 8,
          margin: [0, 4, 0, 8]
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 780, y2: 0, lineWidth: 1.0, strokeColor: "#0A2342" }], margin: [0, 0, 0, 10] },
        {
          table: {
            headerRows: 1,
            widths: ["8%", "18%", "12%", "6%", "6%", "7%", "7%", "5%", "5%", "7%", "8%", "11%"],
            body: [
              [
                { text: "Code", style: "th" },
                { text: "Composition (Generic)", style: "th" },
                { text: "Brand Name", style: "th" },
                { text: "Form", style: "th" },
                { text: "MRP", style: "th", alignment: "right" },
                { text: "Pur. Price", style: "th", alignment: "right" },
                { text: "Sel. Price", style: "th", alignment: "right" },
                { text: "GST", style: "th", alignment: "center" },
                { text: "H1?", style: "th", alignment: "center" },
                { text: "Stock Qty", style: "th", alignment: "center" },
                { text: "Valuation (₹)", style: "th", alignment: "right" },
                { text: "Batches Detail", style: "th" }
              ],
              ...items.map(row => {
                const valuation = (row.stockQty || 0) * (row.purchasePrice || 0);
                const batchesStr = (row.batches || []).map(b => `${b.batchNumber}(${b.quantity})`).join(", ");
                return [
                  { text: row.drugCode || row.barcode || "—", fontSize: 7 },
                  { text: row.genericName || "—", fontSize: 7, bold: true },
                  { text: row.brandName || "—", fontSize: 7 },
                  { text: row.form || "—", fontSize: 7 },
                  { text: (row.mrp || 0).toFixed(2), fontSize: 7, alignment: "right" },
                  { text: (row.purchasePrice || 0).toFixed(2), fontSize: 7, alignment: "right" },
                  { text: (row.sellingPrice || 0).toFixed(2), fontSize: 7, alignment: "right" },
                  { text: `${row.gstRate || 0}%`, fontSize: 7, alignment: "center" },
                  { text: row.isH1Drug ? "Yes" : "No", fontSize: 7, alignment: "center", bold: row.isH1Drug, color: row.isH1Drug ? "#C0392B" : "#000" },
                  { text: row.stockQty || 0, fontSize: 7, alignment: "center", bold: true },
                  { text: valuation.toFixed(2), fontSize: 7, alignment: "right", bold: true, color: "#1B7A4E" },
                  { text: batchesStr || "—", fontSize: 7 }
                ];
              })
            ]
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === node.table.body.length ? 1 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => "#CBD5E0",
            vLineColor: () => "#CBD5E0"
          }
        }
      ],
      styles: {
        th: { bold: true, fontSize: 7.5, fillColor: "#F4F6F9" }
      }
    };
    pdfMake.createPdf(docDefinition).getBuffer((buffer) => {
      callback(buffer);
    });
  } catch (err) {
    errCallback(err);
  }
}
