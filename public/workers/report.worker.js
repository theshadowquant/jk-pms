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
    }
  } catch (error) {
    self.postMessage({ success: false, error: error.message, type });
  }
};

function transformSalesToExcelBuffer(sales) {
  const wsData = [
    [
      "Invoice No", "Date", "Customer Name", "Customer Phone",
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
      "Invoice No", "Invoice Date", "Supplier Name", "Supplier GSTIN",
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
      "Linked Supplier Name", "Generic Name", "Brand Name", "Strength", 
      "Form", "Batch Number", "Expiry Date", "Days to Expiry",
      "Current Stock Qty", "Unit Purchase Price", "Stock Value (Landed Cost)"
    ]
  ];

  sortedItems.forEach(item => {
    wsData.push([
      item.supplierName || "No Vendor Linked",
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
    const { bill, storeInfo } = payload;
    
    let dateStr = "—";
    if (bill.date || bill.createdAt) {
      const d = bill.date ? new Date(bill.date) : (bill.createdAt.seconds ? new Date(bill.createdAt.seconds * 1000) : new Date(bill.createdAt));
      dateStr = d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    }

    const docDefinition = {
      pageSize: "A5",
      pageOrientation: "landscape",
      pageMargins: [20, 20, 20, 20],
      content: [
        {
          columns: [
            {
              text: (storeInfo.name || "Janaushadhi Pharmacy").toUpperCase(),
              fontSize: 11,
              bold: true,
              color: "#0A2342"
            },
            {
              text: "TAX INVOICE / CASH MEMO",
              alignment: "right",
              fontSize: 10,
              bold: true,
              color: "#0D7377"
            }
          ]
        },
        {
          columns: [
            {
              text: [
                { text: `Lic No: ${storeInfo.drugLicense || "—"}\n`, fontSize: 7 },
                { text: `GSTIN: ${storeInfo.gstin || "—"}\n`, fontSize: 7 },
                { text: `Address: ${storeInfo.address || "—"}`, fontSize: 7 }
              ]
            },
            {
              text: [
                { text: `Invoice No: `, bold: true }, `${bill.billNumber || "—"}\n`,
                { text: `Date: `, bold: true }, `${dateStr}\n`,
                { text: `Payment: `, bold: true }, `${bill.paymentMode || "Cash"}`
              ],
              alignment: "right",
              fontSize: 7
            }
          ],
          margin: [0, 4, 0, 8]
        },
        { canvas: [{ type: "line", x1: 0, y1: 0, x2: 380, y2: 0, lineWidth: 1.0, strokeColor: "#0A2342" }], margin: [0, 0, 0, 6] },
        
        {
          columns: [
            { text: `Patient Name: ${bill.customerName || "Walk-in Patient"}`, fontSize: 7.5, bold: true },
            { text: `Contact Mobile: ${bill.customerPhone || "—"}`, fontSize: 7.5, alignment: "right" }
          ],
          margin: [0, 0, 0, 6]
        },
        
        {
          table: {
            headerRows: 1,
            widths: ["5%", "35%", "12%", "10%", "8%", "10%", "10%", "10%"],
            body: [
              [
                { text: "#", style: "th" },
                { text: "Medicine / Description", style: "th" },
                { text: "Batch", style: "th" },
                { text: "Expiry", style: "th" },
                { text: "Qty", style: "th", alignment: "right" },
                { text: "MRP", style: "th", alignment: "right" },
                { text: "Disc %", style: "th", alignment: "right" },
                { text: "Total", style: "th", alignment: "right" }
              ],
              ...(bill.items || []).map((item, idx) => {
                const batchNo = item.batchesUsed?.[0]?.batchNumber || item.batchNumber || "—";
                const expDate = item.batchesUsed?.[0]?.expiryDate || item.expiryDate || "—";
                return [
                  { text: idx + 1, fontSize: 6.5 },
                  { text: `${item.brandName || item.genericName}`, fontSize: 6.5, bold: true },
                  { text: batchNo, fontSize: 6.5 },
                  { text: expDate, fontSize: 6.5 },
                  { text: item.quantity || item.qty || 1, fontSize: 6.5, alignment: "right" },
                  { text: (item.mrp || 0).toFixed(2), fontSize: 6.5, alignment: "right" },
                  { text: `${item.discount || 0}%`, fontSize: 6.5, alignment: "right" },
                  { text: (item.total || 0).toFixed(2), fontSize: 6.5, alignment: "right", bold: true }
                ];
              })
            ]
          },
          layout: {
            hLineWidth: (i, node) => (i === 0 || i === 1 || i === node.table.body.length ? 1 : 0.5),
            vLineWidth: () => 0.5,
            hLineColor: () => "#dddddd",
            vLineColor: () => "#dddddd"
          }
        },
        
        {
          columns: [
            {
              text: "Terms & Conditions:\n1. Medicines once sold cannot be taken back.\n2. Verify batch and expiry before consumption.\n3. Subject to local jurisdiction.",
              fontSize: 5,
              color: "#8A96A3",
              margin: [0, 8, 0, 0]
            },
            {
              table: {
                widths: ["60%", "40%"],
                body: [
                  [{ text: "Sub Total:", fontSize: 7 }, { text: `₹${(bill.subtotal || 0).toFixed(2)}`, fontSize: 7, alignment: "right" }],
                  [{ text: "Discount:", fontSize: 7 }, { text: `₹${(bill.totalDiscount || 0).toFixed(2)}`, fontSize: 7, alignment: "right" }],
                  [{ text: "Taxable Amt:", fontSize: 6.5, color: "#666" }, { text: `₹${(bill.taxableAmount || 0).toFixed(2)}`, fontSize: 6.5, alignment: "right", color: "#666" }],
                  [{ text: "GST Total:", fontSize: 6.5, color: "#666" }, { text: `₹${(bill.totalGst || 0).toFixed(2)}`, fontSize: 6.5, alignment: "right", color: "#666" }],
                  [{ text: "Grand Total:", fontSize: 8.5, bold: true, color: "#0A2342" }, { text: `₹${(bill.grandTotal || 0).toFixed(2)}`, fontSize: 8.5, bold: true, alignment: "right", color: "#0A2342" }]
                ]
              },
              layout: "noBorders",
              margin: [0, 4, 0, 0]
            }
          ]
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
