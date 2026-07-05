"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

function InvoiceViewerContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id");
  const [bill, setBill] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) {
      setError("Missing Invoice ID in URL parameters.");
      setLoading(false);
      return;
    }

    const fetchBill = async () => {
      try {
        const docRef = doc(db, "sales", id);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
          setBill({ id: snap.id, ...snap.data() });
        } else {
          setError("Invoice not found or has been canceled.");
        }
      } catch (err) {
        console.error("Failed to load invoice:", err);
        setError("Error fetching invoice from database: " + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchBill();
  }, [id]);

  if (loading) {
    return (
      <div style={styles.center}>
        <div style={styles.spinner} />
        <div style={{ marginTop: 12, color: "#8A96A3", fontWeight: 600 }}>Loading Digital Invoice...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.center}>
        <div style={{ fontSize: 48 }}>⚠️</div>
        <div style={{ marginTop: 12, color: "#C0392B", fontWeight: 700, fontSize: 16 }}>{error}</div>
      </div>
    );
  }

  // Formatting dates
  let dateStrOnly = "—";
  if (bill.createdAt) {
    const d = bill.createdAt.toDate ? bill.createdAt.toDate() : new Date(bill.createdAt);
    dateStrOnly = d.toLocaleDateString("en-IN", { month: "short", day: "numeric", year: "numeric" });
  }

  // Number to words helper
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

  const roundPaisa = (val) => {
    const floorVal = Math.floor(val);
    const frac = val - floorVal;
    const fracRounded = Math.round(frac * 100) / 100;
    if (fracRounded >= 0.1) {
      return Math.ceil(val);
    }
    return floorVal;
  };

  let totalQty = 0;
  let totalTaxableVal = 0;
  let totalCgstAmt = 0;
  let totalSgstAmt = 0;
  let totalFinalAmt = 0;

  const processedItems = (bill.items || []).map((item) => {
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

    // Retrieve batchNumber and expiryDate
    let batchNumber = "—";
    let expiryDate = "—";
    if (item.batchesUsed && item.batchesUsed.length > 0) {
      batchNumber = item.batchesUsed.map(b => b.batchNumber || "—").join(", ");
      expiryDate = item.batchesUsed.map(b => b.expiryDate || "—").join(", ");
    } else if (item.batchNumber) {
      batchNumber = item.batchNumber;
      expiryDate = item.expiryDate || "—";
    }

    const mrp = parseFloat(item.mrp || item.originalMrp || item.sellingPrice || 0);
    const discount = parseFloat(item.discount || 0);

    return {
      ...item,
      qty,
      gstRate,
      rate,
      taxableValue,
      cgstAmount,
      sgstAmount,
      itemTotal,
      batchNumber,
      expiryDate,
      mrp,
      discount
    };
  });

  const roundedGrandTotal = bill.grandTotal || roundPaisa(totalFinalAmt);
  const roundOffAmount = typeof bill.roundOff === "number" ? bill.roundOff : (roundedGrandTotal - totalFinalAmt);

  const upiPayUri = `upi://pay?pa=7676309842@jupiteraxis&pn=Pradhan%20Mantri%20Bharatiya%20Janaushadhi%20Kendra&am=${roundedGrandTotal.toFixed(2)}&cu=INR`;
  const upiQrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(upiPayUri)}`;

  return (
    <div style={styles.container}>
      <div style={styles.invoiceCard}>
        {/* Top Header */}
        <div style={styles.header}>
          <img src="/logo.jpg" alt="PMBJP Logo" style={styles.logoImg} />
          <div style={styles.invoiceTitle}>Sales Invoice</div>
        </div>

        {/* Metadata Grid */}
        <div style={styles.metaTable}>
          {/* Col 1 */}
          <div style={styles.metaCell}>
            <div><strong>Invoice No #:</strong> {bill.billNumber || "—"}</div>
            <div style={{ marginTop: 6 }}><strong>Invoice Date:</strong> {dateStrOnly}</div>
            <div style={{ marginTop: 6 }}><strong>Due Date:</strong> {dateStrOnly}</div>
            {bill.doctorName && <div style={{ marginTop: 6 }}><strong>Doctor:</strong> {bill.doctorName}</div>}
            {bill.prescriptionNo && <div style={{ marginTop: 6 }}><strong>Prescr. No:</strong> {bill.prescriptionNo}</div>}
          </div>
          {/* Col 2 */}
          <div style={styles.metaCell}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#0D7377", marginBottom: 3 }}>Billed By</div>
            <div style={{ fontWeight: 700 }}>Pradhan Mantri Bharatiya Janaushadhi Kendra</div>
            <div style={{ fontSize: 10, color: "#4A5568", marginTop: 2, lineHeight: 1.3 }}>
              Taluk General Hospital Premises, Honnalli - Ranebennur<br />
              State Highway, Ranebennur, Karnataka - 581115
            </div>
            <div style={{ marginTop: 4 }}><strong>Phone:</strong> +91 9964382376</div>
          </div>
          {/* Col 3 */}
          <div style={{ ...styles.metaCell, borderRight: "none" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#0D7377", marginBottom: 3 }}>Billed To</div>
            <div style={{ fontWeight: 700 }}>{bill.customerName || "Walk-in Patient"}</div>
            <div style={{ fontSize: 10, color: "#4A5568", marginTop: 2 }}>India</div>
            {bill.customerPhone && <div style={{ marginTop: 4 }}><strong>Phone:</strong> {bill.customerPhone}</div>}
          </div>
        </div>

        {/* Items Table */}
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: "3%", textAlign: "center" }}>#</th>
              <th style={{ ...styles.th, width: "25%", textAlign: "left" }}>Item</th>
              <th style={{ ...styles.th, width: "6%", textAlign: "center" }}>HSN</th>
              <th style={{ ...styles.th, width: "10%", textAlign: "center" }}>Batch</th>
              <th style={{ ...styles.th, width: "8%", textAlign: "center" }}>Expiry</th>
              <th style={{ ...styles.th, width: "4%", textAlign: "center" }}>Qty</th>
              <th style={{ ...styles.th, width: "6%", textAlign: "right" }}>MRP</th>
              <th style={{ ...styles.th, width: "5%", textAlign: "right" }}>Disc</th>
              <th style={{ ...styles.th, width: "5%", textAlign: "center" }}>GST</th>
              <th style={{ ...styles.th, width: "8%", textAlign: "right" }}>Taxable</th>
              <th style={{ ...styles.th, width: "7%", textAlign: "right" }}>CGST</th>
              <th style={{ ...styles.th, width: "7%", textAlign: "right" }}>SGST</th>
              <th style={{ ...styles.th, width: "8%", textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {processedItems.map((item, idx) => (
              <tr key={idx} style={styles.tr}>
                <td style={{ ...styles.td, textAlign: "center" }}>{idx + 1}.</td>
                <td style={{ ...styles.td, fontWeight: 700, color: "#0A2342" }}>
                  {item.brandName || item.genericName}
                  {item.genericName && item.genericName !== item.brandName && (
                    <div style={styles.genericSub}>{item.genericName}</div>
                  )}
                </td>
                <td style={{ ...styles.td, textAlign: "center" }}>{item.hsn || "3004"}</td>
                <td style={{ ...styles.td, textAlign: "center" }}>{item.batchNumber}</td>
                <td style={{ ...styles.td, textAlign: "center" }}>{item.expiryDate}</td>
                <td style={{ ...styles.td, textAlign: "center" }}>{item.qty}</td>
                <td style={{ ...styles.td, textAlign: "right" }}>₹{item.mrp.toFixed(2)}</td>
                <td style={{ ...styles.td, textAlign: "right" }}>{item.discount > 0 ? `${item.discount}%` : "—"}</td>
                <td style={{ ...styles.td, textAlign: "center" }}>{item.gstRate}%</td>
                <td style={{ ...styles.td, textAlign: "right" }}>₹{item.taxableValue.toFixed(2)}</td>
                <td style={{ ...styles.td, textAlign: "right" }}>₹{item.cgstAmount.toFixed(2)}</td>
                <td style={{ ...styles.td, textAlign: "right" }}>₹{item.sgstAmount.toFixed(2)}</td>
                <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>₹{item.itemTotal.toFixed(2)}</td>
              </tr>
            ))}
            {/* Total Row */}
            <tr style={{ borderBottom: "1.5px solid #000" }}>
              <td colSpan={2} style={{ ...styles.td, fontWeight: 700, padding: "10px 8px" }}>Total</td>
              <td style={styles.td}></td>
              <td style={styles.td}></td>
              <td style={styles.td}></td>
              <td style={{ ...styles.td, textAlign: "center", fontWeight: 700 }}>{totalQty}</td>
              <td style={styles.td}></td>
              <td style={styles.td}></td>
              <td style={styles.td}></td>
              <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>₹{totalTaxableVal.toFixed(2)}</td>
              <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>₹{totalCgstAmt.toFixed(2)}</td>
              <td style={{ ...styles.td, textAlign: "right", fontWeight: 700 }}>₹{totalSgstAmt.toFixed(2)}</td>
              <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, color: "#1B7A4E" }}>₹{totalFinalAmt.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>

        {/* Summary Block */}
        <div style={styles.summaryGrid}>
          {/* Words */}
          <div style={styles.wordsBlock}>
            <strong>Total (in words) :</strong> <span style={{ italic: "true" }}>{numberToWords(roundedGrandTotal)}</span>
          </div>
          {/* Totals */}
          <div style={styles.totalsTableBlock}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                <tr style={styles.summaryTr}>
                  <td style={styles.summaryTdLabel}>Amount</td>
                  <td style={styles.summaryTdVal}>₹{totalTaxableVal.toFixed(2)}</td>
                </tr>
                <tr style={styles.summaryTr}>
                  <td style={styles.summaryTdLabel}>CGST</td>
                  <td style={styles.summaryTdVal}>₹{totalCgstAmt.toFixed(2)}</td>
                </tr>
                <tr style={styles.summaryTr}>
                  <td style={styles.summaryTdLabel}>SGST</td>
                  <td style={styles.summaryTdVal}>₹{totalSgstAmt.toFixed(2)}</td>
                </tr>
                <tr style={styles.summaryTr}>
                  <td style={styles.summaryTdLabel}>Discounts</td>
                  <td style={styles.summaryTdVal}>₹{(bill.totalDiscount || 0).toFixed(2)}</td>
                </tr>
                {roundOffAmount !== 0 && (
                  <tr style={styles.summaryTr}>
                    <td style={styles.summaryTdLabel}>Round Off</td>
                    <td style={styles.summaryTdVal}>₹{roundOffAmount.toFixed(2)}</td>
                  </tr>
                )}
                <tr style={{ ...styles.summaryTr, borderBottom: "none" }}>
                  <td style={{ ...styles.summaryTdLabel, fontWeight: 700, color: "#0A2342", fontSize: 13 }}>Total (INR)</td>
                  <td style={{ ...styles.summaryTdVal, fontWeight: 700, color: "#1B7A4E", fontSize: 14 }}>₹{roundedGrandTotal.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer & QR Block */}
        <div style={styles.footerGrid}>
          {/* Left Terms */}
          <div style={styles.termsBlock}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#0A2342", marginBottom: 6 }}>Terms and Conditions</div>
            <div style={styles.termLine}>1. Interest will be charged @24% P.A. if bill remains unpaid within due date.</div>
            <div style={styles.termLine}>2. Subject To Ranebennur Jurisdictions.</div>
            <div style={styles.termLine}>3. Medicines once sold are cannot be taken back (or) exchanged.</div>
          </div>
          {/* Right Scan */}
          <div style={styles.qrBlock}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "#0D7377" }}>Scan to pay via UPI</div>
            <div style={{ fontSize: 10, color: "#8A96A3", margin: "2px 0 6px 0" }}>Maximum of 1 lakh can be transferred via upi in a single day</div>
            <img src={upiQrSrc} alt="UPI Payment QR Code" style={styles.qrImg} />
            <div style={{ fontSize: 11, fontWeight: 700, color: "#0A2342", marginTop: 4 }}>7676309842@jupiteraxis</div>
          </div>
        </div>

        <div style={styles.bottomBorderLine} />

        {/* Bottom Contact Strip */}
        <div style={styles.contactStrip}>
          For any enquiry, reach out via email at <strong>vishwapmbi@gmail.com</strong>, call on <strong>+91 9964382376</strong>
        </div>

        {/* Print Button */}
        <button style={styles.printBtn} onClick={() => window.print()}>🖨️ Print Digital Invoice</button>
      </div>
    </div>
  );
}

export default function InvoiceViewerPage() {
  return (
    <Suspense fallback={
      <div style={styles.center}>
        <div style={styles.spinner} />
        <div style={{ marginTop: 12, color: "#8A96A3" }}>Initializing viewer...</div>
      </div>
    }>
      <InvoiceViewerContent />
    </Suspense>
  );
}

const styles = {
  center: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: "#F4F6F9",
    fontFamily: "system-ui, sans-serif"
  },
  spinner: {
    width: 32,
    height: 32,
    borderRadius: "50%",
    border: "3px solid #E2E8F0",
    borderTopColor: "#0D7377"
  },
  container: {
    background: "#F4F6F9",
    minHeight: "100vh",
    padding: "24px 16px",
    display: "flex",
    justifyContent: "center",
    fontFamily: "system-ui, sans-serif"
  },
  invoiceCard: {
    background: "#fff",
    border: "1.5px solid #000",
    borderRadius: 8,
    padding: 24,
    width: "100%",
    maxWidth: 800,
    boxShadow: "0 4px 20px rgba(0,0,0,0.03)"
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10
  },
  logoImg: {
    width: 60,
    height: 60,
    objectFit: "contain"
  },
  invoiceTitle: {
    fontSize: 24,
    fontWeight: 800,
    color: "#0A2342",
    letterSpacing: "-0.5px"
  },
  metaTable: {
    display: "grid",
    gridTemplateColumns: "30% 42% 28%",
    border: "1.5px solid #000",
    marginBottom: 14
  },
  metaCell: {
    borderRight: "1.5px solid #000",
    padding: 10,
    fontSize: 11,
    color: "#0A2342",
    lineHeight: 1.4
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    border: "1.5px solid #000",
    marginBottom: 14
  },
  th: {
    fontSize: 8.5,
    fontWeight: 700,
    color: "#0A2342",
    borderBottom: "1.5px solid #000",
    borderRight: "1px solid #000",
    padding: "6px 4px",
    background: "#F8FAFC"
  },
  tr: {
    borderBottom: "1px solid #000"
  },
  td: {
    padding: "6px 4px",
    fontSize: 9,
    color: "#0A2342",
    borderRight: "1px solid #000"
  },
  genericSub: {
    fontSize: 9,
    color: "#8A96A3",
    fontWeight: 400,
    marginTop: 2
  },
  summaryGrid: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 16
  },
  wordsBlock: {
    width: "58%",
    fontSize: 11,
    color: "#0A2342",
    lineHeight: 1.4,
    paddingTop: 8
  },
  totalsTableBlock: {
    width: "38%",
    border: "1.5px solid #000"
  },
  summaryTr: {
    borderBottom: "1px solid #000",
    display: "flex",
    justifyContent: "space-between"
  },
  summaryTdLabel: {
    padding: "6px 8px",
    fontSize: 11,
    fontWeight: 700,
    color: "#0A2342"
  },
  summaryTdVal: {
    padding: "6px 8px",
    fontSize: 11,
    fontWeight: 700,
    color: "#0A2342",
    textAlign: "right"
  },
  footerGrid: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 14
  },
  termsBlock: {
    width: "58%",
    fontSize: 11,
    color: "#0A2342"
  },
  termLine: {
    fontSize: 10,
    color: "#4A5568",
    marginTop: 4,
    lineHeight: 1.3
  },
  qrBlock: {
    width: "38%",
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center"
  },
  qrImg: {
    width: 90,
    height: 90,
    border: "1px solid #E2E8F0",
    padding: 4,
    borderRadius: 4
  },
  bottomBorderLine: {
    borderTop: "1.5px solid #000",
    margin: "12px 0 8px 0"
  },
  contactStrip: {
    textAlign: "center",
    fontSize: 11,
    color: "#4A5568",
    marginBottom: 16
  },
  printBtn: {
    background: "#0A2342",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    padding: "10px 18px",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
    textAlign: "center",
    transition: "background 0.12s"
  }
};

