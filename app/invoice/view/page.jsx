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

  const dateStr = bill.createdAt?.toDate 
    ? bill.createdAt.toDate().toLocaleString("en-IN") 
    : new Date(bill.createdAt || 0).toLocaleString("en-IN");

  return (
    <div style={styles.container}>
      <div style={styles.invoiceCard}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <div style={styles.storeName}>JANAUSHADHI PHARMACY</div>
            <div style={styles.storeDetails}>Pradhan Mantri Bhartiya Janaushadhi Pariyojana</div>
            <div style={styles.storeAddress}>Ranebennur · Helpline: 9964382376</div>
          </div>
          <div style={styles.badge}>DIGITAL MEMO</div>
        </div>

        <div style={styles.divider} />

        {/* Invoice Info */}
        <div style={styles.infoGrid}>
          <div>
            <div style={styles.infoLabel}>INVOICE NUMBER</div>
            <div style={styles.infoVal}>{bill.billNumber || "—"}</div>
          </div>
          <div>
            <div style={styles.infoLabel}>DATE & TIME</div>
            <div style={styles.infoVal}>{dateStr}</div>
          </div>
          <div>
            <div style={styles.infoLabel}>PAYMENT MODE</div>
            <div style={styles.infoVal}>{bill.paymentMode || "Cash"}</div>
          </div>
        </div>

        <div style={styles.divider} />

        {/* Patient / Doctor Info */}
        <div style={styles.infoGrid}>
          <div>
            <div style={styles.infoLabel}>PATIENT NAME</div>
            <div style={styles.infoVal}>{bill.customerName || "Walk-in Patient"}</div>
          </div>
          {bill.doctorName && (
            <div>
              <div style={styles.infoLabel}>PRESCRIBING DOCTOR</div>
              <div style={styles.infoVal}>{bill.doctorName}</div>
            </div>
          )}
          {bill.prescriptionNo && (
            <div>
              <div style={styles.infoLabel}>PRESCRIPTION NO</div>
              <div style={styles.infoVal}>{bill.prescriptionNo}</div>
            </div>
          )}
        </div>

        {/* Items Table */}
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, textAlign: "left" }}>Medicine Description</th>
              <th style={styles.th}>Batch</th>
              <th style={styles.th}>Expiry</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Qty</th>
              <th style={{ ...styles.th, textAlign: "right" }}>MRP</th>
              <th style={{ ...styles.th, textAlign: "right" }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {(bill.items || []).map((item, idx) => {
              const batchNo = item.batchesUsed?.[0]?.batchNumber || item.batchNumber || "—";
              const expDate = item.batchesUsed?.[0]?.expiryDate || item.expiryDate || "—";
              return (
                <tr key={idx} style={styles.tr}>
                  <td style={{ ...styles.td, fontWeight: 700, color: "#0A2342" }}>
                    {item.brandName || item.genericName}
                    <div style={styles.genericSub}>{item.genericName}</div>
                  </td>
                  <td style={styles.td}>{batchNo}</td>
                  <td style={styles.td}>{expDate}</td>
                  <td style={{ ...styles.td, textAlign: "right" }}>{item.quantity || item.qty}</td>
                  <td style={{ ...styles.td, textAlign: "right" }}>₹{(item.mrp || 0).toFixed(2)}</td>
                  <td style={{ ...styles.td, textAlign: "right", fontWeight: 700, color: "#1B7A4E" }}>
                    ₹{(item.total || 0).toFixed(2)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {/* Totals Section */}
        <div style={styles.totalsContainer}>
          <div style={styles.totalsTable}>
            <div style={styles.totalRow}>
              <span style={styles.totalLabel}>Sub Total:</span>
              <span style={styles.totalVal}>₹{(bill.subtotal || 0).toFixed(2)}</span>
            </div>
            {bill.totalDiscount > 0 && (
              <div style={styles.totalRow}>
                <span style={styles.totalLabel}>Discount:</span>
                <span style={styles.totalVal}>-₹{bill.totalDiscount.toFixed(2)}</span>
              </div>
            )}
            <div style={styles.totalRow}>
              <span style={{ ...styles.totalLabel, color: "#8A96A3" }}>Net Taxable:</span>
              <span style={{ ...styles.totalVal, color: "#8A96A3" }}>₹{(bill.taxableAmount || 0).toFixed(2)}</span>
            </div>
            <div style={styles.totalRow}>
              <span style={{ ...styles.totalLabel, color: "#8A96A3" }}>GST Total:</span>
              <span style={{ ...styles.totalVal, color: "#8A96A3" }}>₹{(bill.totalGst || 0).toFixed(2)}</span>
            </div>
            <div style={styles.divider} />
            <div style={{ ...styles.totalRow, padding: "8px 0" }}>
              <span style={{ ...styles.totalLabel, fontSize: 14, fontWeight: 700, color: "#0A2342" }}>GRAND TOTAL:</span>
              <span style={{ ...styles.totalVal, fontSize: 16, fontWeight: 700, color: "#1B7A4E" }}>₹{(bill.grandTotal || 0).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <div style={styles.divider} />

        {/* Footer */}
        <div style={styles.footer}>
          <div>Terms & Conditions:</div>
          <div>1. Medicines once sold cannot be taken back or refunded.</div>
          <div>2. This is a digital cash memo invoice powered by JK-PMS.</div>
          <button style={styles.printBtn} onClick={() => window.print()}>🖨️ Print Digital Invoice</button>
        </div>
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
    border: "1px solid #E2E8F0",
    borderRadius: 16,
    padding: 24,
    width: "100%",
    maxWidth: 680,
    boxShadow: "0 4px 20px rgba(0,0,0,0.03)"
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start"
  },
  storeName: {
    fontSize: 20,
    fontWeight: 800,
    color: "#0A2342"
  },
  storeDetails: {
    fontSize: 12,
    color: "#0D7377",
    fontWeight: 600,
    marginTop: 2
  },
  storeAddress: {
    fontSize: 11,
    color: "#8A96A3",
    marginTop: 2
  },
  badge: {
    background: "#E0F7F4",
    border: "1px solid #14A085",
    color: "#14A085",
    borderRadius: 20,
    padding: "4px 12px",
    fontSize: 11,
    fontWeight: 700
  },
  divider: {
    borderTop: "1px solid #E2E8F0",
    margin: "16px 0"
  },
  infoGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 12
  },
  infoLabel: {
    fontSize: 9,
    fontWeight: 700,
    color: "#8A96A3",
    letterSpacing: "0.5px"
  },
  infoVal: {
    fontSize: 13,
    fontWeight: 600,
    color: "#0A2342",
    marginTop: 2
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    marginTop: 20
  },
  th: {
    fontSize: 11,
    fontWeight: 700,
    color: "#8A96A3",
    borderBottom: "2px solid #E2E8F0",
    padding: "8px 0"
  },
  tr: {
    borderBottom: "1px solid #E2E8F0"
  },
  td: {
    padding: "10px 0",
    fontSize: 12,
    color: "#4A5568"
  },
  genericSub: {
    fontSize: 10,
    color: "#8A96A3",
    fontWeight: 400,
    marginTop: 2
  },
  totalsContainer: {
    display: "flex",
    justifyContent: "flex-end",
    marginTop: 16
  },
  totalsTable: {
    width: "100%",
    maxWidth: 240
  },
  totalRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "4px 0"
  },
  totalLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: "#4A5568"
  },
  totalVal: {
    fontSize: 12,
    fontWeight: 600,
    color: "#0A2342"
  },
  footer: {
    fontSize: 11,
    color: "#8A96A3",
    lineHeight: 1.5
  },
  printBtn: {
    marginTop: 16,
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
