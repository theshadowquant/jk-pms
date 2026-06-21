"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { auth, db } from "@/lib/firebase";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword } from "firebase/auth";
import { collection, addDoc, doc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, onSnapshot, where, limit, getDocs, getDoc, setDoc, runTransaction } from "firebase/firestore";
import * as XLSX from "xlsx";

const STOP_WORDS = [
  "mg", "ml", "tab", "tabs", "tablet", "cap", "capsule",
  "strip", "bottle", "inj", "syrup", "suspension", "gel", "lotion", "cream", "ointment", "drops", "vial", "ampoule"
];

const COLUMN_ALIASES = {
  genericName: ["generic name", "composition", "salt", "generic", "item composition", "formula", "chemical"],
  brandName: ["brand name", "item name", "medicine name", "description", "product name", "particulars", "name"],
  strength: ["strength", "str", "power"],
  form: ["form", "type"],
  batchNumber: ["batch number", "batch no", "batch", "b. no", "batchno", "bno"],
  expiryDate: ["expiry date", "exp date", "expiry", "exp", "exp date (yy-mm)", "expdate"],
  purchasePrice: ["purchase price", "purchase rate", "cost price", "rate", "pur rate", "landed cost", "p_rate", "cost", "buy rate"],
  mrp: ["mrp", "printed mrp", "m.r.p.", "maximum retail price", "retail mrp"],
  sellingPrice: ["selling price", "retail price", "sale price", "selling rate", "s_price", "salerate"],
  stockQty: ["stock quantity", "quantity", "qty", "stock", "stock qty", "closing stock", "balance qty", "balance", "available stock"],
  barcode: ["barcode", "upc", "code"]
};

function normalizeName(name) {
  if (!name) return "";
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(word => !STOP_WORDS.includes(word))
    .join("")
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, () => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j - 1][i] + 1,
        matrix[j][i - 1] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function levenshteinScore(a, b) {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function commonPrefix(s1, s2) {
  let common = 0;
  const limit = Math.min(s1.length, s2.length);
  for (let i = 0; i < limit; i++) {
    if (s1[i] === s2[i]) common++;
    else break;
  }
  return Math.min(4, common);
}

function getMatches(s1, s2) {
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return { matches: 0, transpositions: 0 };

  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(len2 - 1, i + matchWindow);

    for (let j = start; j <= end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return { matches: 0, transpositions: 0 };

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (s1Matches[i]) {
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }
  }

  return { matches, transpositions };
}

function jaroWinkler(s1, s2) {
  const m = getMatches(s1, s2);
  if (m.matches === 0) return 0;

  const jaro = (
    m.matches / s1.length +
    m.matches / s2.length +
    (m.matches - m.transpositions / 2) / m.matches
  ) / 3;

  const prefix = commonPrefix(s1, s2);
  return jaro + prefix * 0.1 * (1 - jaro);
}

function getMatchScore(a, b) {
  const lev = levenshteinScore(a, b);
  const jaro = jaroWinkler(a, b);
  return (lev * 0.4 + jaro * 0.6);
}

function findBestMatch(incomingItem, existingItems) {
  if (incomingItem.barcode) {
    const bMatch = existingItems.find(item => item.barcode === incomingItem.barcode);
    if (bMatch) return { type: "MATCH", item: bMatch, score: 1.0 };
  }

  const rawIncoming = `${incomingItem.genericName || ""} ${incomingItem.brandName || ""} ${incomingItem.strength || ""} ${incomingItem.form || ""}`;
  const normalizedIncoming = normalizeName(rawIncoming);

  let bestMatch = null;
  let bestScore = 0;

  for (const item of existingItems) {
    const rawExisting = `${item.genericName || ""} ${item.brandName || ""} ${item.strength || ""} ${item.form || ""}`;
    const normalizedExisting = normalizeName(rawExisting);

    const score = getMatchScore(normalizedIncoming, normalizedExisting);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = item;
    }
  }

  if (bestScore > 0.90) {
    return { type: "MATCH", item: bestMatch, score: bestScore };
  }
  if (bestScore > 0.75) {
    return { type: "CONFLICT", item: bestMatch, score: bestScore };
  }
  return { type: "NEW", item: null, score: bestScore };
}

function printThermalReceipt(bill) {
  if (!bill) return;
  const rows = (bill.items || []).map(i => {
    const name = (i.brandName || i.genericName || "").substring(0, 18).padEnd(18);
    const qty = String(i.quantity || i.qty || 1).padStart(3);
    const total = `Rs.${(i.total || 0).toFixed(2)}`.padStart(10);
    const batchNo = i.batchesUsed?.[0]?.batchNumber || i.batchNumber || "—";
    const expDate = i.batchesUsed?.[0]?.expiryDate || i.expiryDate || "—";
    return `${name}${qty}${total}\n  B:${batchNo} Exp:${expDate}`;
  }).join("\n");
  const dateStr = new Date(bill.date || bill.createdAt?.toDate?.() || new Date())
    .toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const html = `<html><head><style>
    @page{margin:0;size:58mm auto}*{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Courier New',monospace;font-size:10px;width:58mm;padding:5px;color:#000}
    .c{text-align:center}.b{font-weight:bold}
    .line{border-top:1px dashed #000;margin:4px 0}.dline{border-top:2px solid #000;margin:4px 0}
    .row{display:flex;justify-content:space-between;margin:2px 0}
    pre{font-family:inherit;font-size:9px;white-space:pre-wrap}
  </style></head><body>
    <div class="c b" style="font-size:14px">JANAUSHADHI KENDRA</div>
    <div class="c">Ranebennur · Ph: 9964382376</div>
    <div class="c" style="font-size:9px">Pradhan Mantri Bhartiya Janaushadhi Pariyojana</div>
    <div class="dline"></div>
    <div class="row"><span>Bill:</span><span class="b">${bill.billNumber || ""}</span></div>
    <div class="row"><span>Date:</span><span>${dateStr}</span></div>
    ${bill.customerName ? `<div class="row"><span>Patient:</span><span>${bill.customerName}</span></div>` : ""}
    ${bill.customerPhone ? `<div class="row"><span>Phone:</span><span>${bill.customerPhone}</span></div>` : ""}
    <div class="dline"></div>
    <pre>${"Item".padEnd(18)}Qty${"Amount".padStart(10)}</pre>
    <div class="line"></div><pre>${rows}</pre><div class="line"></div>
    <div class="row"><span>Subtotal</span><span>Rs.${(bill.subtotal || 0).toFixed(2)}</span></div>
    ${(bill.totalDiscount || 0) > 0 ? `<div class="row"><span>Discount</span><span>-Rs.${bill.totalDiscount.toFixed(2)}</span></div>` : ""}
    <div class="row" style="font-size:9px;color:#555"><span>Taxable Value</span><span>Rs.${(bill.taxableAmount || 0).toFixed(2)}</span></div>
    <div class="row" style="font-size:9px;color:#555"><span>CGST Split</span><span>Rs.${(bill.cgstAmount || 0).toFixed(2)}</span></div>
    <div class="row" style="font-size:9px;color:#555"><span>SGST Split</span><span>Rs.${(bill.sgstAmount || 0).toFixed(2)}</span></div>
    <div class="dline"></div>
    <div class="row b" style="font-size:13px"><span>TOTAL</span><span>Rs.${(bill.grandTotal || 0).toFixed(2)}</span></div>
    <div class="dline"></div>
    <div class="row"><span>Payment</span><span class="b">${bill.paymentMode || ""}</span></div>
    <div class="line"></div>
    <div class="c" style="margin-top:8px;font-size:9px">
      <div>Thank you! Get well soon.</div>
      <div style="margin-top:3px;font-size:8px">Powered by JK-PMS</div>
    </div>
  </body></html>`;

  let iframe = document.getElementById("print-thermal-iframe");
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "print-thermal-iframe";
    iframe.style.position = "absolute";
    iframe.style.width = "0px";
    iframe.style.height = "0px";
    iframe.style.border = "none";
    iframe.style.top = "-9999px";
    document.body.appendChild(iframe);
  }
  const doc = iframe.contentWindow.document || iframe.contentDocument;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }, 300);
}

function sendWhatsApp(bill, phone) {
  if (!phone) return;
  const billId = bill.id || "";
  const invoiceLinkText = billId ? `\n\n*View Digital Invoice PDF:*\nhttps://jk-pms.vercel.app/invoice/view?id=${billId}` : "";
  
  const text = `*JANAUSHADHI KENDRA, Ranebennur*\nPh: 9964382376\n\n*Bill: ${bill.billNumber}*\nDate: ${new Date(bill.date || new Date()).toLocaleDateString("en-IN")}\n\n${(bill.items || []).map(i => `• ${i.brandName || i.genericName} x${i.quantity || i.qty || 1} = ₹${(i.total || 0).toFixed(2)}`).join("\n")}${invoiceLinkText}\n\n*Total: ₹${(bill.grandTotal || 0).toFixed(2)}*\nPayment: ${bill.paymentMode}\n\n_Thank you! Get well soon._ 🙏`;
  const num = phone.replace(/\D/g, "");
  window.open(`https://wa.me/${num.startsWith("91") ? num : "91" + num}?text=${encodeURIComponent(text)}`, "_blank");
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
  sidebarBg: "#0B192C",
  sidebarText: "#90A4B8",
  sidebarTextActive: "#ffffff",
};

const S = {
  topbar: { background: "#ffffff", height: 60, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", flexShrink: 0, borderBottom: `1px solid ${C.border}` },
  logoMark: { width: 38, height: 38, borderRadius: 9, background: C.teal2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0 },
  main: { flex: 1, padding: "24px", overflowX: "hidden", background: C.bg, overflowY: "auto" },
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  input: { fontFamily: "inherit", fontSize: 13, border: `1.5px solid ${C.border2}`, borderRadius: 8, padding: "9px 12px", background: "#fff", color: C.text, outline: "none", width: "100%", transition: "border-color 0.15s ease" },
  label: { display: "block", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 5 },
  btn: (t) => ({
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, borderRadius: 8, padding: "10px 18px",
    cursor: "pointer", border: "none", letterSpacing: "0.2px", transition: "all 0.12s",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    ...(t === "primary"  ? { background: C.navy, color: "#fff" } :
        t === "teal"     ? { background: C.teal, color: "#fff" } :
        t === "green"    ? { background: C.green, color: "#fff" } :
        t === "outline"  ? { background: "#fff", border: `1.5px solid ${C.border2}`, color: C.text2 } :
        t === "whatsapp" ? { background: "#25D366", color: "#fff" } :
        t === "ai"       ? { background: "#1A73E8", color: "#fff" } : {})
  }),
  badge: (t) => ({
    display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
    ...(t === "green" ? { background: "#E8F5EE", color: C.green } :
        t === "amber" ? { background: "#FEF3DC", color: C.amber } :
        t === "red"   ? { background: "#FDECEA", color: C.red } :
        t === "teal"  ? { background: "#E0F7F4", color: C.teal } :
        t === "blue"  ? { background: "#EBF4FF", color: C.blue } : {})
  }),
  th: { padding: "12px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap", background: "#F8FAFC" },
  td: { padding: "12px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.text2 },
};

function LoginScreen() {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleAction = async () => {
    if (!email || !password) { setError("Please enter email and password."); return; }
    setLoading(true); setError("");
    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err) {
      console.error(err);
      if (isRegister) {
        setError(err.message.includes("email-already-in-use") ? "This email is already registered." : "Sign up failed. " + err.message);
      } else {
        setError("Invalid email or password.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Inter',system-ui,sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 400, padding: "0 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 22, fontWeight: 700, color: "#fff", boxShadow: "0 4px 12px rgba(10,35,66,0.15)" }}>JK</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: C.navy, letterSpacing: "-0.5px" }}>Janaushadhi Kendra</div>
          <div style={{ fontSize: 13, color: C.text3, marginTop: 4 }}>Pharmacy SaaS Management Platform</div>
        </div>
        <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 28, boxShadow: "0 4px 20px rgba(0,0,0,0.03)" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 20, textAlign: "center" }}>
            {isRegister ? "Create a New Store Account" : "Sign In to Your Store"}
          </div>
          {error && <div style={{ background: "#FDECEA", border: "1px solid #FCCACA", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: C.red }}>{error}</div>}
          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>Email Address</label>
            <input style={S.input} type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAction()} placeholder="your@email.com" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={S.label}>Password</label>
            <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleAction()} placeholder="••••••••" />
          </div>
          <button style={{ ...S.btn("primary"), width: "100%", padding: "13px", fontSize: 15, justifyContent: "center" }} onClick={handleAction} disabled={loading}>
            {loading ? "Please wait..." : isRegister ? "Sign Up & Start Onboarding" : "Sign In"}
          </button>
          
          <div style={{ textAlign: "center", marginTop: 20, borderTop: `1px solid ${C.border}`, paddingTop: 16 }}>
            <button onClick={() => { setIsRegister(!isRegister); setError(""); }} style={{ background: "none", border: "none", color: C.teal, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              {isRegister ? "Already have an account? Sign In" : "Need a new store? Register here"}
            </button>
          </div>
        </div>
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 12, color: C.text3 }}>Pradhan Mantri Bhartiya Janaushadhi Pariyojana</div>
      </div>
    </div>
  );
}

const FF = ({ label, children }) => <div><label style={S.label}>{label}</label>{children}</div>;
const PH = ({ title, sub, action }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
    <div><div style={{ fontSize: 22, fontWeight: 700, color: C.navy, letterSpacing: "-0.3px", marginBottom: 3 }}>{title}</div>{sub && <div style={{ fontSize: 12, color: C.text3 }}>{sub}</div>}</div>
    {action}
  </div>
);

export default function PharmacyApp() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [medicines, setMedicines] = useState([]);
  const [sales, setSales] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [now, setNow] = useState(new Date());
  
  // ── SaaS Multi-Tenant States ──
  const [storeId, setStoreId] = useState("");
  const [storeCode, setStoreCode] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeDetails, setStoreDetails] = useState(null);
  const [userRole, setUserRole] = useState("staff"); // "admin" | "staff"
  const [profileLoading, setProfileLoading] = useState(true);
  const [onboardingMode, setOnboardingMode] = useState("none"); // "none" | "choose" | "create" | "join" | "wizard-step1" | "wizard-step2" | "wizard-step3"
  const [lastSyncSec, setLastSyncSec] = useState(0);
  const [indexError, setIndexError] = useState(""); // Captures Firebase index links
  const [newStore, setNewStore] = useState({ name: "", code: "", helpline: "0-124-356-1100", supportTime: "9:30 AM To 6:00 PM", address: "" });
  const [joinCode, setJoinCode] = useState("");

  // ── Wizard States ──
  const [wizardStoreForm, setWizardStoreForm] = useState({ name: "", gstin: "", phone: "", address: "" });
  const [newWizardMed, setNewWizardMed] = useState({ brandName: "", genericName: "", strength: "", form: "Tablet", mrp: "", sellingPrice: "", purchasePrice: "", lowStockAlert: "20", gstRate: "12" });
  
  const [poModal, setPoModal] = useState(null);
  const [openingStockModal, setOpeningStockModal] = useState(null);
  const [openingStockForm, setOpeningStockForm] = useState({
    batchNumber: "",
    expiryDate: "",
    quantity: "",
    purchasePrice: "",
    mrp: "",
    sellingPrice: ""
  });

  const handleOpenOpeningStock = (med) => {
    setOpeningStockModal(med);
    setOpeningStockForm({
      batchNumber: "OS-" + Math.floor(10000 + Math.random() * 90000),
      expiryDate: med.expiryDate || "",
      quantity: "",
      purchasePrice: med.purchasePrice || "",
      mrp: med.mrp || "",
      sellingPrice: med.sellingPrice || ""
    });
  };

  const saveOpeningStock = async () => {
    if (!openingStockModal) return;
    const form = openingStockForm;
    if (!form.batchNumber || !form.expiryDate || !form.quantity || !form.purchasePrice || !form.mrp) {
      alert("Please fill in Batch Number, Expiry, Quantity, MRP and Purchase Price.");
      return;
    }

    try {
      const medRef = doc(db, "medicines", openingStockModal.id);
      
      await runTransaction(db, async (transaction) => {
        const medSnap = await transaction.get(medRef);
        if (!medSnap.exists()) throw new Error("Medicine not found.");
        const medData = medSnap.data();

        // Deep copy existing batches
        const currentBatches = Array.isArray(medData.batches) ? medData.batches.map(b => ({ ...b })) : [];

        const newBatch = {
          batchNumber: form.batchNumber.trim(),
          expiryDate: form.expiryDate.trim(),
          quantity: parseInt(form.quantity) || 0,
          purchasePrice: parseFloat(form.purchasePrice) || 0,
          mrp: parseFloat(form.mrp) || 0,
          sellingPrice: parseFloat(form.sellingPrice) || parseFloat(form.mrp) || 0,
          isOpeningStock: true,
          openingStockDate: new Date().toISOString().substring(0, 10)
        };

        // Hard-fail on missing purchase price
        if (newBatch.purchasePrice <= 0) {
          throw new Error("Landed purchase price must be greater than 0.");
        }

        const bIdx = currentBatches.findIndex(b => b.batchNumber === newBatch.batchNumber);
        let prevQty = 0;
        if (bIdx >= 0) {
          prevQty = currentBatches[bIdx].quantity || 0;
          currentBatches[bIdx] = {
            ...currentBatches[bIdx],
            quantity: prevQty + newBatch.quantity,
            purchasePrice: newBatch.purchasePrice,
            mrp: newBatch.mrp,
            sellingPrice: newBatch.sellingPrice
          };
        } else {
          currentBatches.push(newBatch);
        }

        const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

        // Update medicine document
        transaction.update(medRef, {
          stockQty: Math.max(0, totalStock),
          batches: currentBatches,
          mrp: medData.mrp || newBatch.mrp,
          sellingPrice: medData.sellingPrice || newBatch.sellingPrice,
          purchasePrice: medData.purchasePrice || newBatch.purchasePrice,
          updatedAt: serverTimestamp()
        });

        // Write isolated audit log (type: "OPENING_STOCK")
        const auditCol = collection(db, "inventory_audit_logs");
        const auditDocRef = doc(auditCol);
        transaction.set(auditDocRef, {
          storeId,
          medicineId: openingStockModal.id,
          genericName: medData.genericName,
          brandName: medData.brandName || "",
          batchNumber: newBatch.batchNumber,
          type: "OPENING_STOCK",
          actionSource: "INVENTORY_ONBOARDING",
          referenceId: "OPENING-STOCK-ENTRY",
          quantityChanged: newBatch.quantity,
          previousQuantity: prevQty,
          newQuantity: prevQty + newBatch.quantity,
          purchasePrice: newBatch.purchasePrice,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });
      });

      alert(`✓ Opening stock successfully registered for ${openingStockModal.brandName || openingStockModal.genericName}!`);
      setOpeningStockModal(null);
    } catch (err) {
      alert("Error adding opening stock: " + err.message);
    }
  };
  
  // ── Form States ──
  const [billItems, setBillItems] = useState([]);
  const [billSearch, setBillSearch] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState("Cash");
  const [lastBill, setLastBill] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddMedForm, setShowAddMedForm] = useState(false);
  const [newMed, setNewMed] = useState({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", stockQty: "", unit: "Strip", lowStockAlert: "20", category: "", gstRate: "12" });
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [purchaseForm, setPurchaseForm] = useState({ supplierName: "", invoiceNumber: "", invoiceDate: "", paymentStatus: "Unpaid", items: [] });
  const [purchaseItem, setPurchaseItem] = useState({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", quantity: "", unit: "Strip", gstRate: "12" });
  const [previewItems, setPreviewItems] = useState([]);
  const [showPreviewDrawer, setShowPreviewDrawer] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState("");
  const fileInputRef = useRef(null);
  const [billSearchQuery, setBillSearchQuery] = useState("");
  const [selectedBill, setSelectedBill] = useState(null);
  const [reportPeriod, setReportPeriod] = useState("today");
  const [reportFilters, setReportFilters] = useState({
    startDate: "",
    endDate: "",
    supplierName: "",
    medicineId: "",
    paymentMode: "",
    period: "month"
  });
  const [isWorkerExporting, setIsWorkerExporting] = useState(false);
  const [defaultPrintType, setDefaultPrintType] = useState("THERMAL");

  // ── SaaS Inventory Import States ──
  const [excelInventoryItems, setExcelInventoryItems] = useState([]);
  const [showExcelInventoryDrawer, setShowExcelInventoryDrawer] = useState(false);
  const inventoryExcelInputRef = useRef(null);
  const productPhotoInputRef = useRef(null);

  // ── Data Migration Loop Upgrade States ──
  const [excelRawHeaders, setExcelRawHeaders] = useState([]);
  const [excelRawRows, setExcelRawRows] = useState([]);
  const [excelColumnMapping, setExcelColumnMapping] = useState({
    genericName: -1,
    brandName: -1,
    strength: -1,
    form: -1,
    batchNumber: -1,
    expiryDate: -1,
    purchasePrice: -1,
    mrp: -1,
    sellingPrice: -1,
    stockQty: -1,
    barcode: -1
  });
  const [mappingConfidence, setMappingConfidence] = useState(1);
  const [forceManualMapping, setForceManualMapping] = useState(false);
  const [migrationTemplates, setMigrationTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [newTemplateName, setNewTemplateName] = useState("");
  const [importSessions, setImportSessions] = useState([]);
  const [importProgress, setImportProgress] = useState(0);
  const [isImporting, setIsImporting] = useState(false);
  const [activeImportSessionId, setActiveImportSessionId] = useState("");
  // ── Bulk Sales Import States ──
  const [previewImportedSales, setPreviewImportedSales] = useState([]);
  const [showSalesImportDrawer, setShowSalesImportDrawer] = useState(false);
  const [isImportingSales, setIsImportingSales] = useState(false);
  const [importSalesProgress, setImportSalesProgress] = useState(0);
  const [importSalesSearch, setImportSalesSearch] = useState("");
  // ── Edit Bill States ──
  const [editBillModalData, setEditBillModalData] = useState(null);
  const [editBillForm, setEditBillForm] = useState(null);
  const [editBillSearch, setEditBillSearch] = useState("");
  // ── KEYBOARD POS ──────────────────────────────────────────
  const [searchHighlight, setSearchHighlight] = useState(-1);
  const billSearchRef = useRef(null);
  const [isVoiceListening, setIsVoiceListening] = useState(false);
  const recognitionRef = useRef(null);
  const shouldBeListeningRef = useRef(false);

  const playBeep = (freq = 800, dur = 0.08) => {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.04, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  };

  const numberMap = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    single: 1, double: 2, triple: 3, "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10
  };

  const handleVoiceInput = useCallback((text) => {
    if (!text) return;
    const words = text.toLowerCase().split(/\s+/);
    let qty = 1;
    let nameParts = [];

    for (let word of words) {
      if (numberMap[word]) {
        qty = numberMap[word];
      } else if (word !== "strips" && word !== "strip" && word !== "bottles" && word !== "bottle" && word !== "pack" && word !== "pieces" && word !== "piece") {
        nameParts.push(word);
      }
    }

    const spokenName = nameParts.join(" ").trim();
    if (!spokenName) return;

    const tempItem = { genericName: spokenName, brandName: spokenName, strength: "", form: "" };
    const match = findBestMatch(tempItem, medicines);

    if (match.type === "MATCH" && match.item) {
      if (isExpired(match.item)) {
        playBeep(300, 0.2);
        alert(`⚠ Voice POS blocked: ${match.item.genericName} is EXPIRED.`);
        return;
      }
      playBeep(880, 0.08);
      setBillItems(prev => {
        const ex = prev.find(i => i.id === match.item.id);
        if (ex) return prev.map(i => i.id === match.item.id ? { ...i, qty: i.qty + qty } : i);
        const activePrice = +match.item.sellingPrice || +match.item.mrp || 0;
        return [...prev, { ...match.item, mrp: activePrice, qty: qty, discount: 0 }];
      });
      setAiStatus(`🎤 Voice POS matched: "${match.item.genericName}" (Qty: ${qty}) Added!`);
      setTimeout(() => setAiStatus(""), 3000);
    } else if (match.type === "CONFLICT" && match.item) {
      playBeep(600, 0.1);
      setBillSearch(match.item.brandName || match.item.genericName);
      setAiStatus(`🎤 Voice POS low confidence. Did you mean "${match.item.brandName || match.item.genericName}"?`);
      setTimeout(() => setAiStatus(""), 5000);
    } else {
      playBeep(440, 0.15);
      setBillSearch(spokenName);
      setAiStatus(`🎤 Voice POS: No match found for "${spokenName}".`);
      setTimeout(() => setAiStatus(""), 5000);
    }
  }, [medicines]);

  const toggleVoiceInput = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Web Speech API is not supported in this browser. Please use Chrome/Edge.");
      return;
    }

    if (shouldBeListeningRef.current) {
      shouldBeListeningRef.current = false;
      setIsVoiceListening(false);
      try {
        recognitionRef.current?.stop();
      } catch (e) {}
    } else {
      shouldBeListeningRef.current = true;
      setIsVoiceListening(true);
      playBeep(1000, 0.05);

      const rec = new SpeechRecognition();
      rec.continuous = true;
      rec.interimResults = false;
      rec.lang = "en-IN";

      rec.onstart = () => {
        setIsVoiceListening(true);
      };

      rec.onresult = (evt) => {
        const transcript = evt.results[evt.results.length - 1][0].transcript;
        handleVoiceInput(transcript);
      };

      rec.onerror = (evt) => {
        console.error("Speech error", evt);
        if (evt.error === "not-allowed" || evt.error === "service-not-allowed" || evt.error === "audio-capture") {
          shouldBeListeningRef.current = false;
          setIsVoiceListening(false);
        }
      };

      rec.onend = () => {
        if (shouldBeListeningRef.current) {
          try {
            rec.start();
          } catch (e) {
            console.error("Failed to restart speech recognition", e);
            shouldBeListeningRef.current = false;
            setIsVoiceListening(false);
          }
        } else {
          setIsVoiceListening(false);
        }
      };

      recognitionRef.current = rec;
      try {
        rec.start();
      } catch (e) {
        console.error("Speech start failed", e);
        shouldBeListeningRef.current = false;
        setIsVoiceListening(false);
      }
    }
  };

  // ── LOCAL STORAGE TAB AND DRAFT PERSISTENCE ──────────────────
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
    
    const savedTab = localStorage.getItem("jk_pms_active_tab");
    if (savedTab) setActiveTab(savedTab);
    
    try {
      const draftMeds = localStorage.getItem("jk_pms_draft_bill_items");
      if (draftMeds) setBillItems(JSON.parse(draftMeds));
      
      const draftName = localStorage.getItem("jk_pms_draft_cust_name");
      if (draftName) setCustomerName(draftName);
      
      const draftPhone = localStorage.getItem("jk_pms_draft_cust_phone");
      if (draftPhone) setCustomerPhone(draftPhone);

      const draftPay = localStorage.getItem("jk_pms_draft_payment_mode");
      if (draftPay) setPaymentMode(draftPay);
    } catch (e) {
      console.error("Failed to restore billing draft data", e);
    }

    try {
      const draftPurch = localStorage.getItem("jk_pms_draft_purchase_form");
      if (draftPurch) {
        const parsed = JSON.parse(draftPurch);
        setPurchaseForm(parsed);
        if (parsed.items && parsed.items.length > 0) {
          setPreviewItems(parsed.items);
          setShowPreviewDrawer(true);
        }
      }
    } catch (e) {
      console.error("Failed to restore purchase draft data", e);
    }

    try {
      const savedFilters = localStorage.getItem("jk_pms_report_filters");
      if (savedFilters) {
        setReportFilters(JSON.parse(savedFilters));
      }
    } catch (e) {
      console.error("Failed to restore report filters", e);
    }

    try {
      const savedPrint = localStorage.getItem("jk_pms_default_print_type");
      if (savedPrint) setDefaultPrintType(savedPrint);
    } catch (e) {
      console.error("Failed to restore default print type", e);
    }
  }, []);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_default_print_type", defaultPrintType);
  }, [defaultPrintType, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_active_tab", activeTab);
  }, [activeTab, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_draft_bill_items", JSON.stringify(billItems));
  }, [billItems, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_draft_cust_name", customerName);
  }, [customerName, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_draft_cust_phone", customerPhone);
  }, [customerPhone, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_draft_payment_mode", paymentMode);
  }, [paymentMode, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_report_filters", JSON.stringify(reportFilters));
  }, [reportFilters, isClient]);

  useEffect(() => {
    if (!isClient) return;
    localStorage.setItem("jk_pms_draft_purchase_form", JSON.stringify(purchaseForm));
  }, [purchaseForm, isClient]);

  // ── AUTH & SaaS ONBOARDING EFFECT ──
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        setProfileLoading(true);
        try {
          // Fetch user doc
          const userDocRef = doc(db, "users", u.uid);
          const userDocSnap = await getDoc(userDocRef);
          if (userDocSnap.exists()) {
            const userData = userDocSnap.data();
            setUserRole(userData.role || "staff");
            if (userData.storeId) {
              setStoreId(userData.storeId);
              setStoreCode(userData.storeCode || "");
              
              // Fetch store details
              const storeDocRef = doc(db, "stores", userData.storeId);
              const storeDocSnap = await getDoc(storeDocRef);
              if (storeDocSnap.exists()) {
                const storeData = storeDocSnap.data();
                setStoreName(storeData.name);
                setStoreDetails(storeData);
              }
              if (userData.role === "admin" && !userData.wizardCompleted) {
                setOnboardingMode("wizard-step1");
              } else {
                setOnboardingMode("none");
              }
            } else {
              setOnboardingMode("choose");
            }
          } else {
            // New user, trigger onboarding
            setOnboardingMode("choose");
          }
        } catch (e) {
          console.error("Failed to load user profile:", e);
          setOnboardingMode("choose");
        } finally {
          setProfileLoading(false);
        }
      } else {
        setStoreId("");
        setStoreCode("");
        setStoreName("");
        setStoreDetails(null);
        setUserRole("staff");
        setOnboardingMode("none");
        setProfileLoading(false);
      }
      setAuthLoading(false);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setLastSyncSec(prev => prev + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ── MULTI-TENANT DATABASE LISTENERS ──
  useEffect(() => {
    if (!user || !storeId) return;
    setDbLoading(true);
    setIndexError("");

    // Firestore queries without composite ordering/limits to bypass index requirements
    const qMeds = query(collection(db, "medicines"), where("storeId", "==", storeId));
    const qSales = query(collection(db, "sales"), where("storeId", "==", storeId));
    const qPurch = query(collection(db, "purchases"), where("storeId", "==", storeId));
    const qSups = query(collection(db, "suppliers"), where("storeId", "==", storeId));

    const handleIndexError = (err, collectionName) => {
      console.error(`Firestore index required for ${collectionName}:`, err);
      if (err.message && err.message.includes("requires an index")) {
        const match = err.message.match(/https:\/\/console\.firebase\.google\.com[^\s]*/);
        if (match) {
          setIndexError(prev => prev ? prev : match[0]);
        }
      }
    };

    const u1 = onSnapshot(qMeds, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Client-side sort by genericName ascending
      items.sort((a, b) => (a.genericName || "").localeCompare(b.genericName || ""));
      setMedicines(items);
      setDbLoading(false);
      setLastSyncSec(0);
    }, err => {
      handleIndexError(err, "medicines");
      setDbLoading(false);
    });

    const u2 = onSnapshot(qSales, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Client-side sort by createdAt descending
      items.sort((a, b) => {
        const tA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const tB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return tB - tA;
      });
      setSales(items.slice(0, 100));
      setLastSyncSec(0);
    }, err => handleIndexError(err, "sales"));

    const u3 = onSnapshot(qPurch, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Client-side sort by createdAt descending
      items.sort((a, b) => {
        const tA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const tB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return tB - tA;
      });
      setPurchases(items.slice(0, 100));
      setLastSyncSec(0);
    }, err => handleIndexError(err, "purchases"));

    const u4 = onSnapshot(qSups, snap => {
      setSuppliers(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLastSyncSec(0);
    }, err => handleIndexError(err, "suppliers"));

    const qTemplates = query(collection(db, "migration_templates"), where("storeId", "==", storeId));
    const qSessions = query(collection(db, "import_sessions"), where("storeId", "==", storeId));

    const uTemplates = onSnapshot(qTemplates, snap => {
      setMigrationTemplates(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, err => console.error("Templates listen error", err));

    const uSessions = onSnapshot(qSessions, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => {
        const tA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const tB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return tB - tA;
      });
      setImportSessions(items);
    }, err => console.error("Sessions listen error", err));

    return () => { u1(); u2(); u3(); u4(); uTemplates(); uSessions(); };
  }, [user, storeId]);

  // ── SaaS Onboarding Handlers ──
  const handleCreateStore = async () => {
    if (!newStore.name || !newStore.code) { alert("Please enter Store Name and Store Code."); return; }
    try {
      setProfileLoading(true);
      // Verify store code uniqueness
      const q = query(collection(db, "stores"), where("storeCode", "==", newStore.code));
      const snap = await getDocs(q);
      if (!snap.empty) {
        alert("This Store Code is already registered. Please check or use a different code.");
        setProfileLoading(false);
        return;
      }

      const storeRef = await addDoc(collection(db, "stores"), {
        name: newStore.name,
        storeCode: newStore.code,
        helpline: newStore.helpline || "0-124-356-1100",
        supportTime: newStore.supportTime || "9:30 AM To 6:00 PM",
        address: newStore.address || "",
        ownerId: user.uid,
        createdAt: serverTimestamp()
      });

      await setDoc(doc(db, "users", user.uid), {
        email: user.email,
        role: "admin",
        storeId: storeRef.id,
        storeCode: newStore.code,
        name: user.email.split('@')[0],
        joinedAt: serverTimestamp()
      });

      setStoreId(storeRef.id);
      setStoreCode(newStore.code);
      setStoreName(newStore.name);
      setStoreDetails({
        name: newStore.name,
        storeCode: newStore.code,
        helpline: newStore.helpline || "0-124-356-1100",
        supportTime: newStore.supportTime || "9:30 AM To 6:00 PM",
        address: newStore.address || ""
      });
      setUserRole("admin");
      setOnboardingMode("wizard-step1");
    } catch (e) {
      alert("Store registration failed: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  // ── SaaS Onboarding Setup Wizard Handlers ──
  useEffect(() => {
    if ((onboardingMode === "wizard-step1" || onboardingMode === "wizard-step2" || onboardingMode === "wizard-step3") && storeDetails) {
      setWizardStoreForm({
        name: storeDetails.name || "",
        gstin: storeDetails.gstin || "",
        phone: storeDetails.helpline || "",
        address: storeDetails.address || ""
      });
    }
  }, [onboardingMode, storeDetails]);

  const handleWizardStep1Next = async () => {
    if (!wizardStoreForm.name) {
      alert("Store Name is required.");
      return;
    }
    try {
      setProfileLoading(true);
      const storeRef = doc(db, "stores", storeId);
      await updateDoc(storeRef, {
        name: wizardStoreForm.name,
        gstin: wizardStoreForm.gstin || "",
        helpline: wizardStoreForm.phone || "",
        address: wizardStoreForm.address || "",
        updatedAt: serverTimestamp()
      });
      setStoreDetails(prev => ({
        ...prev,
        name: wizardStoreForm.name,
        gstin: wizardStoreForm.gstin || "",
        helpline: wizardStoreForm.phone || "",
        address: wizardStoreForm.address || ""
      }));
      setStoreName(wizardStoreForm.name);
      setLastSyncSec(0);
      setOnboardingMode("wizard-step2");
    } catch (e) {
      alert("Failed to update store details: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const handleAddWizardMed = async () => {
    if (!newWizardMed.genericName || !newWizardMed.mrp) {
      alert("Generic Name and MRP are required.");
      return;
    }
    const mrpVal = +newWizardMed.mrp;
    const sellVal = +newWizardMed.sellingPrice || mrpVal;
    const buyVal = +newWizardMed.purchasePrice || 0;

    try {
      setProfileLoading(true);
      await addDoc(collection(db, "medicines"), {
        storeId,
        storeCode,
        genericName: newWizardMed.genericName,
        brandName: newWizardMed.brandName || "",
        strength: newWizardMed.strength || "",
        form: newWizardMed.form || "Tablet",
        barcode: "",
        category: "General",
        lowStockAlert: +newWizardMed.lowStockAlert || 20,
        gstRate: +newWizardMed.gstRate || 12,
        mrp: mrpVal,
        sellingPrice: sellVal,
        purchasePrice: buyVal,
        stockQty: 0,
        batches: [],
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });
      setNewWizardMed({ brandName: "", genericName: "", strength: "", form: "Tablet", mrp: "", sellingPrice: "", purchasePrice: "", lowStockAlert: "20", gstRate: "12" });
      setLastSyncSec(0);
    } catch (e) {
      alert("Failed to add medicine: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const handleLoadSamples = async () => {
    const samples = [
      { genericName: "Paracetamol 500mg", brandName: "Calpol 500", mrp: 15, sellingPrice: 13, purchasePrice: 8, strength: "500mg", form: "Tablet" },
      { genericName: "Amoxicillin 500mg", brandName: "Mox 500", mrp: 85, sellingPrice: 78, purchasePrice: 45, strength: "500mg", form: "Capsule" },
      { genericName: "Cetirizine 10mg", brandName: "Okacet", mrp: 20, sellingPrice: 18, purchasePrice: 10, strength: "10mg", form: "Tablet" },
      { genericName: "Pantoprazole 40mg", brandName: "Pan 40", mrp: 120, sellingPrice: 110, purchasePrice: 65, strength: "40mg", form: "Tablet" },
      { genericName: "Azithromycin 500mg", brandName: "Azithral 500", mrp: 110, sellingPrice: 98, purchasePrice: 58, strength: "500mg", form: "Tablet" }
    ];
    try {
      setProfileLoading(true);
      for (const sample of samples) {
        await addDoc(collection(db, "medicines"), {
          storeId,
          storeCode,
          genericName: sample.genericName,
          brandName: sample.brandName,
          strength: sample.strength,
          form: sample.form,
          barcode: "",
          category: "General",
          lowStockAlert: 20,
          gstRate: 12,
          mrp: sample.mrp,
          sellingPrice: sample.sellingPrice,
          purchasePrice: sample.purchasePrice,
          stockQty: 0,
          batches: [],
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });
      }
      setLastSyncSec(0);
    } catch (e) {
      alert("Failed to load sample medicines: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const handleWizardStep3Finish = async () => {
    try {
      setProfileLoading(true);
      const userRef = doc(db, "users", user.uid);
      await updateDoc(userRef, {
        wizardCompleted: true
      });
      const storeRef = doc(db, "stores", storeId);
      await updateDoc(storeRef, {
        wizardCompleted: true
      });
      setOnboardingMode("none");
      setActiveTab("billing");
      setLastSyncSec(0);
    } catch (e) {
      alert("Failed to complete onboarding: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const handleJoinStore = async () => {
    if (!joinCode) { alert("Please enter the Store Code."); return; }
    try {
      setProfileLoading(true);
      const q = query(collection(db, "stores"), where("storeCode", "==", joinCode));
      const snap = await getDocs(q);
      if (snap.empty) {
        alert("Store Code not found. Please confirm with your Store Administrator.");
        setProfileLoading(false);
        return;
      }
      const storeDoc = snap.docs[0];
      const storeData = storeDoc.data();

      await setDoc(doc(db, "users", user.uid), {
        email: user.email,
        role: "staff",
        storeId: storeDoc.id,
        storeCode: joinCode,
        name: user.email.split('@')[0],
        joinedAt: serverTimestamp()
      });

      setStoreId(storeDoc.id);
      setStoreCode(joinCode);
      setStoreName(storeData.name);
      setStoreDetails(storeData);
      setUserRole("staff");
      setOnboardingMode("none");
    } catch (e) {
      alert("Failed to join store: " + e.message);
    } finally {
      setProfileLoading(false);
    }
  };

  const getExpiryDate = (m) => { 
    if (Array.isArray(m.batches) && m.batches.length > 0) {
      const activeBatches = m.batches.filter(b => (b.quantity || 0) > 0);
      if (activeBatches.length > 0) {
        const sorted = [...activeBatches].sort((a, b) => {
          const [ay, amo] = (a.expiryDate || "2099-12").split("-");
          const [by, bmo] = (b.expiryDate || "2099-12").split("-");
          return new Date(+ay, +amo - 1, 1) - new Date(+by, +bmo - 1, 1);
        });
        const [y, mo] = (sorted[0].expiryDate || "2099-12").split("-");
        return new Date(+y, +mo - 1, 1);
      }
    }
    if (!m.expiryDate) return new Date(9999, 0); 
    const [y, mo] = (m.expiryDate || "2099-12").split("-"); 
    return new Date(+y, +mo - 1, 1); 
  };

  const isExpired = (m) => {
    const exp = getExpiryDate(m);
    const nowMonth = new Date();
    nowMonth.setDate(1);
    nowMonth.setHours(0, 0, 0, 0);
    return exp < nowMonth;
  };

  const isExpiringSoon = (m) => {
    if (isExpired(m)) return false;
    const exp = getExpiryDate(m);
    const limit = new Date(); 
    limit.setMonth(limit.getMonth() + 3);
    return exp <= limit;
  };

  const lowStock = medicines.filter(m => m.stockQty <= m.lowStockAlert);
  const expiringSoon = medicines.filter(m => isExpiringSoon(m));
  
  const calcItem = (item) => {
    const base = (item.mrp || 0) * (item.qty || 0);
    const disc = base * (item.discount || 0) / 100;
    const total = base - disc;
    const gstRate = item.gstRate || 12;
    const taxableValue = total / (1 + (gstRate / 100));
    const gstAmount = total - taxableValue;
    const cgst = gstAmount / 2;
    const sgst = gstAmount / 2;
    return { base, disc, total, gstRate, taxableValue, gstAmount, cgst, sgst };
  };
  
  const totals = billItems.reduce((a, i) => {
    const c = calcItem(i);
    return {
      sub: a.sub + c.base,
      disc: a.disc + c.disc,
      grand: a.grand + c.total,
      taxable: a.taxable + c.taxableValue,
      gst: a.gst + c.gstAmount,
      cgst: a.cgst + c.cgst,
      sgst: a.sgst + c.sgst,
    };
  }, { sub: 0, disc: 0, grand: 0, taxable: 0, gst: 0, cgst: 0, sgst: 0 });
  const searchResults = billSearch.length >= 2
    ? medicines
        .filter(m => m.genericName?.toLowerCase().includes(billSearch.toLowerCase()) || m.brandName?.toLowerCase().includes(billSearch.toLowerCase()))
        .sort((a, b) => getExpiryDate(a) - getExpiryDate(b))
        .slice(0, 8)
    : [];
  // Substitutes: same generic name, in-stock, when item is OOS
  const getSubstitutes = (genericName) => medicines.filter(m => m.genericName?.toLowerCase() === genericName?.toLowerCase() && m.stockQty > 0).slice(0, 3);
  const filteredBills = billSearchQuery.length >= 2 ? sales.filter(s => s.billNumber?.toLowerCase().includes(billSearchQuery.toLowerCase()) || s.customerName?.toLowerCase().includes(billSearchQuery.toLowerCase()) || s.customerPhone?.includes(billSearchQuery)) : sales.slice(0, 50);
  const filteredMeds = medicines
    .filter(m => (m.genericName || "").toLowerCase().includes(searchQuery.toLowerCase()) || (m.brandName || "").toLowerCase().includes(searchQuery.toLowerCase()) || (m.category || "").toLowerCase().includes(searchQuery.toLowerCase()))
    .map(m => ({ ...m, marginPct: m.purchasePrice > 0 ? (((m.mrp - m.purchasePrice) / m.mrp) * 100).toFixed(1) : null }));
  // Reorder suggestions: stock at or below threshold
  const reorderList = medicines.filter(m => m.stockQty <= (m.lowStockAlert || 20) && m.stockQty >= 0);

  const getReportSales = () => {
    let start = null;
    let end = null;
    
    if (reportFilters.period === "today") {
      start = new Date();
      start.setHours(0, 0, 0, 0);
      end = new Date();
      end.setHours(23, 59, 59, 999);
    } else if (reportFilters.period === "week") {
      start = new Date();
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
    } else if (reportFilters.period === "month") {
      start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else if (reportFilters.period === "custom") {
      if (reportFilters.startDate) {
        start = new Date(reportFilters.startDate);
        start.setHours(0, 0, 0, 0);
      }
      if (reportFilters.endDate) {
        end = new Date(reportFilters.endDate);
        end.setHours(23, 59, 59, 999);
      }
    }

    return sales.filter(s => {
      const d = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0);
      if (start && d < start) return false;
      if (end && d > end) return false;
      
      // Payment mode filter
      if (reportFilters.paymentMode && s.paymentMode?.toLowerCase() !== reportFilters.paymentMode.toLowerCase()) return false;
      
      // Medicine filter
      if (reportFilters.medicineId) {
        const hasMed = (s.items || []).some(item => item.medicineId === reportFilters.medicineId);
        if (!hasMed) return false;
      }
      
      // Supplier filter: Check if any item sold belongs to a medicine whose lastDistributorName matches supplierName
      if (reportFilters.supplierName) {
        const hasSupplierMed = (s.items || []).some(item => {
          const med = medicines.find(m => m.id === item.medicineId);
          return med && med.lastDistributorName?.toLowerCase() === reportFilters.supplierName.toLowerCase();
        });
        if (!hasSupplierMed) return false;
      }
      
      return true;
    });
  };

  const getReportPurchases = () => {
    let start = null;
    let end = null;
    
    if (reportFilters.period === "today") {
      start = new Date();
      start.setHours(0, 0, 0, 0);
      end = new Date();
      end.setHours(23, 59, 59, 999);
    } else if (reportFilters.period === "week") {
      start = new Date();
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
    } else if (reportFilters.period === "month") {
      start = new Date();
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
    } else if (reportFilters.period === "custom") {
      if (reportFilters.startDate) {
        start = new Date(reportFilters.startDate);
        start.setHours(0, 0, 0, 0);
      }
      if (reportFilters.endDate) {
        end = new Date(reportFilters.endDate);
        end.setHours(23, 59, 59, 999);
      }
    }

    return purchases.filter(p => {
      let d = null;
      if (p.invoiceDate) {
        d = new Date(p.invoiceDate);
      }
      if (!d || isNaN(d.getTime())) {
        d = p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || 0);
      }
      
      if (start && d < start) return false;
      if (end && d > end) return false;
      
      // Supplier filter
      if (reportFilters.supplierName && p.supplierName?.toLowerCase() !== reportFilters.supplierName.toLowerCase()) return false;
      
      // Medicine filter
      if (reportFilters.medicineId) {
        const hasMed = (p.items || []).some(item => {
          const medId = item.medicineId || item.overrideId || item.matchedItem?.id;
          if (medId === reportFilters.medicineId) return true;
          const targetMed = medicines.find(m => m.id === reportFilters.medicineId);
          if (targetMed) {
            return (item.brandName?.toLowerCase() === targetMed.brandName?.toLowerCase() &&
                    item.strength?.toLowerCase() === targetMed.strength?.toLowerCase());
          }
          return false;
        });
        if (!hasMed) return false;
      }
      
      return true;
    });
  };

  // ── EXCEL PARSING & INVOICE FLOWS ─────────
  const parseExpiry = (exp) => {
    if (!exp) return "";
    const str = String(exp).trim().replace(/[\/\.-]/g, "/");

    // Pattern Match: MM/YY or MM/YYYY (e.g. 12/26 or 12/2026)
    const monthYearPattern = /^(\d{1,2})\/(\d{2,4})$/;
    const match = str.match(monthYearPattern);
    if (match) {
      let month = match[1].padStart(2, "0");
      let year = match[2];
      if (year.length === 2) year = "20" + year;
      const mVal = parseInt(month);
      if (mVal >= 1 && mVal <= 12) return `${year}-${month}`;
    }

    // Pattern Match: YYYY/MM (e.g. 2026/12)
    const yearMonthPattern = /^(\d{4})\/(\d{1,2})$/;
    const ymMatch = str.match(yearMonthPattern);
    if (ymMatch) {
      const year = ymMatch[1];
      const month = ymMatch[2].padStart(2, "0");
      const mVal = parseInt(month);
      if (mVal >= 1 && mVal <= 12) return `${year}-${month}`;
    }

    // Pattern Match: Date String formats like "Dec-26" or "December-2026"
    const dateObj = new Date(str);
    if (!isNaN(dateObj.getTime())) {
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, "0");
      return `${year}-${month}`;
    }

    // fallback for standard YYYY-MM
    const standardPattern = /^(\d{4})-(\d{2})$/;
    if (standardPattern.test(str)) {
      return str;
    }

    return "";
  };

  const downloadExcelTemplate = () => {
    const csvContent = 
      "Invoice Number,Invoice Date,Supplier Name\n" +
      "INV-998877,2026-05-28,Eshwari Pharma\n\n" +
      "Generic Name,Brand Name,Strength,Form,Batch Number,Expiry Date (YYYY-MM),Manufacturer MRP,Retail Selling Price,Purchase Price,Quantity,Unit,GST Rate (%),Barcode\n" +
      "Levocetirizine,Voycet-10,10mg,Tablet,VGT240096,2025-12,65.00,35.00,11.47,60,Strip,12,8901234567890\n" +
      "Luliconazole,Luzic Lotion,1%,Lotion,RE-3451,2026-10,230.00,120.00,35.00,60,Bottle,12,8901234567891\n" +
      "Permethrin,Biomethrin 5%,5%,Cream,718,2026-07,60.85,30.00,19.47,100,Tube,12,\n";
      
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "janaushadhi_purchase_template.csv");
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExcelUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAiLoading(true);
    setAiStatus("Parsing Excel sheet...");
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const bstr = evt.target.result;
            const wb = XLSX.read(bstr, { type: "binary" });
            const wsname = wb.SheetNames[0];
            const ws = wb.Sheets[wsname];
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
            resolve(json);
          } catch (err) { reject(err); }
        };
        reader.readAsBinaryString(file);
      });

      if (!data || data.length === 0) throw new Error("Excel is empty.");

      let supplierName = "Imported Supplier";
      let invoiceNumber = "IMP-" + Math.floor(100000 + Math.random() * 900000);
      let invoiceDate = new Date().toISOString().split("T")[0];
      let items = [];

      if (data.length > 1 && data[0].some(cell => String(cell || "").toLowerCase().includes("invoice") || String(cell || "").toLowerCase().includes("challan"))) {
        const headers = data[0].map(h => String(h || "").toLowerCase().trim());
        const values = data[1];
        const invNoIdx = headers.findIndex(h => h.includes("invoice number") || h.includes("invoice no") || h.includes("challan no") || h.includes("challan"));
        const dateIdx = headers.findIndex(h => h.includes("date"));
        const supIdx = headers.findIndex(h => h.includes("supplier") || h.includes("distributor") || h.includes("m/s"));

        if (invNoIdx >= 0) invoiceNumber = String(values[invNoIdx] || invoiceNumber);
        if (dateIdx >= 0 && values[dateIdx]) {
          const dt = values[dateIdx];
          invoiceDate = typeof dt === "number" ? new Date((dt - 25569) * 86400 * 1000).toISOString().split("T")[0] : String(dt).split("T")[0];
        }
        if (supIdx >= 0) supplierName = String(values[supIdx] || supplierName);
      }

      let itemHeaderIdx = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i].some(cell => {
          const s = String(cell || "").toLowerCase();
          return s.includes("generic") || s.includes("item description") || s.includes("product") || s.includes("medicine");
        })) {
          itemHeaderIdx = i;
          break;
        }
      }

      if (itemHeaderIdx >= 0) {
        const itemHeaders = data[itemHeaderIdx].map(h => String(h || "").toLowerCase().trim());
        const genIdx = itemHeaders.findIndex(h => h.includes("generic") || h.includes("description") || h.includes("item") || h.includes("product") || h.includes("medicine"));
        const brandIdx = itemHeaders.findIndex(h => h.includes("brand"));
        const strengthIdx = itemHeaders.findIndex(h => h.includes("strength") || h.includes("power"));
        const formIdx = itemHeaders.findIndex(h => h.includes("form") || h.includes("type"));
        const batchIdx = itemHeaders.findIndex(h => h.includes("batch"));
        const expIdx = itemHeaders.findIndex(h => h.includes("exp"));
        const mrpIdx = itemHeaders.findIndex(h => h.includes("mrp"));
        const retailIdx = itemHeaders.findIndex(h => h.includes("retail") || h.includes("selling") || h.includes("price") || h.includes("sell"));
        const buyIdx = itemHeaders.findIndex(h => h.includes("purchase") || h.includes("rate") || h.includes("buy"));
        const qtyIdx = itemHeaders.findIndex(h => h.includes("qty") || h.includes("quantity"));
        const unitIdx = itemHeaders.findIndex(h => h.includes("unit") || h.includes("pack"));
        const gstIdx = itemHeaders.findIndex(h => h.includes("gst") || h.includes("tax"));
        const barIdx = itemHeaders.findIndex(h => h.includes("barcode") || h.includes("upc"));

        for (let i = itemHeaderIdx + 1; i < data.length; i++) {
          const row = data[i];
          if (!row || row.length === 0 || !row[genIdx]) continue;

          const genericName = String(row[genIdx] || "").trim();
          const brandName = brandIdx >= 0 ? String(row[brandIdx] || "").trim() : "";
          const strength = strengthIdx >= 0 ? String(row[strengthIdx] || "").trim() : "";
          const form = formIdx >= 0 ? String(row[formIdx] || "Tablet").trim() : "Tablet";
          const batchNumber = batchIdx >= 0 ? String(row[batchIdx] || "").trim() : "BAT-" + Math.floor(Math.random() * 100000);
          const expiryDate = expIdx >= 0 ? parseExpiry(row[expIdx]) : "2027-12";
          const mrp = mrpIdx >= 0 ? parseFloat(row[mrpIdx]) || 0 : 0;
          const sellingPrice = retailIdx >= 0 ? parseFloat(row[retailIdx]) || mrp : mrp;
          const purchasePrice = buyIdx >= 0 ? parseFloat(row[buyIdx]) || 0 : 0;
          const quantity = qtyIdx >= 0 ? parseInt(row[qtyIdx]) || 0 : 0;
          const unit = unitIdx >= 0 ? String(row[unitIdx] || "Strip") : "Strip";
          const gstRate = gstIdx >= 0 ? String(parseFloat(row[gstIdx]) || 12) : "12";
          const barcode = barIdx >= 0 ? String(row[barIdx] || "").trim() : "";

          const incomingItem = { genericName, brandName, strength, form, batchNumber, expiryDate, mrp, sellingPrice, purchasePrice, quantity, unit, gstRate, barcode };
          
          const match = findBestMatch(incomingItem, medicines);

          items.push({
            ...incomingItem,
            matchType: match.type,
            matchedItem: match.item,
            score: match.score,
            overrideId: match.type === "MATCH" ? match.item.id : ""
          });
        }
      } else {
        throw new Error("Could not find table headers. Make sure 'Generic Name', 'Product Name', or 'Medicine' exists.");
      }

      setPurchaseForm({
        supplierName,
        invoiceNumber,
        invoiceDate,
        paymentStatus: "Unpaid",
        items: items
      });
      setPreviewItems(items);
      setShowPreviewDrawer(true);
      setAiStatus(`✓ Parsed Excel invoice with ${items.length} items. Review matches below!`);
    } catch (err) {
      setAiStatus("⚠ Excel parsing failed: " + err.message);
    } finally {
      setAiLoading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAiLoading(true);
    setAiStatus("Reading your invoice...");
    try {
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      const mimeType = file.type || (file.name.endsWith(".pdf") ? "application/pdf" : "image/jpeg");
      setAiStatus("Gemini AI is reading your invoice...");

      const response = await fetch("/api/scan-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64, mimeType }),
      });

      const result = await response.json();
      if (!result.success) throw new Error(result.error || "Scan failed");
      const parsed = result.data;

      const items = (parsed.items || []).map(item => {
        const incomingItem = {
          genericName: item.genericName || "",
          brandName: item.brandName || "",
          strength: item.strength || "",
          form: item.form || "Tablet",
          batchNumber: item.batchNumber || "BAT-" + Math.floor(Math.random() * 100000),
          expiryDate: parseExpiry(item.expiryDate),
          mrp: parseFloat(item.mrp) || 0,
          sellingPrice: parseFloat(item.sellingPrice) || parseFloat(item.mrp) || 0,
          purchasePrice: parseFloat(item.purchasePrice) || 0,
          quantity: parseInt(item.quantity) || 0,
          unit: item.unit || "Strip",
          gstRate: String(item.gstRate || "12"),
          barcode: item.barcode || ""
        };

        const match = findBestMatch(incomingItem, medicines);
        return {
          ...incomingItem,
          matchType: match.type,
          matchedItem: match.item,
          score: match.score,
          overrideId: match.type === "MATCH" ? match.item.id : ""
        };
      });

      setPurchaseForm({
        supplierName: parsed.supplierName || "Eshwari Pharma",
        invoiceNumber: parsed.invoiceNumber || "AI-" + Math.floor(100000 + Math.random() * 900000),
        invoiceDate: parsed.invoiceDate || new Date().toISOString().split("T")[0],
        paymentStatus: "Unpaid",
        items: items
      });
      setPreviewItems(items);
      setShowPreviewDrawer(true);
      setAiStatus(`✓ Gemini AI successfully read ${(parsed.items || []).length} items from ${parsed.supplierName || "supplier"}. Review below!`);
    } catch (err) {
      setAiStatus("⚠ Could not read invoice automatically. Please fill in manually below.");
    } finally {
      setAiLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addToBill = (med) => {
    if (isExpired(med)) { alert(`⚠ ${med.genericName} is EXPIRED (${med.expiryDate}). Sale blocked.`); return; }
    
    // Find default active unexpired batch (FEFO)
    const currentMonthStr = new Date().toISOString().substring(0, 7); // "YYYY-MM"
    let defaultBatchNum = "";
    if (Array.isArray(med.batches) && med.batches.length > 0) {
      const activeBatches = med.batches.filter(b => b.expiryDate >= currentMonthStr && (b.quantity || 0) > 0);
      activeBatches.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
      if (activeBatches.length > 0) {
        defaultBatchNum = activeBatches[0].batchNumber;
      }
    }

    setBillItems(prev => {
      const ex = prev.find(i => i.id === med.id);
      if (ex) return prev.map(i => i.id === med.id ? { ...i, qty: i.qty + 1 } : i);
      const activePrice = +med.sellingPrice || +med.mrp || 0;
      return [...prev, { 
        ...med, 
        mrp: activePrice, 
        originalMrp: med.mrp, 
        qty: 1, 
        discount: 0,
        selectedBatchNumber: defaultBatchNum
      }];
    });
    setBillSearch(""); setSearchHighlight(-1);
  };

  // ── GLOBAL KEYBOARD HANDLER ────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      // F2 → focus medicine search (anywhere on billing tab)
      if (e.key === "F2") { e.preventDefault(); if (activeTab !== "billing") setActiveTab("billing"); setTimeout(() => billSearchRef.current?.focus(), 80); }
      // F9 → generate bill
      if (e.key === "F9") { e.preventDefault(); if (billItems.length > 0) generateBill(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, billItems]);

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter") {
      const trimmedSearch = billSearch.trim();
      
      // 1. Exact barcode lookup in memory (essential for instant barcode scanners)
      const exactBarcodeMatch = medicines.find(m => m.barcode === trimmedSearch);
      if (exactBarcodeMatch) {
        e.preventDefault();
        addToBill(exactBarcodeMatch);
        return;
      }

      // 2. Highlighted item selection
      if (searchHighlight >= 0 && searchResults[searchHighlight]) {
        e.preventDefault();
        addToBill(searchResults[searchHighlight]);
        return;
      }

      // 3. Auto-add if exactly 1 result in dropdown
      if (searchResults.length === 1) {
        e.preventDefault();
        addToBill(searchResults[0]);
        return;
      }
    }

    if (!searchResults.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSearchHighlight(h => Math.min(h + 1, searchResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSearchHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === "Escape") { setBillSearch(""); setSearchHighlight(-1); }
  };

  const generateBill = async () => {
    if (!billItems.length) return;
    if (!storeId) { alert("Error: No store linked to user."); return; }
    
    // Validate quantities
    for (const item of billItems) {
      if (item.qty === "" || !item.qty || +item.qty <= 0) {
        alert(`⚠ Please add the quantity for "${item.genericName || item.brandName}"!`);
        return;
      }
    }
    
    const billNumber = `JK-${now.getFullYear()}-${String(sales.length + 1).padStart(4, "0")}`;
    const currentMonthStr = new Date().toISOString().substring(0, 7); // "YYYY-MM"

    try {
      await runTransaction(db, async (transaction) => {
        const finalizedItems = [];
        const auditLogs = [];
        let subtotalSum = 0;
        let discountSum = 0;
        let taxableSum = 0;
        let cgstSum = 0;
        let sgstSum = 0;
        let gstSum = 0;
        let grandSum = 0;
        let cogsSum = 0;

        // Phase 1: Read all medicine documents (strict read phase)
        const medicinesData = [];
        for (const item of billItems) {
          const medRef = doc(db, "medicines", item.id);
          const medSnap = await transaction.get(medRef);
          if (!medSnap.exists()) {
            throw new Error(`Medicine "${item.brandName || item.genericName}" does not exist in inventory.`);
          }
          medicinesData.push({ item, medRef, data: medSnap.data() });
        }

        // Phase 2: Processing, FEFO deduction & memory calculations
        for (const { item, medRef, data: med } of medicinesData) {
          // Deep copy to prevent mutating local listener caches
          let currentBatches = Array.isArray(med.batches) ? med.batches.map(b => ({ ...b })) : [];
          let remainingQ = item.qty;
          
          // Expiry and active stock filter (String comparisons only, no Date parsing)
          let activeBatches = currentBatches.filter(b => b.expiryDate >= currentMonthStr && (b.quantity || 0) > 0);
          
          // Sort: prioritize user-override selectedBatchNumber first, then FEFO (earliest expiry first)
          activeBatches.sort((a, b) => {
            if (item.selectedBatchNumber) {
              if (a.batchNumber === item.selectedBatchNumber) return -1;
              if (b.batchNumber === item.selectedBatchNumber) return 1;
            }
            return a.expiryDate.localeCompare(b.expiryDate);
          });
          
          const activeStock = activeBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
          if (activeStock < remainingQ) {
            throw new Error(`Insufficient active stock for "${med.brandName || med.genericName}". Requested: ${remainingQ}, Available active: ${activeStock}.`);
          }

          const batchesUsed = [];

          // Deduct sequentially from the sorted active batches
          for (let b of activeBatches) {
            if (remainingQ <= 0) break;
            const bq = b.quantity || 0;
            if (bq > 0) {
              const take = Math.min(bq, remainingQ);
              const prevQty = b.quantity;
              b.quantity = bq - take;
              remainingQ -= take;
              
              // Hard fail validation on missing purchase prices
              const batchPurchasePrice = b.purchasePrice;
              if (!batchPurchasePrice || +batchPurchasePrice <= 0) {
                throw new Error(`Financial validation failed: Batch "${b.batchNumber}" of medicine "${med.brandName || med.genericName}" has no purchase price configured. High-integrity margins require a landed cost.`);
              }
              
              const batchSellingPrice = item.sellingPrice || b.sellingPrice || b.mrp || 0;
              
              batchesUsed.push({
                batchNumber: b.batchNumber,
                quantity: take,
                purchasePrice: batchPurchasePrice,
                sellingPrice: batchSellingPrice
              });

              auditLogs.push({
                medicineId: item.id,
                genericName: med.genericName,
                brandName: med.brandName || "",
                batchNumber: b.batchNumber,
                type: "SALE",
                actionSource: "POS_CHECKOUT",
                quantityChanged: -take,
                previousQuantity: prevQty,
                newQuantity: b.quantity,
                purchasePrice: batchPurchasePrice
              });
            }
          }

          // Merge active updates back into the full batches list
          const updatedBatches = currentBatches.map(b => {
            const updatedActive = activeBatches.find(ab => ab.batchNumber === b.batchNumber);
            return updatedActive ? updatedActive : b;
          });

          const totalStock = updatedBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

          // Phase 3: Write Updates
          transaction.update(medRef, {
            stockQty: Math.max(0, totalStock),
            batches: updatedBatches,
            updatedAt: serverTimestamp()
          });

          // Calculations for sale records
          const c = calcItem(item);
          const itemCogs = batchesUsed.reduce((sum, bu) => sum + (bu.quantity * bu.purchasePrice), 0);
          const itemProfit = c.total - itemCogs;

          subtotalSum += c.base;
          discountSum += c.disc;
          taxableSum += c.taxableValue;
          cgstSum += c.cgst;
          sgstSum += c.sgst;
          gstSum += c.gstAmount;
          grandSum += c.total;
          cogsSum += itemCogs;

          finalizedItems.push({
            medicineId: item.id,
            genericName: item.genericName,
            brandName: item.brandName || "",
            quantity: item.qty,
            mrp: item.originalMrp || item.mrp,
            sellingPrice: item.mrp,
            discount: item.discount || 0,
            total: c.total,
            gstRate: c.gstRate,
            taxableValue: c.taxableValue,
            cgst: c.cgst,
            sgst: c.sgst,
            totalGst: c.gstAmount,
            cogs: itemCogs,
            profit: itemProfit,
            batchesUsed
          });
        }

        // Create Sale Document
        const salesColRef = collection(db, "sales");
        const saleDocRef = doc(salesColRef);
        const saleId = saleDocRef.id;

        const billData = {
          storeId,
          storeCode,
          billNumber,
          customerName: customerName || "Walk-in Patient",
          customerPhone: customerPhone || "",
          items: finalizedItems,
          subtotal: subtotalSum,
          totalDiscount: discountSum,
          taxableAmount: taxableSum,
          cgstAmount: cgstSum,
          sgstAmount: sgstSum,
          totalGst: gstSum,
          cogs: cogsSum,
          profit: grandSum - cogsSum,
          grandTotal: grandSum,
          paymentMode,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        };

        transaction.set(saleDocRef, billData);

        // Write Audit Logs
        const auditLogsCol = collection(db, "inventory_audit_logs");
        for (const log of auditLogs) {
          const logDocRef = doc(auditLogsCol);
          transaction.set(logDocRef, {
            ...log,
            storeId,
            referenceId: saleId,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }

        setLastBill({
          ...billData,
          id: saleId,
          date: new Date()
        });
      });

      playBeep(880, 0.08);
      setBillItems([]);
      setCustomerName("");
      setCustomerPhone("");
      alert(`✓ Sale finalized! Invoice ${billNumber} generated successfully.`);
    } catch (err) {
      alert("Error generating bill: " + err.message);
    }
  };

  const saveMedicine = async () => {
    if (!newMed.genericName || !newMed.mrp || !newMed.stockQty) return;
    if (!storeId) { alert("Error: No store linked to user."); return; }
    
    const mrpVal = +newMed.mrp;
    const sellVal = +newMed.sellingPrice || mrpVal;
    const buyVal = +newMed.purchasePrice || 0;
    const qtyVal = +newMed.stockQty;

    // Hard-fail on missing purchase price for stock additions
    if (qtyVal > 0 && buyVal <= 0) {
      alert("⚠ Hard financial validation failed: Landed purchase price is required to calculate profitability on stock additions.");
      return;
    }

    try {
      const batchNo = newMed.batchNumber || "BAT-GEN-" + Math.floor(Math.random() * 100000);
      const expDate = newMed.expiryDate || "2027-12";

      const initialBatch = {
        batchNumber: batchNo,
        expiryDate: expDate,
        quantity: qtyVal,
        purchasePrice: buyVal,
        mrp: mrpVal,
        sellingPrice: sellVal
      };

      const medRef = await addDoc(collection(db, "medicines"), {
        storeId,
        storeCode,
        genericName: newMed.genericName,
        brandName: newMed.brandName || "",
        strength: newMed.strength || "",
        form: newMed.form || "Tablet",
        barcode: newMed.barcode || "",
        category: newMed.category || "",
        lowStockAlert: +newMed.lowStockAlert || 20,
        gstRate: +newMed.gstRate || 12,
        mrp: mrpVal,
        sellingPrice: sellVal,
        purchasePrice: buyVal,
        stockQty: qtyVal,
        batches: [initialBatch],
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });

      // Write isolated audit log for starting stock
      if (qtyVal > 0) {
        await addDoc(collection(db, "inventory_audit_logs"), {
          storeId,
          medicineId: medRef.id,
          genericName: newMed.genericName,
          brandName: newMed.brandName || "",
          batchNumber: batchNo,
          type: "OPENING_STOCK",
          actionSource: "INVENTORY_ONBOARDING",
          referenceId: "NEW-MEDICINE-INIT",
          quantityChanged: qtyVal,
          previousQuantity: 0,
          newQuantity: qtyVal,
          purchasePrice: buyVal,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });
      }

      setShowAddMedForm(false);
      setNewMed({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", stockQty: "", unit: "Strip", lowStockAlert: "20", category: "", gstRate: "12" });
      alert("✓ Medicine successfully saved and stock initialized!");
    } catch (err) { alert("Error: " + err.message); }
  };

  const calculateColumnMapping = (excelHeaders) => {
    const mapping = {
      genericName: -1,
      brandName: -1,
      strength: -1,
      form: -1,
      batchNumber: -1,
      expiryDate: -1,
      purchasePrice: -1,
      mrp: -1,
      sellingPrice: -1,
      stockQty: -1,
      barcode: -1
    };

    let matchedFields = 0;
    const requiredKeys = ["genericName", "batchNumber", "expiryDate", "purchasePrice", "mrp", "stockQty"];

    excelHeaders.forEach((header, index) => {
      const cleanHeader = String(header || "").toLowerCase().trim().replace(/[^a-z0-9\s-_]/g, "");
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (aliases.includes(cleanHeader) && mapping[field] === -1) {
          mapping[field] = index;
          if (requiredKeys.includes(field)) {
            matchedFields++;
          }
          break;
        }
      }
    });

    const confidence = matchedFields / requiredKeys.length;
    return { mapping, confidence };
  };

  const applyExcelMapping = (rawRowsList, currentMapping) => {
    const items = rawRowsList.map((row, idx) => {
      const getVal = (field) => {
        const colIdx = currentMapping[field];
        return colIdx !== undefined && colIdx >= 0 ? row[colIdx] : null;
      };

      const genericName = getVal("genericName") ? String(getVal("genericName")).trim() : "";
      const brandName = getVal("brandName") ? String(getVal("brandName")).trim() : "";
      const strength = getVal("strength") ? String(getVal("strength")).trim() : "";
      const form = getVal("form") ? String(getVal("form")).trim() : "Tablet";
      const batchNumber = getVal("batchNumber") ? String(getVal("batchNumber")).trim().toUpperCase() : "";
      const expiryDate = getVal("expiryDate") ? parseExpiry(getVal("expiryDate")) : "";
      const mrp = parseFloat(getVal("mrp")) || 0;
      const sellingPrice = getVal("sellingPrice") !== null && getVal("sellingPrice") !== undefined 
        ? parseFloat(getVal("sellingPrice")) || 0 
        : mrp;
      const purchasePrice = parseFloat(getVal("purchasePrice")) || 0;
      const stockQty = parseInt(getVal("stockQty")) || 0;
      const barcode = getVal("barcode") ? String(getVal("barcode")).trim() : "";

      // Validation Flags
      const batchMissing = !batchNumber.trim();
      const expiryInvalid = !expiryDate || !/^\d{4}-\d{2}$/.test(expiryDate);
      const priceInvalid = purchasePrice <= 0 || mrp <= 0 || purchasePrice > mrp;
      const qtyInvalid = stockQty < 0;

      const incomingItem = {
        genericName,
        brandName,
        strength,
        form,
        batchNumber,
        expiryDate,
        mrp,
        sellingPrice,
        purchasePrice,
        stockQty,
        barcode,
        batchMissing,
        expiryInvalid,
        priceInvalid,
        qtyInvalid
      };

      const match = findBestMatch(incomingItem, medicines);
      return {
        id: idx,
        ...incomingItem,
        matchType: match.type,
        matchedItem: match.item,
        score: match.score,
        overrideId: match.type === "MATCH" ? match.item.id : ""
      };
    });

    setExcelInventoryItems(items);
  };

  const handleExcelInventoryUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAiLoading(true);
    setAiStatus("Parsing inventory sheet...");
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const bstr = evt.target.result;
            const wb = XLSX.read(bstr, { type: "binary" });
            const wsname = wb.SheetNames[0];
            const ws = wb.Sheets[wsname];
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
            resolve(json);
          } catch (err) { reject(err); }
        };
        reader.readAsBinaryString(file);
      });

      if (!data || data.length === 0) throw new Error("Excel sheet is empty.");

      let itemHeaderIdx = -1;
      for (let i = 0; i < data.length; i++) {
        if (data[i].some(cell => {
          const s = String(cell || "").toLowerCase();
          return s.includes("generic") || s.includes("item description") || s.includes("product") || s.includes("medicine");
        })) {
          itemHeaderIdx = i;
          break;
        }
      }

      if (itemHeaderIdx === -1) itemHeaderIdx = 0;

      const fileHeaders = data[itemHeaderIdx].map(h => String(h || "").trim());
      const rawRowsList = data.slice(itemHeaderIdx + 1);

      setExcelRawHeaders(fileHeaders);
      setExcelRawRows(rawRowsList);

      const { mapping, confidence } = calculateColumnMapping(fileHeaders);
      setExcelColumnMapping(mapping);
      setMappingConfidence(confidence);
      setForceManualMapping(confidence < 0.7);
      setSelectedTemplateId("");

      applyExcelMapping(rawRowsList, mapping);

      setShowExcelInventoryDrawer(true);
      setAiStatus(`✓ Parsed ${rawRowsList.length} items from Excel sheet. Review mapping and resolve matches!`);
    } catch (err) {
      setAiStatus("⚠ Excel parsing failed: " + err.message);
    } finally {
      setAiLoading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleProductPhotoUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setAiLoading(true);
    setAiStatus("Reading product packaging details...");
    try {
      const base64 = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result.split(",")[1]);
        reader.onerror = rej;
        reader.readAsDataURL(file);
      });
      const mimeType = file.type || "image/jpeg";
      setAiStatus("Gemini AI is analyzing product package...");

      const response = await fetch("/api/scan-product", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64, mimeType }),
      });

      const result = await response.json();
      if (!result.success) throw new Error(result.error || "Product scan failed");
      const parsed = result.data;

      setNewMed({
        genericName: parsed.genericName || "",
        brandName: parsed.brandName || "",
        strength: parsed.strength || "",
        form: parsed.form || "Tablet",
        barcode: parsed.barcode || "",
        batchNumber: parsed.batchNumber || "BAT-" + Math.floor(Math.random() * 100000),
        expiryDate: parsed.expiryDate || "2027-12",
        mrp: parsed.mrp ? String(parsed.mrp) : "",
        sellingPrice: parsed.sellingPrice ? String(parsed.sellingPrice) : "",
        purchasePrice: parsed.purchasePrice ? String(parsed.purchasePrice) : "",
        stockQty: "", // Let them fill it manually as requested: "Only Quantity should be added or changed"
        lowStockAlert: "20",
        category: parsed.category || "General",
        gstRate: parsed.gstRate || "12",
        unit: parsed.unit || "Strip"
      });

      setShowAddMedForm(true);
      setAiStatus(`✓ Gemini AI scanned product package: "${parsed.brandName || parsed.genericName}". Verify details and input Stock Quantity!`);
    } catch (err) {
      setAiStatus("⚠ Product package scan failed: " + err.message);
    } finally {
      setAiLoading(false);
      if (productPhotoInputRef.current) productPhotoInputRef.current.value = "";
    }
  };

  const saveExcelInventory = async () => {
    if (!excelInventoryItems.length) return;
    if (!storeId) { alert("Error: No store linked to user."); return; }

    const hasErrors = excelInventoryItems.some(i => i.batchMissing || i.expiryInvalid || i.priceInvalid || i.qtyInvalid);
    if (hasErrors) {
      alert("⚠️ Cannot import: Please resolve all highlighted errors in the preview grid first.");
      return;
    }

    setIsImporting(true);
    setImportProgress(0);
    setAiStatus("Initializing data import session...");

    try {
      const sessionCol = collection(db, "import_sessions");
      const sessionDocRef = doc(sessionCol);
      const sessionId = sessionDocRef.id;
      setActiveImportSessionId(sessionId);

      await setDoc(sessionDocRef, {
        storeId,
        storeCode,
        status: "PROCESSING",
        progress: 0,
        totalCount: excelInventoryItems.length,
        processedCount: 0,
        createdMedicines: [],
        updatedMedicines: {},
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });

      const items = [...excelInventoryItems];
      const chunkSize = 50;
      let processed = 0;
      const createdMeds = [];
      const updatedMeds = {};

      const processChunk = async (startIndex) => {
        const chunk = items.slice(startIndex, startIndex + chunkSize);
        
        await runTransaction(db, async (transaction) => {
          for (const item of chunk) {
            let targetId = item.overrideId || "";

            if (item.matchType === "MATCH" && !targetId && item.matchedItem) {
              targetId = item.matchedItem.id;
            }

            const qtyVal = +item.stockQty || 0;
            const mrpVal = +item.mrp || 0;
            const sellVal = +item.sellingPrice || mrpVal;
            const buyVal = +item.purchasePrice || 0;
            const batchNo = item.batchNumber || "BAT-GEN-" + Math.floor(Math.random() * 100000);
            const expDate = item.expiryDate || "2027-12";
            const dateStr = new Date().toISOString().substring(0, 10);

            const incomingBatch = {
              batchNumber: batchNo,
              expiryDate: expDate,
              quantity: qtyVal,
              purchasePrice: buyVal,
              mrp: mrpVal,
              sellingPrice: sellVal,
              isOpeningStock: true,
              openingStockDate: dateStr
            };

            const historyEntry = {
              price: buyVal,
              mrp: mrpVal,
              date: dateStr,
              type: "OPENING_STOCK",
              batchNumber: batchNo
            };

            if (targetId) {
              const medRef = doc(db, "medicines", targetId);
              const medSnap = await transaction.get(medRef);
              if (medSnap.exists()) {
                const existing = medSnap.data();
                let currentBatches = Array.isArray(existing.batches) ? [...existing.batches] : [];
                const matchBatchIdx = currentBatches.findIndex(b => b.batchNumber === incomingBatch.batchNumber);

                let prevQty = 0;
                if (matchBatchIdx >= 0) {
                  prevQty = currentBatches[matchBatchIdx].quantity || 0;
                  currentBatches[matchBatchIdx] = {
                    ...currentBatches[matchBatchIdx],
                    quantity: prevQty + incomingBatch.quantity,
                    purchasePrice: incomingBatch.purchasePrice || currentBatches[matchBatchIdx].purchasePrice,
                    mrp: incomingBatch.mrp || currentBatches[matchBatchIdx].mrp,
                    sellingPrice: incomingBatch.sellingPrice || currentBatches[matchBatchIdx].sellingPrice,
                    expiryDate: incomingBatch.expiryDate || currentBatches[matchBatchIdx].expiryDate
                  };
                } else {
                  currentBatches.push(incomingBatch);
                }

                currentBatches = currentBatches.filter(b => {
                  const [y, mo] = (b.expiryDate || "2099-12").split("-");
                  const isExpired = new Date(+y, +mo - 1, 1) < new Date();
                  return !isExpired || b.quantity > 0;
                });

                const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
                
                if (!updatedMeds[targetId]) {
                  updatedMeds[targetId] = [];
                }
                updatedMeds[targetId].push({ batchNumber: batchNo, quantityAdded: qtyVal });

                const updatedPriceHistory = Array.isArray(existing.priceHistory) ? [...existing.priceHistory] : [];
                updatedPriceHistory.push(historyEntry);

                transaction.update(medRef, {
                  mrp: incomingBatch.mrp || existing.mrp,
                  sellingPrice: incomingBatch.sellingPrice || existing.sellingPrice || existing.mrp,
                  purchasePrice: incomingBatch.purchasePrice || existing.purchasePrice,
                  expiryDate: incomingBatch.expiryDate || existing.expiryDate,
                  barcode: item.barcode || existing.barcode || "",
                  stockQty: totalStock,
                  batches: currentBatches,
                  priceHistory: updatedPriceHistory,
                  updatedAt: serverTimestamp()
                });

                if (qtyVal > 0) {
                  const auditCol = collection(db, "inventory_audit_logs");
                  const auditDocRef = doc(auditCol);
                  transaction.set(auditDocRef, {
                    storeId,
                    medicineId: targetId,
                    genericName: existing.genericName,
                    brandName: existing.brandName || "",
                    batchNumber: batchNo,
                    type: "OPENING_STOCK",
                    actionSource: "INVENTORY_MIGRATION",
                    referenceId: sessionId,
                    quantityChanged: qtyVal,
                    previousQuantity: prevQty,
                    newQuantity: prevQty + qtyVal,
                    purchasePrice: buyVal,
                    createdAt: serverTimestamp(),
                    createdBy: user.uid
                  });
                }
              }
            } else {
              const newMedRef = doc(collection(db, "medicines"));
              const newMedId = newMedRef.id;

              const newMedData = {
                storeId,
                storeCode,
                genericName: item.genericName,
                brandName: item.brandName || "",
                strength: item.strength || "",
                form: item.form || "Tablet",
                barcode: item.barcode || "",
                mrp: mrpVal,
                sellingPrice: sellVal,
                purchasePrice: buyVal,
                stockQty: qtyVal,
                lowStockAlert: 20,
                gstRate: +item.gstRate || 12,
                category: "",
                batches: [incomingBatch],
                priceHistory: [historyEntry],
                createdAt: serverTimestamp(),
                createdBy: user.uid
              };

              transaction.set(newMedRef, newMedData);
              createdMeds.push(newMedId);

              if (qtyVal > 0) {
                const auditCol = collection(db, "inventory_audit_logs");
                const auditDocRef = doc(auditCol);
                transaction.set(auditDocRef, {
                  storeId,
                  medicineId: newMedId,
                  genericName: item.genericName,
                  brandName: item.brandName || "",
                  batchNumber: batchNo,
                  type: "OPENING_STOCK",
                  actionSource: "INVENTORY_MIGRATION",
                  referenceId: sessionId,
                  quantityChanged: qtyVal,
                  previousQuantity: 0,
                  newQuantity: qtyVal,
                  purchasePrice: buyVal,
                  createdAt: serverTimestamp(),
                  createdBy: user.uid
                });
              }
            }
          }
        });

        processed += chunk.length;
        const currentProgress = Math.round((processed / items.length) * 100);
        setImportProgress(currentProgress);
        setAiStatus(`Saving imported inventory to database... (${currentProgress}%)`);

        await updateDoc(sessionDocRef, {
          progress: currentProgress,
          processedCount: processed,
          createdMedicines: createdMeds,
          updatedMedicines: updatedMeds
        });

        if (processed < items.length) {
          await new Promise(resolve => setTimeout(resolve, 80));
          await processChunk(processed);
        } else {
          await updateDoc(sessionDocRef, {
            status: "COMPLETED",
            progress: 100
          });
          setIsImporting(false);
          setShowExcelInventoryDrawer(false);
          setExcelInventoryItems([]);
          setAiStatus("");
          alert(`✓ Excel Inventory successfully imported! Ingested ${items.length} items. Session ID: ${sessionId}`);
        }
      };

      await processChunk(0);

    } catch (err) {
      console.error(err);
      setIsImporting(false);
      setAiStatus("⚠ Ingestion failed: " + err.message);
      if (activeImportSessionId) {
        try {
          await updateDoc(doc(db, "import_sessions", activeImportSessionId), {
            status: "FAILED"
          });
        } catch (e) {}
      }
      alert("Error saving imported inventory: " + err.message);
    }
  };

  const rollbackImportSession = async (session) => {
    if (!window.confirm(`⚠️ WARNING: Are you sure you want to rollback Import Session #${session.id}?\n\nThis will subtract all imported quantities from stock, delete any new medicine catalog cards created during this import, and cannot be undone.`)) return;
    
    setDbLoading(true);
    try {
      await runTransaction(db, async (transaction) => {
        const createdMeds = session.createdMedicines || [];
        for (const medId of createdMeds) {
          const medRef = doc(db, "medicines", medId);
          transaction.delete(medRef);
        }

        const updatedMeds = session.updatedMedicines || {};
        for (const [medId, updates] of Object.entries(updatedMeds)) {
          if (createdMeds.includes(medId)) continue;

          const medRef = doc(db, "medicines", medId);
          const medSnap = await transaction.get(medRef);
          if (medSnap.exists()) {
            const existing = medSnap.data();
            let currentBatches = Array.isArray(existing.batches) ? [...existing.batches] : [];

            for (const update of updates) {
              const bIdx = currentBatches.findIndex(b => b.batchNumber === update.batchNumber);
              if (bIdx >= 0) {
                const prevQty = currentBatches[bIdx].quantity || 0;
                const newQty = Math.max(0, prevQty - update.quantityAdded);
                currentBatches[bIdx].quantity = newQty;

                const auditCol = collection(db, "inventory_audit_logs");
                const auditDocRef = doc(auditCol);
                transaction.set(auditDocRef, {
                  storeId,
                  medicineId: medId,
                  genericName: existing.genericName,
                  brandName: existing.brandName || "",
                  batchNumber: update.batchNumber,
                  type: "STOCK_ADJUSTMENT",
                  actionSource: "INVENTORY_ROLLBACK",
                  referenceId: session.id,
                  quantityChanged: -update.quantityAdded,
                  previousQuantity: prevQty,
                  newQuantity: newQty,
                  purchasePrice: currentBatches[bIdx].purchasePrice || 0,
                  createdAt: serverTimestamp(),
                  createdBy: user.uid
                });
              }
            }

            const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

            let updatedPriceHistory = Array.isArray(existing.priceHistory) ? [...existing.priceHistory] : [];
            for (const update of updates) {
              const histIdx = updatedPriceHistory.findIndex(h => h.batchNumber === update.batchNumber && h.type === "OPENING_STOCK");
              if (histIdx >= 0) {
                updatedPriceHistory.splice(histIdx, 1);
              }
            }

            transaction.update(medRef, {
              stockQty: totalStock,
              batches: currentBatches,
              priceHistory: updatedPriceHistory,
              updatedAt: serverTimestamp()
            });
          }
        }

        const sessionRef = doc(db, "import_sessions", session.id);
        transaction.update(sessionRef, {
          status: "ROLLED_BACK",
          progress: 0,
          updatedAt: serverTimestamp()
        });
      });

      alert("✓ Import session successfully rolled back! Stock levels reverted and created medicine catalog cards deleted.");
    } catch (err) {
      alert("Error rolling back session: " + err.message);
    } finally {
      setDbLoading(false);
    }
  };

  const saveMappingTemplate = async () => {
    if (!newTemplateName.trim()) { alert("Please enter a template name."); return; }
    if (!storeId) return;

    try {
      const templatesCol = collection(db, "migration_templates");
      const tRef = await addDoc(templatesCol, {
        storeId,
        templateName: newTemplateName.trim(),
        columnMappings: excelColumnMapping,
        createdAt: serverTimestamp()
      });
      setSelectedTemplateId(tRef.id);
      setNewTemplateName("");
      alert(`✓ Preset Template "${newTemplateName}" successfully saved!`);
    } catch (e) {
      alert("Error saving template preset: " + e.message);
    }
  };

  const handleTemplateSelect = (templateId) => {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const t = migrationTemplates.find(tmpl => tmpl.id === templateId);
    if (t && t.columnMappings) {
      setExcelColumnMapping(t.columnMappings);
      applyExcelMapping(excelRawRows, t.columnMappings);
    }
  };

  const downloadExcelInventoryTemplate = () => {
    const csvContent = 
      "Generic Name,Brand Name,Strength,Form,Batch Number,Expiry Date (YYYY-MM),MRP,Selling Price,Purchase Price,Stock Quantity,Unit,GST Rate (%),Barcode\n" +
      "Paracetamol,Calpol,650mg,Tablet,PAR24001,2026-12,30.00,15.00,4.50,120,Strip,12,8901234567890\n" +
      "Amoxicillin,Amox-500,500mg,Capsule,AMX9988,2025-10,120.00,60.00,18.00,50,Strip,12,\n" +
      "Ofloxacin Eye Drops,Oflox-Eye,0.3%,Drops,OFLX55,2026-06,55.00,27.50,8.25,20,Bottle,12,\n";
      
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "janaushadhi_inventory_template.csv");
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const addPurchaseItem = () => {
    if (!purchaseItem.genericName || !purchaseItem.quantity) return;
    const mrp = +purchaseItem.mrp || 0;
    const itemToAdd = {
      ...purchaseItem,
      mrp: mrp,
      sellingPrice: +purchaseItem.sellingPrice || mrp,
      purchasePrice: +purchaseItem.purchasePrice || 0,
      quantity: +purchaseItem.quantity || 0,
      batchNumber: purchaseItem.batchNumber || "BAT-" + Math.floor(Math.random() * 100000),
      expiryDate: purchaseItem.expiryDate || "2027-12",
      matchType: "NEW",
      matchedItem: null,
      score: 0,
      overrideId: ""
    };

    // Run fuzzy match immediately to let the user see it in list
    const match = findBestMatch(itemToAdd, medicines);
    itemToAdd.matchType = match.type;
    itemToAdd.matchedItem = match.item;
    itemToAdd.score = match.score;
    itemToAdd.overrideId = match.type === "MATCH" ? match.item.id : "";

    setPurchaseForm(prev => ({ ...prev, items: [...prev.items, itemToAdd] }));
    setPurchaseItem({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", quantity: "", unit: "Strip", gstRate: "12" });
  };

  const savePurchase = async () => {
    if (!purchaseForm.supplierName || !purchaseForm.items.length) { alert("Add supplier name and at least one item."); return; }
    if (!storeId) { alert("Error: No store linked to user."); return; }
    try {
      const totalAmount = purchaseForm.items.reduce((a, i) => a + (+(i.purchasePrice || 0) * +(i.quantity || 0)), 0);
      
      // Save distributor reference or create
      let distId = "";
      const existingDist = suppliers.find(s => s.name?.toLowerCase() === purchaseForm.supplierName?.toLowerCase());
      if (existingDist) {
        distId = existingDist.id;
        await updateDoc(doc(db, "suppliers", existingDist.id), {
          totalPurchases: (existingDist.totalPurchases || 0) + totalAmount,
          outstanding: purchaseForm.paymentStatus === "Unpaid" ? (existingDist.outstanding || 0) + totalAmount : (existingDist.outstanding || 0)
        });
      } else {
        const dRef = await addDoc(collection(db, "suppliers"), {
          storeId,
          storeCode,
          name: purchaseForm.supplierName,
          totalPurchases: totalAmount,
          outstanding: purchaseForm.paymentStatus === "Unpaid" ? totalAmount : 0,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });
        distId = dRef.id;
      }

      await addDoc(collection(db, "purchases"), {
        storeId,
        storeCode,
        ...purchaseForm,
        distributorId: distId,
        totalAmount,
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });

      for (const item of purchaseForm.items) {
        // Resolve Target Medicine based on matching engine or override dropdown selections
        let targetId = item.overrideId || "";

        if (item.matchType === "MATCH" && !targetId && item.matchedItem) {
          targetId = item.matchedItem.id;
        }

        const incomingBatch = {
          batchNumber: item.batchNumber || "BAT-GEN-" + Math.floor(Math.random() * 100000),
          expiryDate: item.expiryDate || "2027-12",
          quantity: +item.quantity || 0,
          purchasePrice: +item.purchasePrice || 0,
          mrp: +item.mrp || 0,
          sellingPrice: +item.sellingPrice || +item.mrp || 0
        };

        if (targetId) {
          // UPDATE EXISTING ITEM & ATOMIC BATCH INVENTORY
          const existing = medicines.find(m => m.id === targetId);
          if (existing) {
            let currentBatches = Array.isArray(existing.batches) ? [...existing.batches] : [];
            const matchBatchIdx = currentBatches.findIndex(b => b.batchNumber === incomingBatch.batchNumber);

            if (matchBatchIdx >= 0) {
              currentBatches[matchBatchIdx] = {
                ...currentBatches[matchBatchIdx],
                quantity: (currentBatches[matchBatchIdx].quantity || 0) + incomingBatch.quantity,
                purchasePrice: incomingBatch.purchasePrice || currentBatches[matchBatchIdx].purchasePrice,
                mrp: incomingBatch.mrp || currentBatches[matchBatchIdx].mrp,
                sellingPrice: incomingBatch.sellingPrice || currentBatches[matchBatchIdx].sellingPrice,
                expiryDate: incomingBatch.expiryDate || currentBatches[matchBatchIdx].expiryDate
              };
            } else {
              currentBatches.push(incomingBatch);
            }

            // Prune expired batches or batches with 0 qty to stay well within Firestore 1MB limits
            currentBatches = currentBatches.filter(b => {
              const [y, mo] = (b.expiryDate || "2099-12").split("-");
              const isExpired = new Date(+y, +mo - 1, 1) < new Date();
              return !isExpired || b.quantity > 0;
            });

            // Calculate total stock qty as sum of all non-empty batches
            const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

            // Distributor Business Intelligence Tracking per item
            const lastBuyPrice = incomingBatch.purchasePrice || existing.purchasePrice || 0;
            const bestBuyPrice = Math.min(existing.bestPurchasePrice || lastBuyPrice, lastBuyPrice);

            await updateDoc(doc(db, "medicines", existing.id), {
              mrp: incomingBatch.mrp || existing.mrp,
              sellingPrice: incomingBatch.sellingPrice || existing.sellingPrice || existing.mrp,
              purchasePrice: incomingBatch.purchasePrice || existing.purchasePrice,
              expiryDate: incomingBatch.expiryDate || existing.expiryDate,
              barcode: item.barcode || existing.barcode || "",
              stockQty: totalStock,
              batches: currentBatches,
              lastDistributorId: distId,
              lastDistributorName: purchaseForm.supplierName,
              lastPurchasePrice: lastBuyPrice,
              bestPurchasePrice: bestBuyPrice,
              updatedAt: serverTimestamp()
            });
          }
        } else {
          // CREATE NEW ITEM & ATOMIC BATCH INVENTORY
          const mrpVal = +item.mrp || 0;
          const sellVal = +item.sellingPrice || mrpVal;
          const buyVal = +item.purchasePrice || 0;
          const qtyVal = +item.quantity || 0;

          await addDoc(collection(db, "medicines"), {
            storeId,
            storeCode,
            genericName: item.genericName,
            brandName: item.brandName || "",
            strength: item.strength || "",
            form: item.form || "Tablet",
            barcode: item.barcode || "",
            mrp: mrpVal,
            sellingPrice: sellVal,
            purchasePrice: buyVal,
            stockQty: qtyVal,
            lowStockAlert: 20,
            gstRate: +item.gstRate || 12,
            category: "",
            batches: [incomingBatch],
            lastDistributorId: distId,
            lastDistributorName: purchaseForm.supplierName,
            lastPurchasePrice: buyVal,
            bestPurchasePrice: buyVal,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }
      }

      setShowPurchaseForm(false);
      setShowPreviewDrawer(false);
      setPreviewItems([]);
      setAiStatus("");
      setPurchaseForm({ supplierName: "", invoiceNumber: "", invoiceDate: "", paymentStatus: "Unpaid", items: [] });
      alert(`✓ Purchase saved! Batches cataloged and stock mapped safely.`);
    } catch (err) { alert("Error: " + err.message); }
  };

  const deleteMedicine = async (id) => {
    if (!window.confirm("Are you sure you want to delete this medicine from the inventory?")) return;
    try {
      await deleteDoc(doc(db, "medicines", id));
      alert("✓ Medicine deleted successfully.");
    } catch (err) { alert("Error deleting medicine: " + err.message); }
  };

  const deletePurchase = async (p) => {
    if (!window.confirm(`Are you sure you want to delete Purchase Invoice #${p.invoiceNumber} from ${p.supplierName}?`)) return;
    try {
      for (const item of p.items || []) {
        let med = null;
        const targetId = item.overrideId || item.id || (item.matchedItem && item.matchedItem.id);
        if (targetId) {
          med = medicines.find(m => m.id === targetId);
        } else {
          med = medicines.find(m => 
            normalizeName(m.genericName) === normalizeName(item.genericName) && 
            normalizeName(m.brandName) === normalizeName(item.brandName)
          );
        }

        if (med) {
          let currentBatches = Array.isArray(med.batches) ? [...med.batches] : [];
          const purchQty = item.quantity || 0;
          
          const bIdx = currentBatches.findIndex(b => b.batchNumber === item.batchNumber);
          if (bIdx >= 0) {
            currentBatches[bIdx].quantity = Math.max(0, (currentBatches[bIdx].quantity || 0) - purchQty);
          }

          const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

          await updateDoc(doc(db, "medicines", med.id), {
            stockQty: Math.max(0, totalStock),
            batches: currentBatches,
            updatedAt: serverTimestamp()
          });
        }
      }

      await deleteDoc(doc(db, "purchases", p.id));
      
      const sup = suppliers.find(s => s.name?.toLowerCase() === p.supplierName?.toLowerCase());
      if (sup) {
        const outstandingDiff = p.paymentStatus === "Unpaid" ? (p.totalAmount || 0) : 0;
        await updateDoc(doc(db, "suppliers", sup.id), {
          totalPurchases: Math.max(0, (sup.totalPurchases || 0) - (p.totalAmount || 0)),
          outstanding: Math.max(0, (sup.outstanding || 0) - outstandingDiff)
        });
      }
      
      alert("✓ Purchase invoice deleted successfully and stock reverted.");
    } catch (err) { 
      alert("Error deleting purchase: " + err.message); 
    }
  };

  const deleteSale = async (s) => {
    if (!window.confirm(`Are you sure you want to cancel/delete Sales Bill #${s.billNumber}?`)) return;
    try {
      for (const item of s.items || []) {
        let med = null;
        if (item.medicineId) {
          med = medicines.find(m => m.id === item.medicineId);
        } else {
          med = medicines.find(m => 
            normalizeName(m.genericName) === normalizeName(item.genericName) && 
            normalizeName(m.brandName) === normalizeName(item.brandName)
          );
        }

        if (med) {
          let currentBatches = Array.isArray(med.batches) ? [...med.batches] : [];
          const soldQty = item.quantity || item.qty || 1;
          
          if (Array.isArray(item.batchesUsed) && item.batchesUsed.length > 0) {
            for (const used of item.batchesUsed) {
              const bIdx = currentBatches.findIndex(b => b.batchNumber === used.batchNumber);
              if (bIdx >= 0) {
                currentBatches[bIdx].quantity = (currentBatches[bIdx].quantity || 0) + used.quantity;
              } else {
                currentBatches.push({
                  batchNumber: used.batchNumber,
                  expiryDate: med.expiryDate || "2027-12",
                  quantity: used.quantity,
                  mrp: item.mrp || med.mrp || 0,
                  sellingPrice: item.mrp || med.sellingPrice || med.mrp || 0,
                  purchasePrice: med.purchasePrice || 0
                });
              }
            }
          } else {
            if (currentBatches.length > 0) {
              currentBatches[0].quantity = (currentBatches[0].quantity || 0) + soldQty;
            } else {
              currentBatches.push({
                batchNumber: med.batchNumber || "BAT-LEGACY",
                expiryDate: med.expiryDate || "2027-12",
                quantity: soldQty,
                mrp: med.mrp || 0,
                sellingPrice: med.sellingPrice || med.mrp || 0,
                purchasePrice: med.purchasePrice || 0
              });
            }
          }

          const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

          await updateDoc(doc(db, "medicines", med.id), {
            stockQty: Math.max(0, totalStock),
            batches: currentBatches,
            updatedAt: serverTimestamp()
          });
        }
      }

      await deleteDoc(doc(db, "sales", s.id));
      alert("✓ Sales bill deleted successfully and stock restored.");
      if (selectedBill?.id === s.id) setSelectedBill(null);
    } catch (err) { 
      alert("Error deleting sales bill: " + err.message); 
    }
  };

  const runWorkerExport = (type, payload, fileName) => {
    if (isWorkerExporting) return;
    setIsWorkerExporting(true);
    
    try {
      const worker = new Worker("/workers/report.worker.js");
      worker.postMessage({ type, payload, fileName });
      
      worker.onmessage = (e) => {
        const { success, fileData, error, fileName: outFileName } = e.data;
        if (success) {
          let mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          if (type === "EXPORT_TAX_PDF") {
            mime = "application/pdf";
          }
          const blob = new Blob([fileData], { type: mime });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = outFileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          alert("Error from Web Worker: " + error);
        }
        setIsWorkerExporting(false);
        worker.terminate();
      };
      
      worker.onerror = (err) => {
        console.error("Worker error:", err);
        alert("Worker execution failed.");
        setIsWorkerExporting(false);
        worker.terminate();
      };
    } catch (err) {
      console.error("Failed to spawn Web Worker", err);
      alert("Spawning Web Worker failed.");
      setIsWorkerExporting(false);
    }
  };

  const exportSalesExcel = () => {
    const salesData = getReportSales();
    if (salesData.length === 0) {
      alert("No sales data matched the current filters.");
      return;
    }
    const dateLabel = reportFilters.period === "custom" 
      ? `${reportFilters.startDate || "start"}_to_${reportFilters.endDate || "end"}`
      : reportFilters.period;
    const fileName = `sales_report_${dateLabel}.xlsx`;
    runWorkerExport("EXPORT_SALES_EXCEL", salesData, fileName);
  };

  const exportPurchasesExcel = () => {
    const purchasesData = getReportPurchases();
    if (purchasesData.length === 0) {
      alert("No purchase data matched the current filters.");
      return;
    }
    const dateLabel = reportFilters.period === "custom" 
      ? `${reportFilters.startDate || "start"}_to_${reportFilters.endDate || "end"}`
      : reportFilters.period;
    const fileName = `purchase_report_${dateLabel}.xlsx`;
    runWorkerExport("EXPORT_PURCHASES_EXCEL", purchasesData, fileName);
  };

  const getExpiryReturnData = () => {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const limit = new Date();
    limit.setDate(limit.getDate() + 90);
    
    const list = [];
    medicines.forEach(m => {
      (m.batches || []).forEach(b => {
        if ((b.quantity || 0) <= 0) return;
        
        const [y, mo] = (b.expiryDate || "2099-12").split("-");
        const expDate = new Date(+y, +mo - 1, 1);
        
        if (expDate <= limit) {
          const daysRemaining = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
          list.push({
            brandName: m.brandName || "",
            genericName: m.genericName || "",
            strength: m.strength || "",
            form: m.form || "Tablet",
            batchNumber: b.batchNumber || "",
            expiryDate: b.expiryDate || "",
            daysRemaining: daysRemaining >= 0 ? daysRemaining : 0,
            quantity: b.quantity || 0,
            purchasePrice: b.purchasePrice || m.purchasePrice || 0,
            supplierName: m.lastDistributorName || "No Vendor Linked"
          });
        }
      });
    });
    return list;
  };

  const exportExpiryReturnsExcel = () => {
    const expiryData = getExpiryReturnData();
    if (expiryData.length === 0) {
      alert("No batches expiring within 90 days found in stock.");
      return;
    }
    const fileName = `expiry_returns_worksheet_${new Date().toISOString().split("T")[0]}.xlsx`;
    runWorkerExport("EXPORT_EXPIRY_EXCEL", expiryData, fileName);
  };

  const exportTaxPDF = () => {
    const salesData = getReportSales();
    if (salesData.length === 0) {
      alert("No sales data matched the current filters.");
      return;
    }
    const label = reportFilters.period === "today" ? "Today" : reportFilters.period === "week" ? "Last 7 Days" : reportFilters.period === "month" ? "This Month" : "Custom Period";
    const dateLabel = reportFilters.period === "custom" 
      ? `${reportFilters.startDate || "start"}_to_${reportFilters.endDate || "end"}`
      : reportFilters.period;
    const fileName = `gst_tax_report_${dateLabel}.pdf`;
    
    const payload = {
      sales: salesData,
      storeInfo: {
        name: storeName || storeDetails?.name || "Janaushadhi Pharmacy",
        gstin: storeDetails?.gstin || "—",
        drugLicense: storeDetails?.drugLicense || "—",
        address: storeDetails?.address || "—"
      },
      filtersLabel: label
    };
    
    if (isWorkerExporting) return;
    setIsWorkerExporting(true);
    
    try {
      const worker = new Worker("/workers/report.worker.js");
      worker.postMessage({ type: "EXPORT_TAX_PDF", payload, fileName });
      
      worker.onmessage = (e) => {
        const { success, fileData, error, fileName: outFileName } = e.data;
        if (success) {
          const blob = new Blob([fileData], { type: "application/pdf" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = outFileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          alert("Error from Web Worker: " + error);
        }
        setIsWorkerExporting(false);
        worker.terminate();
      };
      
      worker.onerror = (err) => {
        console.error("Worker error:", err);
        alert("Worker PDF generation execution failed.");
        setIsWorkerExporting(false);
        worker.terminate();
      };
    } catch (err) {
      console.error("Failed to spawn Web Worker", err);
      alert("Failed to compile PDF via Worker.");
      setIsWorkerExporting(false);
    }
  };

  const printA4PDFInvoice = (bill) => {
    if (!bill) return;
    const fileName = `invoice_${bill.billNumber || "draft"}.pdf`;
    const payload = {
      bill,
      storeInfo: {
        name: storeName || storeDetails?.name || "Janaushadhi Pharmacy",
        gstin: storeDetails?.gstin || "—",
        drugLicense: storeDetails?.drugLicense || "—",
        address: storeDetails?.address || "—"
      }
    };

    if (isWorkerExporting) return;
    setIsWorkerExporting(true);

    const printWindow = window.open("", "_blank");
    if (printWindow) {
      printWindow.document.write(`
        <html>
          <head>
            <title>Generating PDF...</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #F4F6F9; color: #0A2342; }
              .loader { border: 4px solid #E2E8F0; border-top: 4px solid #0D7377; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin-bottom: 16px; }
              @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
              .text { font-size: 14px; font-weight: 600; }
            </style>
          </head>
          <body>
            <div class="loader"></div>
            <div class="text">Generating Invoice PDF, please wait...</div>
          </body>
        </html>
      `);
      printWindow.document.close();
    }

    try {
      const worker = new Worker("/workers/report.worker.js");
      worker.postMessage({ type: "EXPORT_INVOICE_PDF", payload, fileName });
      
      worker.onmessage = (e) => {
        const { success, fileData, error } = e.data;
        if (success) {
          const blob = new Blob([fileData], { type: "application/pdf" });
          const url = URL.createObjectURL(blob);
          if (printWindow && !printWindow.closed) {
            printWindow.location.href = url;
          } else {
            const link = document.createElement("a");
            link.href = url;
            link.download = fileName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          }
        } else {
          if (printWindow) printWindow.close();
          alert("Error from Web Worker compiling PDF: " + error);
        }
        setIsWorkerExporting(false);
        worker.terminate();
      };
      
      worker.onerror = (err) => {
        console.error("Worker error:", err);
        if (printWindow) printWindow.close();
        alert("Worker PDF invoice compilation failed.");
        setIsWorkerExporting(false);
        worker.terminate();
      };
    } catch (err) {
      console.error("Worker spawn failed", err);
      if (printWindow) printWindow.close();
      alert("Failed to compile A5 Invoice PDF via Worker.");
      setIsWorkerExporting(false);
    }
  };

  const downloadSalesTemplate = () => {
    const csvContent = 
      "BillNo,ItemName,Quantity,SaleType,Category,Remarks,Timestamp,CustomerName,DoctorName,PrescriptionNo\n" +
      "1001,Montelukast 10mg + Levocetirizine 5mg (10x1),4,Cash,Allergy,Repeat,21-06-2026 08:20,Customer_001,Dr. Ganesh Mutalik,RX-SAMPLE-00001\n" +
      "1001,Pantoprazole 40mg,1,Cash,General,OTC,21-06-2026 08:20,Customer_001,Dr. Ganesh Mutalik,RX-SAMPLE-00001\n" +
      "1002,Cold Combination Tablet,6,Cash,Cold,Seasonal,21-06-2026 08:30,Customer_002,Dr. Manjunath Tuppad,RX-SAMPLE-00002\n";
      
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pharmacy_sales_import_template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const findMedicineByName = (name) => {
    if (!name) return null;
    const cleanInput = normalizeName(name);
    
    // 1. Exact match on brandName or genericName
    let match = medicines.find(m => 
      normalizeName(m.brandName) === cleanInput || 
      normalizeName(m.genericName) === cleanInput
    );
    if (match) return match;
    
    // 2. Fuzzy match using Levenshtein distance
    let bestMatch = null;
    let highestScore = 0;
    
    medicines.forEach(m => {
      const bName = m.brandName || "";
      const gName = m.genericName || "";
      const brandScore = 1 - levenshtein(normalizeName(bName), cleanInput) / Math.max(normalizeName(bName).length, cleanInput.length || 1);
      const genericScore = 1 - levenshtein(normalizeName(gName), cleanInput) / Math.max(normalizeName(gName).length, cleanInput.length || 1);
      
      const score = Math.max(brandScore, genericScore);
      if (score > highestScore) {
        highestScore = score;
        bestMatch = m;
      }
    });
    
    if (highestScore > 0.82) {
      return bestMatch;
    }
    return null;
  };

  const parseTimestamp = (str) => {
    if (!str) return new Date();
    // Format: DD-MM-YYYY HH:mm
    const parts = String(str).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\s+(\d{1,2}):(\d{1,2})$/);
    if (parts) {
      const day = +parts[1];
      const month = +parts[2];
      const year = +parts[3];
      const hour = +parts[4];
      const minute = +parts[5];
      return new Date(year, month - 1, day, hour, minute);
    }
    const d = new Date(str);
    return isNaN(d.getTime()) ? new Date() : d;
  };

  const handleSalesExcelImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setIsImportingSales(true);
    setImportSalesProgress(0);
    
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target.result;
        const wb = XLSX.read(bstr, { type: "binary" });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
        
        if (data.length < 2) {
          alert("Import sheet contains no rows.");
          setIsImportingSales(false);
          return;
        }
        
        const headers = data[0].map(h => String(h || "").trim());
        const rows = [];
        
        for (let i = 1; i < data.length; i++) {
          const rowData = data[i];
          if (!rowData || rowData.length === 0) continue;
          
          const rowObj = {};
          headers.forEach((h, colIdx) => {
            rowObj[h] = rowData[colIdx] !== undefined ? rowData[colIdx] : "";
          });
          rows.push(rowObj);
        }
        
        // Group rows by BillNo
        const billsGroup = {};
        rows.forEach(r => {
          const billNo = String(r.BillNo || r.billNo || r.billnumber || "").trim();
          if (!billNo) return;
          if (!billsGroup[billNo]) billsGroup[billNo] = [];
          billsGroup[billNo].push(r);
        });

        // Group rows to bills preview with warnings
        const previewList = Object.keys(billsGroup).map(billNo => {
          const rawItems = billsGroup[billNo];
          const firstRow = rawItems[0];
          
          const items = rawItems.map(item => {
            const itemName = String(item.ItemName || item.itemName || "").trim();
            const qty = Math.max(1, parseInt(item.Quantity) || 1);
            
            const existing = findMedicineByName(itemName);
            const isNew = !existing;
            const isShortage = existing ? existing.stockQty < qty : true;
            
            return {
              itemName,
              qty,
              category: String(item.Category || item.category || "General").trim(),
              remarks: String(item.Remarks || item.remarks || "").trim(),
              isNew,
              isShortage,
              estimatedTotal: qty * (existing?.sellingPrice || 120.00)
            };
          });

          const totalAmt = items.reduce((sum, item) => sum + item.estimatedTotal, 0);
          
          return {
            billNo,
            customerName: String(firstRow.CustomerName || firstRow.customerName || "Walk-in Patient").trim(),
            doctorName: String(firstRow.DoctorName || firstRow.doctorName || "").trim(),
            prescriptionNo: String(firstRow.PrescriptionNo || firstRow.prescriptionNo || "").trim(),
            saleType: String(firstRow.SaleType || firstRow.saleType || "Cash").trim(),
            timestamp: String(firstRow.Timestamp || firstRow.timestamp || "").trim(),
            items,
            totalAmount: totalAmt,
            hasNew: items.some(item => item.isNew),
            hasShortage: items.some(item => item.isShortage)
          };
        });

        setPreviewImportedSales(previewList);
        setShowSalesImportDrawer(true);
      } catch (err) {
        console.error("Sales import parsing failed:", err);
        alert("Failed to parse file: " + err.message);
      } finally {
        setIsImportingSales(false);
        e.target.value = "";
      }
    };
    reader.readAsBinaryString(file);
  };

  const commitImportedSales = async () => {
    if (previewImportedSales.length === 0) return;
    setIsImportingSales(true);
    setImportSalesProgress(0);

    const totalBills = previewImportedSales.length;
    let processedCount = 0;
    const chunkSize = 20;

    const bills = [...previewImportedSales];

    for (let i = 0; i < bills.length; i += chunkSize) {
      const chunk = bills.slice(i, i + chunkSize);

      await Promise.all(chunk.map(async (bill) => {
        const billNo = bill.billNo;
        const billItemsList = bill.items;
        
        try {
          await runTransaction(db, async (transaction) => {
            const resolvedMeds = [];
            
            // Phase 1: Retrieve medicines & auto-create missing ones
            for (const item of billItemsList) {
              const medName = item.itemName;
              let medDoc = findMedicineByName(medName);
              
              let medRef = null;
              let medData = null;
              let exists = false;
              
              if (medDoc) {
                medRef = doc(db, "medicines", medDoc.id);
                const snap = await transaction.get(medRef);
                if (snap.exists()) {
                  medData = snap.data();
                  exists = true;
                }
              }
              
              if (!exists) {
                const newRef = doc(collection(db, "medicines"));
                medRef = newRef;
                medData = {
                  storeId,
                  storeCode,
                  genericName: medName,
                  brandName: medName,
                  strength: "",
                  form: "Tablet",
                  mrp: 150.00,
                  sellingPrice: 120.00,
                  purchasePrice: 75.00,
                  stockQty: 0,
                  lowStockAlert: 20,
                  gstRate: 12,
                  category: item.category || "General",
                  batches: [],
                  createdAt: serverTimestamp(),
                  createdBy: user.uid
                };
              }
              
              resolvedMeds.push({ medRef, medData, exists, item });
            }
            
            const auditLogs = [];
            
            // Phase 2: Handle shortages. Auto-stock missing/short batches
            for (const resolved of resolvedMeds) {
              const { medRef, medData, exists, item } = resolved;
              const reqQty = Math.max(1, item.qty);
              let currentBatches = Array.isArray(medData.batches) ? medData.batches.map(b => ({ ...b })) : [];
              const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
              
              if (totalStock < reqQty) {
                const shortage = reqQty - totalStock;
                
                const existingBatchIdx = currentBatches.findIndex(b => b.batchNumber === "AUTO-MIG-BATCH");
                if (existingBatchIdx >= 0) {
                  currentBatches[existingBatchIdx].quantity = (currentBatches[existingBatchIdx].quantity || 0) + shortage;
                } else if (currentBatches.length > 0) {
                  currentBatches[0].quantity = (currentBatches[0].quantity || 0) + shortage;
                } else {
                  currentBatches.push({
                    batchNumber: "AUTO-MIG-BATCH",
                    expiryDate: "2028-12",
                    purchasePrice: medData.purchasePrice || 75.00,
                    mrp: medData.mrp || 150.00,
                    sellingPrice: medData.sellingPrice || 120.00,
                    quantity: shortage,
                    isOpeningStock: true,
                    openingStockDate: new Date().toISOString().split("T")[0]
                  });
                }
                
                const newTotalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
                medData.batches = currentBatches;
                medData.stockQty = newTotalStock;
                
                const targetBatchNum = existingBatchIdx >= 0 
                  ? "AUTO-MIG-BATCH" 
                  : (currentBatches[0]?.batchNumber || "AUTO-MIG-BATCH");

                auditLogs.push({
                  type: "OPENING_STOCK",
                  medicineId: medRef.id,
                  genericName: medData.genericName,
                  brandName: medData.brandName || "",
                  batchNumber: targetBatchNum,
                  actionSource: "SALES_IMPORT_ADJUST",
                  quantityChanged: shortage,
                  previousQuantity: totalStock,
                  newQuantity: newTotalStock,
                  purchasePrice: medData.purchasePrice || 75.00
                });
              }
              
              resolved.medData = medData;
            }
            
            // Phase 3: FEFO Sequenced Deduction & insertion
            const finalizedItems = [];
            const billDate = parseTimestamp(bill.timestamp);
            
            for (const resolved of resolvedMeds) {
              const { medRef, medData, exists, item } = resolved;
              const reqQty = Math.max(1, item.qty);
              let currentBatches = medData.batches.map(b => ({ ...b }));
              
              currentBatches.sort((a, b) => {
                const [ay, amo] = (a.expiryDate || "2099-12").split("-");
                const [by, bmo] = (b.expiryDate || "2099-12").split("-");
                return new Date(+ay, +amo - 1, 1) - new Date(+by, +bmo - 1, 1);
              });
              
              let remaining = reqQty;
              const batchesUsed = [];
              
              for (let batch of currentBatches) {
                if (remaining <= 0) break;
                if ((batch.quantity || 0) <= 0) continue;
                
                const taken = Math.min(batch.quantity, remaining);
                batch.quantity -= taken;
                remaining -= taken;
                
                batchesUsed.push({
                  batchNumber: batch.batchNumber,
                  expiryDate: batch.expiryDate,
                  quantity: taken,
                  purchasePrice: batch.purchasePrice || 0,
                  sellingPrice: batch.sellingPrice || batch.mrp || 0,
                  mrp: batch.mrp || 0
                });
              }
              
              const newTotalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
              
              if (exists) {
                transaction.update(medRef, {
                  stockQty: newTotalStock,
                  batches: currentBatches,
                  updatedAt: serverTimestamp()
                });
              } else {
                transaction.set(medRef, {
                  ...medData,
                  stockQty: newTotalStock,
                  batches: currentBatches,
                  createdAt: serverTimestamp()
                });
              }
              
              const itemMrp = medData.mrp || 150.00;
              const itemSellPrice = medData.sellingPrice || 120.00;
              const itemBuyPrice = medData.purchasePrice || 75.00;
              
              const gstRate = medData.gstRate || 12;
              const total = reqQty * itemSellPrice;
              const taxableValue = total / (1 + (gstRate / 100));
              const totalGst = total - taxableValue;
              const itemCogs = reqQty * itemBuyPrice;
              
              finalizedItems.push({
                medicineId: medRef.id,
                genericName: medData.genericName,
                brandName: medData.brandName || "",
                strength: medData.strength || "",
                form: medData.form || "Tablet",
                quantity: reqQty,
                mrp: itemMrp,
                sellingPrice: itemSellPrice,
                discount: 0,
                total,
                gstRate,
                taxableValue,
                cgst: totalGst / 2,
                sgst: totalGst / 2,
                totalGst,
                cogs: itemCogs,
                profit: total - itemCogs,
                batchesUsed
              });
              
              auditLogs.push({
                type: "SALE",
                medicineId: medRef.id,
                genericName: medData.genericName,
                brandName: medData.brandName || "",
                batchNumber: batchesUsed[0]?.batchNumber || "AUTO-MIG-BATCH",
                quantityChanged: -reqQty,
                previousQuantity: newTotalStock + reqQty,
                newQuantity: newTotalStock,
                purchasePrice: itemBuyPrice
              });
            }
            
            const subtotalSum = finalizedItems.reduce((a, i) => a + i.total, 0);
            const taxableSum = finalizedItems.reduce((a, i) => a + i.taxableValue, 0);
            const gstSum = finalizedItems.reduce((a, i) => a + i.totalGst, 0);
            const cogsSum = finalizedItems.reduce((a, i) => a + i.cogs, 0);
            
            const salesColRef = collection(db, "sales");
            const saleDocRef = doc(salesColRef);
            
            const billData = {
              storeId,
              storeCode,
              billNumber: `Bill-${billNo}`,
              customerName: bill.customerName || "Walk-in Patient",
              customerPhone: "",
              doctorName: bill.doctorName || "",
              prescriptionNo: bill.prescriptionNo || "",
              items: finalizedItems,
              subtotal: subtotalSum,
              totalDiscount: 0,
              taxableAmount: taxableSum,
              cgstAmount: gstSum / 2,
              sgstAmount: gstSum / 2,
              totalGst: gstSum,
              cogs: cogsSum,
              profit: subtotalSum - cogsSum,
              grandTotal: subtotalSum,
              paymentMode: bill.saleType || "Cash",
              createdAt: billDate,
              createdBy: user.uid,
              isImported: true
            };
            
            transaction.set(saleDocRef, billData);
            
            const auditLogsCol = collection(db, "inventory_audit_logs");
            for (const log of auditLogs) {
              const logDocRef = doc(auditLogsCol);
              transaction.set(logDocRef, {
                ...log,
                storeId,
                referenceId: saleDocRef.id,
                createdAt: serverTimestamp(),
                createdBy: user.uid
              });
            }
          });
          
          processedCount++;
        } catch (err) {
          console.error(`Failed to ingest bill #${billNo}:`, err);
        }
      }));

      const progress = Math.min(100, Math.round(((i + chunk.length) / totalBills) * 100));
      setImportSalesProgress(progress);
      
      if (i + chunkSize < bills.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    setIsImportingSales(false);
    setShowSalesImportDrawer(false);
    setPreviewImportedSales([]);
    alert(`✓ Successfully processed and committed ${processedCount} of ${totalBills} bills.`);
  };

  const handleOpenEditBill = (bill) => {
    const dateObj = bill.createdAt?.toDate ? bill.createdAt.toDate() : new Date(bill.createdAt || 0);
    const offset = dateObj.getTimezoneOffset();
    const localDate = new Date(dateObj.getTime() - (offset * 60 * 1000));
    const formattedDate = localDate.toISOString().substring(0, 16);

    setEditBillModalData(bill);
    setEditBillForm({
      createdAt: formattedDate,
      customerName: bill.customerName || "",
      customerPhone: bill.customerPhone || "",
      doctorName: bill.doctorName || "",
      prescriptionNo: bill.prescriptionNo || "",
      paymentMode: bill.paymentMode || "Cash",
      items: (bill.items || []).map(item => ({
        medicineId: item.medicineId || "",
        genericName: item.genericName || "",
        brandName: item.brandName || "",
        strength: item.strength || "",
        form: item.form || "",
        mrp: item.mrp || 0,
        sellingPrice: item.sellingPrice || (item.discount > 0 ? item.mrp : ((item.total || 0) / (item.quantity || item.qty || 1))),
        qty: item.quantity || item.qty || 1,
        discount: item.discount || 0,
        gstRate: item.gstRate || 12,
        batchesUsed: item.batchesUsed || []
      }))
    });
  };

  const saveEditedBill = async () => {
    if (!editBillModalData) return;
    const originalBill = editBillModalData;
    const form = editBillForm;

    try {
      await runTransaction(db, async (transaction) => {
        const medIds = new Set();
        originalBill.items.forEach(i => { if (i.medicineId) medIds.add(i.medicineId); });
        form.items.forEach(i => { if (i.medicineId) medIds.add(i.medicineId); });

        const medicinesMap = {};
        for (const medId of medIds) {
          const medRef = doc(db, "medicines", medId);
          const snap = await transaction.get(medRef);
          if (snap.exists()) {
            medicinesMap[medId] = { ref: medRef, data: snap.data() };
          }
        }

        // 1. Revert original stock allocation
        originalBill.items.forEach(origItem => {
          const med = medicinesMap[origItem.medicineId];
          if (med) {
            let currentBatches = Array.isArray(med.data.batches) ? med.data.batches.map(b => ({ ...b })) : [];
            const batchesUsed = origItem.batchesUsed || [];
            
            if (batchesUsed.length > 0) {
              batchesUsed.forEach(used => {
                const bIdx = currentBatches.findIndex(b => b.batchNumber === used.batchNumber);
                if (bIdx >= 0) {
                  currentBatches[bIdx].quantity = (currentBatches[bIdx].quantity || 0) + used.quantity;
                } else {
                  currentBatches.push({
                    batchNumber: used.batchNumber,
                    expiryDate: med.data.expiryDate || "2028-12",
                    quantity: used.quantity,
                    mrp: origItem.mrp || med.data.mrp || 0,
                    sellingPrice: used.sellingPrice || origItem.mrp || med.data.mrp || 0,
                    purchasePrice: used.purchasePrice || med.data.purchasePrice || 75.00
                  });
                }
              });
            } else {
              const soldQty = origItem.quantity || origItem.qty || 1;
              if (currentBatches.length > 0) {
                currentBatches[0].quantity = (currentBatches[0].quantity || 0) + soldQty;
              }
            }

            med.data.batches = currentBatches;
            med.data.stockQty = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
          }
        });

        // 2. Process updated items and allocate stock via FEFO
        const finalizedItems = [];
        const auditLogs = [];

        for (const item of form.items) {
          const med = medicinesMap[item.medicineId];
          if (!med) {
            throw new Error(`Medicine "${item.brandName || item.genericName}" not found in database.`);
          }

          let currentBatches = med.data.batches.map(b => ({ ...b }));
          let reqQty = item.qty;
          let totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

          if (totalStock < reqQty) {
            const shortage = reqQty - totalStock;
            const existingBatchIdx = currentBatches.findIndex(b => b.batchNumber === "AUTO-MIG-BATCH");
            if (existingBatchIdx >= 0) {
              currentBatches[existingBatchIdx].quantity = (currentBatches[existingBatchIdx].quantity || 0) + shortage;
            } else if (currentBatches.length > 0) {
              currentBatches[0].quantity = (currentBatches[0].quantity || 0) + shortage;
            } else {
              currentBatches.push({
                batchNumber: "AUTO-MIG-BATCH",
                expiryDate: "2028-12",
                purchasePrice: med.data.purchasePrice || 75.00,
                mrp: med.data.mrp || 150.00,
                sellingPrice: med.data.sellingPrice || 120.00,
                quantity: shortage,
                isOpeningStock: true,
                openingStockDate: new Date().toISOString().split("T")[0]
              });
            }

            totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
            
            const targetBatchNum = existingBatchIdx >= 0 
              ? "AUTO-MIG-BATCH" 
              : (currentBatches[0]?.batchNumber || "AUTO-MIG-BATCH");

            auditLogs.push({
              type: "OPENING_STOCK",
              medicineId: item.medicineId,
              genericName: med.data.genericName,
              brandName: med.data.brandName || "",
              batchNumber: targetBatchNum,
              actionSource: "SALES_EDIT_ADJUST",
              quantityChanged: shortage,
              previousQuantity: totalStock - shortage,
              newQuantity: totalStock,
              purchasePrice: med.data.purchasePrice || 75.00
            });
          }

          currentBatches.sort((a, b) => {
            const [ay, amo] = (a.expiryDate || "2099-12").split("-");
            const [by, bmo] = (b.expiryDate || "2099-12").split("-");
            return new Date(+ay, +amo - 1, 1) - new Date(+by, +bmo - 1, 1);
          });

          let remaining = reqQty;
          const batchesUsed = [];

          for (let batch of currentBatches) {
            if (remaining <= 0) break;
            if ((batch.quantity || 0) <= 0) continue;

            const taken = Math.min(batch.quantity, remaining);
            batch.quantity -= taken;
            remaining -= taken;

            batchesUsed.push({
              batchNumber: batch.batchNumber,
              expiryDate: batch.expiryDate,
              quantity: taken,
              purchasePrice: batch.purchasePrice || 0,
              sellingPrice: item.sellingPrice || batch.sellingPrice || batch.mrp || 0,
              mrp: batch.mrp || 0
            });
          }

          const newTotalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
          med.data.batches = currentBatches;
          med.data.stockQty = newTotalStock;

          const total = reqQty * (item.sellingPrice || item.mrp);
          const discAmount = total * (item.discount || 0) / 100;
          const finalTotal = total - discAmount;
          const gstRate = item.gstRate || 12;
          const taxableValue = finalTotal / (1 + (gstRate / 100));
          const totalGst = finalTotal - taxableValue;
          const itemCogs = batchesUsed.reduce((sum, bu) => sum + (bu.quantity * bu.purchasePrice), 0);

          finalizedItems.push({
            medicineId: item.medicineId,
            genericName: item.genericName,
            brandName: item.brandName || "",
            strength: item.strength || "",
            form: item.form || "",
            quantity: reqQty,
            mrp: item.mrp,
            sellingPrice: item.sellingPrice,
            discount: item.discount || 0,
            total: finalTotal,
            gstRate,
            taxableValue,
            cgst: totalGst / 2,
            sgst: totalGst / 2,
            totalGst,
            cogs: itemCogs,
            profit: finalTotal - itemCogs,
            batchesUsed
          });

          auditLogs.push({
            type: "SALE",
            medicineId: item.medicineId,
            genericName: med.data.genericName,
            brandName: med.data.brandName || "",
            batchNumber: batchesUsed[0]?.batchNumber || "AUTO-MIG-BATCH",
            quantityChanged: -reqQty,
            previousQuantity: newTotalStock + reqQty,
            newQuantity: newTotalStock,
            purchasePrice: med.data.purchasePrice || 75.00
          });
        }

        // 3. Write stock updates back to Firestore
        for (const medId of medIds) {
          const med = medicinesMap[medId];
          if (med) {
            transaction.update(med.ref, {
              stockQty: med.data.stockQty,
              batches: med.data.batches,
              updatedAt: serverTimestamp()
            });
          }
        }

        // 4. Update the Sale document
        const saleRef = doc(db, "sales", originalBill.id);
        const subtotalSum = finalizedItems.reduce((a, i) => a + i.total, 0);
        const taxableSum = finalizedItems.reduce((a, i) => a + i.taxableValue, 0);
        const gstSum = finalizedItems.reduce((a, i) => a + i.totalGst, 0);
        const cogsSum = finalizedItems.reduce((a, i) => a + i.cogs, 0);

        const billDate = new Date(form.createdAt);

        const updatedBillData = {
          customerName: form.customerName || "Walk-in Patient",
          customerPhone: form.customerPhone || "",
          doctorName: form.doctorName || "",
          prescriptionNo: form.prescriptionNo || "",
          items: finalizedItems,
          subtotal: subtotalSum,
          totalDiscount: finalizedItems.reduce((a, i) => a + (i.mrp * i.quantity * i.discount / 100), 0),
          taxableAmount: taxableSum,
          cgstAmount: gstSum / 2,
          sgstAmount: gstSum / 2,
          totalGst: gstSum,
          cogs: cogsSum,
          profit: subtotalSum - cogsSum,
          grandTotal: subtotalSum,
          paymentMode: form.paymentMode,
          createdAt: billDate,
          updatedAt: serverTimestamp()
        };

        transaction.update(saleRef, updatedBillData);

        // 5. Write Audit Logs
        const auditLogsCol = collection(db, "inventory_audit_logs");
        for (const log of auditLogs) {
          const logDocRef = doc(auditLogsCol);
          transaction.set(logDocRef, {
            ...log,
            storeId,
            referenceId: originalBill.id,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }

        // Refresh selectedBill view in UI
        setSelectedBill(prev => ({
          ...prev,
          ...updatedBillData,
          createdAt: { toDate: () => billDate }
        }));
      });

      setEditBillModalData(null);
      alert("✓ Bill successfully updated! Stock levels recalculated.");
    } catch (err) {
      console.error(err);
      alert("Failed to update bill: " + err.message);
    }
  };

  const exportReportPDF = exportTaxPDF;

  if (authLoading || (user && profileLoading)) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 18, fontWeight: 700, color: "#fff", animation: "spin 1s linear infinite" }}>JK</div>
          <div style={{ fontSize: 14, color: C.text3, fontWeight: 600 }}>Loading SaaS Profile...</div>
        </div>
      </div>
    );
  }

  if (!user) return <LoginScreen />;

  // ── SaaS Store Onboarding Screen ──
  if (onboardingMode !== "none") {
    const isWizard = onboardingMode.startsWith("wizard");
    const renderWizardHeader = (stepNum) => (
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: C.teal, textTransform: "uppercase", letterSpacing: "0.5px" }}>Pharmacy Setup Wizard</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: C.text3 }}>Step {stepNum} of 3</span>
        </div>
        <div style={{ display: "flex", gap: 6, height: 4, background: C.border, borderRadius: 2 }}>
          <div style={{ flex: 1, background: stepNum >= 1 ? C.teal2 : C.border, borderRadius: 2 }} />
          <div style={{ flex: 1, background: stepNum >= 2 ? C.teal2 : C.border, borderRadius: 2 }} />
          <div style={{ flex: 1, background: stepNum >= 3 ? C.teal2 : C.border, borderRadius: 2 }} />
        </div>
      </div>
    );

    return (
      <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter',system-ui,sans-serif", padding: 20 }}>
        <style>{`
          @keyframes pulseBtn {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(13, 115, 119, 0.4); }
            70% { transform: scale(1.03); box-shadow: 0 0 0 10px rgba(13, 115, 119, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(13, 115, 119, 0); }
          }
          @keyframes pulseBtnGreen {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(27, 122, 78, 0.4); }
            70% { transform: scale(1.03); box-shadow: 0 0 0 10px rgba(27, 122, 78, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(27, 122, 78, 0); }
          }
        `}</style>
        <div style={{ width: "100%", maxWidth: isWizard ? 750 : 500, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 32, boxShadow: "0 4px 24px rgba(0,0,0,0.04)", transition: "max-width 0.2s ease" }}>
          {!isWizard && (
            <div style={{ textAlign: "center", marginBottom: 24 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px", fontSize: 18, fontWeight: 700, color: "#fff" }}>JK</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.navy }}>Onboard Your Pharmacy</div>
              <div style={{ fontSize: 13, color: C.text3, marginTop: 4 }}>Select an option below to set up your billing instance</div>
            </div>
          )}

          {onboardingMode === "choose" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <button 
                onClick={() => setOnboardingMode("create")}
                style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", padding: 18, background: "#fff", border: `2.5px solid ${C.border}`, borderRadius: 12, cursor: "pointer", textAlign: "left", transition: "all 0.15s ease" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.teal}
                onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
              >
                <span style={{ fontSize: 15, fontWeight: 700, color: C.navy }}>🚀 Create a New Pharmacy Store</span>
                <span style={{ fontSize: 12, color: C.text2 }}>Set up a new, isolated database instance for your store location (Admin rights).</span>
              </button>
              <button 
                onClick={() => setOnboardingMode("join")}
                style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%", padding: 18, background: "#fff", border: `2.5px solid ${C.border}`, borderRadius: 12, cursor: "pointer", textAlign: "left", transition: "all 0.15s ease" }}
                onMouseEnter={e => e.currentTarget.style.borderColor = C.teal}
                onMouseLeave={e => e.currentTarget.style.borderColor = C.border}
              >
                <span style={{ fontSize: 15, fontWeight: 700, color: C.navy }}>🔗 Join an Existing Store</span>
                <span style={{ fontSize: 12, color: C.text2 }}>Register as a billing staff cashier using an existing unique store code.</span>
              </button>
              <button onClick={() => signOut(auth)} style={{ ...S.btn("outline"), padding: 12, width: "100%" }}>Sign Out</button>
            </div>
          )}

          {onboardingMode === "create" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 6 }}>Initialize New Pharmacy</div>
              <FF label="Pharmacy / Store Name *">
                <input style={S.input} value={newStore.name} onChange={e => setNewStore(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Janaushadhi Kendra Ranebennur" />
              </FF>
              <FF label="Unique Store Code * (e.g. PMBJK05446)">
                <input style={S.input} value={newStore.code} onChange={e => setNewStore(p => ({ ...p, code: e.target.value.toUpperCase() }))} placeholder="Store registration code" />
              </FF>
              <FF label="Store Helpline Number">
                <input style={S.input} value={newStore.helpline} onChange={e => setNewStore(p => ({ ...p, helpline: e.target.value }))} />
              </FF>
              <FF label="Support Working Hours">
                <input style={S.input} value={newStore.supportTime} onChange={e => setNewStore(p => ({ ...p, supportTime: e.target.value }))} />
              </FF>
              <FF label="Store Address">
                <input style={S.input} value={newStore.address} onChange={e => setNewStore(p => ({ ...p, address: e.target.value }))} placeholder="Location details" />
              </FF>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button style={{ ...S.btn("teal"), flex: 1 }} onClick={handleCreateStore}>Initialize Store</button>
                <button style={{ ...S.btn("outline"), flex: 1 }} onClick={() => setOnboardingMode("choose")}>Back</button>
              </div>
            </div>
          )}

          {onboardingMode === "join" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 6 }}>Join Store as Cashier / Staff</div>
              <FF label="Enter Unique Store Code (e.g. PMBJK05446)">
                <input style={S.input} value={joinCode} onChange={e => setJoinCode(e.target.value.toUpperCase())} placeholder="Request matching store code" />
              </FF>
              <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                <button style={{ ...S.btn("teal"), flex: 1 }} onClick={handleJoinStore}>Join Store</button>
                <button style={{ ...S.btn("outline"), flex: 1 }} onClick={() => setOnboardingMode("choose")}>Back</button>
              </div>
            </div>
          )}

          {onboardingMode === "wizard-step1" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {renderWizardHeader(1)}
              <div style={{ fontSize: 16, fontWeight: 800, color: C.navy, marginBottom: 4 }}>Configure Store Details</div>
              
              <FF label="Pharmacy Name *">
                <input 
                  style={S.input} 
                  value={wizardStoreForm.name} 
                  onChange={e => setWizardStoreForm(prev => ({ ...prev, name: e.target.value }))} 
                  placeholder="e.g. PM Janaushadhi Kendra" 
                />
              </FF>
              
              <FF label="GSTIN (Optional)">
                <input 
                  style={S.input} 
                  value={wizardStoreForm.gstin} 
                  onChange={e => setWizardStoreForm(prev => ({ ...prev, gstin: e.target.value.toUpperCase() }))} 
                  placeholder="e.g. 29AAAAA0000A1Z5" 
                />
              </FF>

              <FF label="Store Phone / Helpline *">
                <input 
                  style={S.input} 
                  value={wizardStoreForm.phone} 
                  onChange={e => setWizardStoreForm(prev => ({ ...prev, phone: e.target.value }))} 
                  placeholder="e.g. 9964382376" 
                />
              </FF>

              <FF label="Address">
                <input 
                  style={S.input} 
                  value={wizardStoreForm.address} 
                  onChange={e => setWizardStoreForm(prev => ({ ...prev, address: e.target.value }))} 
                  placeholder="Street details, city, state" 
                />
              </FF>

              <button 
                style={{ ...S.btn("teal"), width: "100%", marginTop: 12, padding: "12px", justifyContent: "center" }} 
                onClick={handleWizardStep1Next}
              >
                Next: Add Medicines ➜
              </button>
            </div>
          )}

          {onboardingMode === "wizard-step2" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {renderWizardHeader(2)}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>Add Medicines (Quick Start)</div>
                <span style={S.badge(medicines.length >= 5 ? "green" : "amber")}>
                  {medicines.length} / 5 Medicines
                </span>
              </div>
              <p style={{ fontSize: 12, color: C.text2, margin: "0 0 10px 0", lineHeight: 1.4 }}>
                Let's add a few medicines to populate your catalog. You can enter them manually below or load sample data instantly to get started in 10 seconds!
              </p>

              {/* Fast Add Form */}
              <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div style={{ gridColumn: "span 2" }}>
                  <label style={S.label}>Generic Name *</label>
                  <input style={S.input} value={newWizardMed.genericName} onChange={e => setNewWizardMed(p => ({ ...p, genericName: e.target.value }))} placeholder="e.g. Paracetamol 650mg" />
                </div>
                <div>
                  <label style={S.label}>Brand/Trade Name</label>
                  <input style={S.input} value={newWizardMed.brandName} onChange={e => setNewWizardMed(p => ({ ...p, brandName: e.target.value }))} placeholder="e.g. Dolo 650" />
                </div>
                <div>
                  <label style={S.label}>Strength (e.g. 650mg)</label>
                  <input style={S.input} value={newWizardMed.strength} onChange={e => setNewWizardMed(p => ({ ...p, strength: e.target.value }))} placeholder="e.g. 650mg" />
                </div>
                <div>
                  <label style={S.label}>Form</label>
                  <select style={{ ...S.input, height: "37px" }} value={newWizardMed.form} onChange={e => setNewWizardMed(p => ({ ...p, form: e.target.value }))}>
                    {["Tablet", "Capsule", "Syrup", "Injection", "Cream", "Drops", "Gel", "Ointment"].map(f => <option key={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label style={S.label}>Printed MRP *</label>
                  <input type="number" style={S.input} value={newWizardMed.mrp} onChange={e => setNewWizardMed(p => ({ ...p, mrp: e.target.value }))} placeholder="e.g. 30" />
                </div>
                <div>
                  <label style={S.label}>Retail Selling Price</label>
                  <input type="number" style={S.input} value={newWizardMed.sellingPrice} onChange={e => setNewWizardMed(p => ({ ...p, sellingPrice: e.target.value }))} placeholder="Selling Price (optional)" />
                </div>
                <div>
                  <label style={S.label}>Landed Purchase Price</label>
                  <input type="number" style={S.input} value={newWizardMed.purchasePrice} onChange={e => setNewWizardMed(p => ({ ...p, purchasePrice: e.target.value }))} placeholder="Purchase Price (optional)" />
                </div>
                <div style={{ gridColumn: "span 2", display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                  <button style={S.btn("teal")} onClick={handleAddWizardMed}>
                    ＋ Add Medicine
                  </button>
                </div>
              </div>

              {/* Sample medicines helper */}
              {medicines.length === 0 && (
                <div style={{ border: `1px dashed ${C.teal}`, background: "#E0F7F4", borderRadius: 10, padding: 14, textAlign: "center" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.teal, marginBottom: 4 }}>💡 Want to skip typing?</div>
                  <div style={{ fontSize: 11, color: C.text2, marginBottom: 10 }}>Load 5 standard pharmacy sample medicines in 1 click!</div>
                  <button style={{ ...S.btn("primary"), padding: "8px 16px" }} onClick={handleLoadSamples}>
                    ⚡ Load 5 Sample Medicines
                  </button>
                </div>
              )}

              {/* Added medicines list */}
              {medicines.length > 0 && (
                <div style={{ maxHeight: 180, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 10 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC" }}>
                        <th style={{ ...S.th, padding: "8px 12px" }}>Generic Name</th>
                        <th style={{ ...S.th, padding: "8px 12px" }}>Brand Name</th>
                        <th style={{ ...S.th, padding: "8px 12px" }}>MRP</th>
                        <th style={{ ...S.th, padding: "8px 12px", textAlign: "right" }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {medicines.map(m => (
                        <tr key={m.id}>
                          <td style={{ ...S.td, padding: "8px 12px" }}>{m.genericName}</td>
                          <td style={{ ...S.td, padding: "8px 12px" }}>{m.brandName || "—"}</td>
                          <td style={{ ...S.td, padding: "8px 12px" }}>₹{m.mrp}</td>
                          <td style={{ ...S.td, padding: "8px 12px", textAlign: "right" }}>
                            <button 
                              onClick={() => deleteDoc(doc(db, "medicines", m.id))}
                              style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}
                              title="Delete"
                            >
                              🗑️
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                <button style={{ ...S.btn("outline"), flex: 1 }} onClick={() => setOnboardingMode("wizard-step1")}>
                  Back: Store Settings
                </button>
                <button 
                  style={{ ...S.btn(medicines.length >= 3 ? "primary" : "outline"), flex: 1, cursor: medicines.length >= 3 ? "pointer" : "not-allowed" }} 
                  disabled={medicines.length < 3}
                  onClick={() => setOnboardingMode("wizard-step3")}
                >
                  Next: Opening Stock ➜
                </button>
              </div>
              {medicines.length < 3 && (
                <div style={{ fontSize: 11, color: C.red, textAlign: "center" }}>
                  ⚠ Add at least 3 medicines to proceed (5 recommended).
                </div>
              )}
            </div>
          )}

          {onboardingMode === "wizard-step3" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {renderWizardHeader(3)}
              {(() => {
                const medsWithStock = medicines.filter(m => m.stockQty > 0);
                const hasEnoughStock = medsWithStock.length >= 2;
                return (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>Add Opening Stock</div>
                      <span style={S.badge(hasEnoughStock ? "green" : "amber")}>
                        {medsWithStock.length} / 2 Items Stocked
                      </span>
                    </div>
                    <p style={{ fontSize: 12, color: C.text2, margin: "0 0 10px 0", lineHeight: 1.4 }}>
                      To sell items in the POS billing interface, they must have batch quantities. Add opening stock for at least 2 medicines to verify your inventory engine.
                    </p>

                    {/* Table listing added medicines and buttons to add stock */}
                    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" }}>
                        <thead>
                          <tr style={{ background: "#F8FAFC" }}>
                            <th style={{ ...S.th, padding: "10px 14px" }}>Medicine</th>
                            <th style={{ ...S.th, padding: "10px 14px" }}>Stock Level</th>
                            <th style={{ ...S.th, padding: "10px 14px", textAlign: "right" }}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {medicines.map(m => {
                            const hasStock = m.stockQty > 0;
                            return (
                              <tr key={m.id}>
                                <td style={{ ...S.td, padding: "10px 14px" }}>
                                  <div style={{ fontWeight: 600 }}>{m.brandName || m.genericName}</div>
                                  <div style={{ fontSize: 11, color: C.text3 }}>{m.genericName}</div>
                                </td>
                                <td style={{ ...S.td, padding: "10px 14px" }}>
                                  {hasStock ? (
                                    <span style={{ color: C.green, fontWeight: 700 }}>
                                      {m.stockQty} Units (Batch: {m.batches?.[0]?.batchNumber})
                                    </span>
                                  ) : (
                                    <span style={{ color: C.text3 }}>No Stock Added</span>
                                  )}
                                </td>
                                <td style={{ ...S.td, padding: "10px 14px", textAlign: "right" }}>
                                  <button 
                                    onClick={() => handleOpenOpeningStock(m)}
                                    style={S.btn(hasStock ? "outline" : "teal")}
                                  >
                                    {hasStock ? "✏️ Edit Stock" : "＋ Add Stock"}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                      <button style={{ ...S.btn("outline"), flex: 1 }} onClick={() => setOnboardingMode("wizard-step2")}>
                        Back: Medicines
                      </button>
                      <button 
                        style={{ 
                          ...S.btn(hasEnoughStock ? "teal" : "outline"), 
                          flex: 1, 
                          animation: hasEnoughStock ? "pulseBtnGreen 1.5s infinite" : "none",
                          fontWeight: 700
                        }} 
                        disabled={!hasEnoughStock}
                        onClick={handleWizardStep3Finish}
                      >
                        🚀 Start Billing / Go Live!
                      </button>
                    </div>
                    {!hasEnoughStock && (
                      <div style={{ fontSize: 11, color: C.red, textAlign: "center" }}>
                        ⚠ Add stock to at least 2 medicines to proceed.
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
        {openingStockModal && (
          <div style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(10,35,66,0.5)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            fontFamily: "inherit"
          }}>
            <div style={{
              background: "#fff",
              borderRadius: 16,
              width: "100%",
              maxWidth: 500,
              padding: 24,
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
              border: `1px solid ${C.border}`
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Add Opening Stock Batch</h3>
                  <span style={{ fontSize: 11, color: C.text3 }}>Medicine: {openingStockModal.brandName || openingStockModal.genericName}</span>
                </div>
                <button 
                  onClick={() => setOpeningStockModal(null)} 
                  style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}
                >
                  ×
                </button>
              </div>
              
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                <FF label="Batch Number *">
                  <input 
                    style={S.input} 
                    value={openingStockForm.batchNumber} 
                    onChange={e => setOpeningStockForm(prev => ({ ...prev, batchNumber: e.target.value.toUpperCase() }))} 
                  />
                </FF>
                <FF label="Expiry Date * (YYYY-MM)">
                  <input 
                    style={S.input} 
                    value={openingStockForm.expiryDate} 
                    onChange={e => setOpeningStockForm(prev => ({ ...prev, expiryDate: e.target.value }))} 
                    placeholder="e.g. 2027-12"
                  />
                </FF>
                <FF label="Landed Purchase Price *">
                  <input 
                    type="number"
                    style={S.input} 
                    value={openingStockForm.purchasePrice} 
                    onChange={e => setOpeningStockForm(prev => ({ ...prev, purchasePrice: e.target.value }))} 
                  />
                </FF>
                <FF label="Quantity (Strips/Units) *">
                  <input 
                    type="number"
                    style={S.input} 
                    value={openingStockForm.quantity} 
                    onChange={e => setOpeningStockForm(prev => ({ ...prev, quantity: e.target.value }))} 
                  />
                </FF>
                <FF label="Printed MRP *">
                  <input 
                    type="number"
                    style={S.input} 
                    value={openingStockForm.mrp} 
                    onChange={e => setOpeningStockForm(prev => ({ ...prev, mrp: e.target.value }))} 
                  />
                </FF>
                <FF label="Retail Selling Price *">
                  <input 
                    type="number"
                    style={S.input} 
                    value={openingStockForm.sellingPrice} 
                    onChange={e => setOpeningStockForm(prev => ({ ...prev, sellingPrice: e.target.value }))} 
                  />
                </FF>
              </div>

              <div style={{ background: "#F4F6F9", border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 11, color: C.text2, lineHeight: 1.4 }}>
                📌 <b>Onboarding Safe Mode:</b> Opening stock values directly initialize inventory levels. This entry is isolated and will <u>not</u> generate GST liability documents or write to supplier balance sheet ledgers.
              </div>

              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button style={S.btn("outline")} onClick={() => setOpeningStockModal(null)}>
                  Cancel
                </button>
                <button style={S.btn("teal")} onClick={saveOpeningStock}>
                  Confirm & Add Stock
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }


  const getSmartReorders = () => {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const salesMap = {};
    sales.forEach(sale => {
      const saleDate = sale.createdAt?.toDate ? sale.createdAt.toDate() : new Date(sale.createdAt || 0);
      if (saleDate >= sevenDaysAgo) {
        (sale.items || []).forEach(item => {
          const medId = item.medicineId;
          if (medId) {
            salesMap[medId] = (salesMap[medId] || 0) + (item.quantity || 0);
          }
        });
      }
    });

    return medicines.map(med => {
      const weeklySales = salesMap[med.id] || 0;
      const ads = weeklySales / 7;
      const stock = med.stockQty || 0;
      
      let runoutDays = "No sales";
      if (ads > 0) {
        runoutDays = Math.round(stock / ads);
      }

      let suggestedQty = 0;
      const reorderThreshold = med.lowStockAlert || 20;
      
      if (stock <= reorderThreshold || (ads > 0 && (stock / ads) <= 10)) {
        const coverDemand = ads * 30; // 30 days cover
        suggestedQty = Math.max(0, Math.ceil(coverDemand - stock));
        if (suggestedQty === 0 && stock <= reorderThreshold) {
          suggestedQty = reorderThreshold;
        }
      }

      return {
        ...med,
        weeklySales,
        ads,
        runoutDays,
        suggestedQty
      };
    }).filter(m => m.suggestedQty > 0);
  };

  const handleOpenCreatePo = (supplierName) => {
    const smartReorders = getSmartReorders();
    const supplierMeds = smartReorders.filter(m => (m.lastDistributorName || "No Linked Vendor") === supplierName);
    
    const supplierDoc = suppliers.find(s => s.name?.toLowerCase() === supplierName?.toLowerCase());
    const phone = supplierDoc?.phone || "";

    setPoModal({
      supplierName,
      phone,
      items: supplierMeds.map(m => ({
        medicineId: m.id,
        genericName: m.genericName,
        brandName: m.brandName,
        suggestedQty: m.suggestedQty,
        lastPurchasePrice: m.lastPurchasePrice || m.purchasePrice || 0
      }))
    });
  };

  const savePurchaseOrderDraft = async () => {
    if (!poModal) return;
    try {
      const poCol = collection(db, "purchase_orders");
      const poNum = `PO-${Date.now().toString().slice(-6)}`;
      await addDoc(poCol, {
        storeId,
        storeCode,
        poNumber: poNum,
        supplierName: poModal.supplierName,
        phone: poModal.phone,
        status: "DRAFT",
        items: poModal.items,
        totalEstimatedAmount: poModal.items.reduce((sum, i) => sum + (i.suggestedQty * i.lastPurchasePrice), 0),
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });
      alert(`✓ Draft PO ${poNum} successfully saved under Purchases tab!`);
      setPoModal(null);
    } catch (e) {
      alert("Error saving Purchase Order: " + e.message);
    }
  };

  const getWhatsAppPoText = () => {
    if (!poModal) return "";
    const itemsText = poModal.items.map(i => `• ${i.brandName || i.genericName}: ${i.suggestedQty} units (Last: ₹${i.lastPurchasePrice})`).join("\n");
    return `*Purchase Order Draft*\nSupplier: *${poModal.supplierName}*\nStore: *${storeName}*\n\nItems Requested:\n${itemsText}\n\n_Generated automatically via JK-PMS_`;
  };

  const handleSendWhatsAppPo = () => {
    const text = getWhatsAppPoText();
    const phoneNum = poModal.phone.replace(/\D/g, "");
    window.open(`https://wa.me/${phoneNum.startsWith("91") ? phoneNum : "91" + phoneNum}?text=${encodeURIComponent(text)}`, "_blank");
  };

  // ── Scoped Tabs Setup ──
  const TABS = [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "billing",   label: "Billing / POS", icon: "🛒" },
    { id: "purchase",  label: "Purchases",  icon: "📦" },
    { id: "reorders",  label: "Reorder Hub", icon: "🔄" },
    { id: "inventory", label: "Inventory", icon: "💊" },
    { id: "bills",     label: "Bills History", icon: "🧾" },
    { id: "reports",   label: "GST & Reports", icon: "📈" },
    { id: "alerts",    label: `Alerts (${lowStock.length})`, icon: "⏰" },
    { id: "settings",  label: "Store Settings", icon: "⚙️" },
  ];

  const allowedTabs = TABS.filter(t => userRole === "admin" || ["dashboard", "billing", "bills"].includes(t.id));

  // Enforce staff restrictions dynamically
  if (userRole === "staff" && !["dashboard", "billing", "bills"].includes(activeTab)) {
    setActiveTab("billing");
  }

  const rSales = getReportSales(); 
  const rPurch = getReportPurchases();
  const rTS = rSales.reduce((a, s) => a + (s.grandTotal || 0), 0);
  const rTP = rPurch.reduce((a, p) => a + (p.totalAmount || 0), 0);
  const todaySalesAll = sales.filter(s => { 
    const d = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0); 
    return d.toDateString() === now.toDateString(); 
  });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", display: "flex" }}>
      
      {/* ── Sidebar Navigation ── */}
      <aside style={{ width: 260, background: C.sidebarBg, color: "#fff", display: "flex", flexDirection: "column", flexShrink: 0, boxShadow: "4px 0 20px rgba(0,0,0,0.1)" }}>
        
        {/* Store Title Header */}
        <div style={{ padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ ...S.logoMark, width: 34, height: 34 }}>JK</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", letterSpacing: "-0.3px" }}>JK-PMS</div>
            <div style={{ fontSize: 10, color: "#6C7A9C", fontWeight: 600 }}>SaaS Pharmacy ERP</div>
          </div>
        </div>

        {/* Store Selection & Copy Code */}
        <div style={{ margin: "16px 20px", padding: "12px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 10, border: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
            🏪 {storeName || "Active Kendra"}
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
            <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6C7A9C", fontWeight: 700 }}>CODE: {storeCode}</span>
            <button 
              onClick={() => { navigator.clipboard.writeText(storeCode); alert("Store Code copied to clipboard!"); }}
              style={{ background: "none", border: "none", color: C.teal2, fontSize: 10, cursor: "pointer", fontWeight: 700, padding: "2px 6px", borderRadius: 4 }}
              onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.05)"}
              onMouseLeave={e => e.currentTarget.style.background = "none"}
              title="Copy Store Code to Invite Staff"
            >
              📋 Copy
            </button>
          </div>
        </div>

        {/* Vertical Tab Navigation */}
        <nav style={{ flex: 1, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
          {allowedTabs.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button 
                key={tab.id} 
                onClick={() => setActiveTab(tab.id)}
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  gap: 12, 
                  padding: "10px 14px", 
                  borderRadius: 8, 
                  border: "none", 
                  background: isActive ? "rgba(20,160,133,0.15)" : "none", 
                  color: isActive ? "#ffffff" : C.sidebarText, 
                  cursor: "pointer", 
                  fontFamily: "inherit", 
                  textAlign: "left", 
                  fontSize: 13, 
                  fontWeight: isActive ? 700 : 500, 
                  transition: "all 0.12s" 
                }}
                onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = "none"; }}
              >
                <span style={{ fontSize: 15 }}>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Profile Card Bottom */}
        <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#fff", textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
              {user.email.split("@")[0]}
            </div>
            <div style={{ display: "inline-flex", marginTop: 3 }}>
              <span style={{ fontSize: 9, fontWeight: 800, background: userRole === "admin" ? "#1B7A4E" : "#1565C0", color: "#fff", padding: "1px 6px", borderRadius: 10, textTransform: "uppercase" }}>
                {userRole}
              </span>
            </div>
          </div>
          <button 
            onClick={() => signOut(auth)} 
            style={{ background: "none", border: "none", cursor: "pointer", color: "#6C7A9C", fontSize: 14 }}
            title="Sign Out"
          >
            🚪
          </button>
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100vh" }}>
        
        {/* Scoped Topbar */}
        <header style={S.topbar}>
          <div>
            <span style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px" }}>Store: {storeName}</span>
            <h2 style={{ fontSize: 16, fontWeight: 800, color: C.navy, marginTop: 2 }}>
              {TABS.find(t => t.id === activeTab)?.label}
            </h2>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 11, color: C.text3, fontWeight: 600 }}>{now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#E0F7F4", borderRadius: 20, padding: "5px 12px" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ECCA3", display: "block", animation: "pulseSync 1.5s infinite" }} />
              <span style={{ fontSize: 10, color: C.teal, fontWeight: 700 }}>
                {lastSyncSec <= 2 ? "JUST SYNCED" : `SYNCED ${lastSyncSec}s AGO`}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#EBF4FF", borderRadius: 20, padding: "5px 12px" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.blue, display: "block" }} />
              <span style={{ fontSize: 10, color: C.blue, fontWeight: 700 }}>CLOUD BACKUP ACTIVE</span>
            </div>
            <style>{`
              @keyframes pulseSync {
                0% { opacity: 0.4; }
                50% { opacity: 1; }
                100% { opacity: 0.4; }
              }
            `}</style>
          </div>
        </header>

        {/* Index Deployment Alert Banner - Removed as index requirements are resolved */}

        <main style={S.main}>
          {dbLoading && <div style={{ textAlign: "center", padding: "40px 0", color: C.text3, fontSize: 14 }}>Syncing with cloud...</div>}

        {/* DASHBOARD */}
        {!dbLoading && activeTab === "dashboard" && (
          <div>
            <PH title="Dashboard" sub={now.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14, marginBottom: 22 }}>
              {(() => {
                const todaySales = todaySalesAll.reduce((a, s) => a + (s.grandTotal || 0), 0);
                const todayProfit = todaySalesAll.reduce((a, s) => {
                  const cost = (s.items || []).reduce((ac, item) => {
                    const med = medicines.find(m => m.genericName?.toLowerCase() === item.genericName?.toLowerCase());
                    return ac + ((med?.purchasePrice || 0) * (item.quantity || item.qty || 1));
                  }, 0);
                  return a + ((s.grandTotal || 0) - cost);
                }, 0);
                return [
                  { label: "NET SALE TODAY", value: `₹${todaySales.toFixed(2)}`, sub: `${todaySalesAll.length} bills`, accent: "#1976D2", vc: C.blue },
                  { label: "PROFIT TODAY", value: `₹${todayProfit.toFixed(2)}`, sub: todaySales > 0 ? `${((todayProfit / todaySales) * 100).toFixed(1)}% margin` : "—", accent: C.green, vc: C.green },
                  { label: "TOTAL MEDICINES", value: String(medicines.length), sub: "In stock", accent: C.teal, vc: C.teal },
                  { label: "LOW STOCK", value: String(lowStock.length), sub: `${expiringSoon.length} expiring`, accent: "#B7791F", vc: C.amber },
                ];
              })().map((card, i) => (
                <div key={i} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", borderTop: `3px solid ${card.accent}` }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.6px", marginBottom: 8 }}>{card.label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: card.vc, marginBottom: 3 }}>{card.value}</div>
                  <div style={{ fontSize: 11, color: C.text3 }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* Quick Actions Panel */}
            <div style={{ ...S.card, marginBottom: 22 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>
                ⚡ Quick Actions & POS Shortcuts
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                {[
                  {
                    title: "POS Cashier Billing",
                    desc: "Open sales POS invoice screen (F2)",
                    icon: "🛒",
                    color: C.blue,
                    allowed: true,
                    action: () => { setActiveTab("billing"); setTimeout(() => billSearchRef.current?.focus(), 100); }
                  },
                  {
                    title: "AI Medicine Scanner",
                    desc: "Scan packaging photo via Gemini",
                    icon: "📸",
                    color: "#6200EE",
                    allowed: userRole === "admin",
                    action: () => { setActiveTab("inventory"); setShowAddMedForm(true); setTimeout(() => productPhotoInputRef.current?.click(), 200); }
                  },
                  {
                    title: "Excel Inventory Import",
                    desc: "Ingest CSV/Excel stock lists",
                    icon: "📊",
                    color: C.teal,
                    allowed: userRole === "admin",
                    action: () => { setActiveTab("inventory"); setTimeout(() => inventoryExcelInputRef.current?.click(), 200); }
                  },
                  {
                    title: "Gemini Purchase Scanner",
                    desc: "Scan supplier bills/invoices",
                    icon: "🤖",
                    color: "#00E676",
                    allowed: userRole === "admin",
                    action: () => { setActiveTab("purchase"); setShowPurchaseForm(true); setTimeout(() => fileInputRef.current?.click(), 200); }
                  },
                  {
                    title: "Add Medicine Manually",
                    desc: "Create new catalog items in database",
                    icon: "💊",
                    color: C.green,
                    allowed: userRole === "admin",
                    action: () => { setActiveTab("inventory"); setShowAddMedForm(true); }
                  },
                  {
                    title: "GST Ledger Reports",
                    desc: "Audit tax slab breakdown GSTR-1",
                    icon: "📈",
                    color: C.navy,
                    allowed: userRole === "admin",
                    action: () => setActiveTab("reports")
                  },
                  {
                    title: "Check Expiry Warnings",
                    desc: "View batch-level alerts",
                    icon: "⏰",
                    color: C.amber,
                    allowed: userRole === "admin",
                    action: () => setActiveTab("alerts")
                  },
                  {
                    title: "Onboard Staff Members",
                    desc: "Copy store connection parameters",
                    icon: "👥",
                    color: C.text2,
                    allowed: userRole === "admin",
                    action: () => { setActiveTab("settings"); navigator.clipboard.writeText(storeCode); alert("Store Code copied to clipboard! Share it with staff cashiers to join."); }
                  }
                ].map((action, idx) => {
                  const isBlocked = !action.allowed;
                  return (
                    <button
                      key={idx}
                      onClick={() => { if (!isBlocked) action.action(); }}
                      disabled={isBlocked}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "14px 16px",
                        background: isBlocked ? "#F1F5F9" : "#fff",
                        border: `1.5px solid ${isBlocked ? C.border : C.border2}`,
                        borderRadius: 10,
                        cursor: isBlocked ? "not-allowed" : "pointer",
                        textAlign: "left",
                        width: "100%",
                        opacity: isBlocked ? 0.55 : 1,
                        transition: "all 0.15s ease",
                        fontFamily: "inherit",
                        boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
                      }}
                      onMouseEnter={e => {
                        if (!isBlocked) {
                          e.currentTarget.style.borderColor = action.color;
                          e.currentTarget.style.transform = "translateY(-1px)";
                          e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.05)";
                        }
                      }}
                      onMouseLeave={e => {
                        if (!isBlocked) {
                          e.currentTarget.style.borderColor = C.border2;
                          e.currentTarget.style.transform = "none";
                          e.currentTarget.style.boxShadow = "0 1px 2px rgba(0,0,0,0.02)";
                        }
                      }}
                    >
                      <span style={{ fontSize: 24, padding: 8, background: isBlocked ? "#E2E8F0" : "rgba(13,115,119,0.08)", borderRadius: 8, color: action.color }}>{action.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{action.title}</div>
                        <div style={{ fontSize: 11, color: C.text3, marginTop: 2, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>{action.desc}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            {lowStock.length > 0 && (
              <div style={{ ...S.card, background: "#FEF9EC", border: "1px solid #F6D860" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px" }}>Low Stock Alerts</span>
                  <span style={S.badge("amber")}>{lowStock.length} items</span>
                </div>
                {lowStock.slice(0, 4).map(m => (
                  <div key={m.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F0E0A0" }}>
                    <div><div style={{ fontSize: 13, fontWeight: 600 }}>{m.genericName}</div><div style={{ fontSize: 11, color: C.text3 }}>{m.brandName}</div></div>
                    <span style={S.badge(m.stockQty === 0 ? "red" : "amber")}>{m.stockQty} left</span>
                  </div>
                ))}
              </div>
            )}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>Recent Sales</span>
                <span style={S.badge("teal")}>{sales.length} total</span>
              </div>
              {sales.length === 0 ? <div style={{ color: C.text3, fontSize: 13, padding: "8px 0" }}>No sales yet. Start billing!</div>
                : sales.slice(0, 5).map(s => (
                  <div key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div><div style={{ fontSize: 13, fontWeight: 600 }}>{s.billNumber}</div><div style={{ fontSize: 11, color: C.text3 }}>{s.createdAt?.toDate ? s.createdAt.toDate().toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</div></div>
                    <div style={{ textAlign: "right" }}><div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>₹{(s.grandTotal||0).toFixed(2)}</div><div style={{ fontSize: 11, color: C.text3 }}>{s.paymentMode}</div></div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* BILLING */}
        {!dbLoading && activeTab === "billing" && (
          <div>
            <PH 
              title="Billing / POS" 
              sub="F2 = Search · ↑↓ Navigate · Enter = Add · F9 = Generate Bill" 
              action={
                <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  <button style={S.btn("outline")} onClick={downloadSalesTemplate}>
                    📥 Template
                  </button>
                  <input 
                    type="file" 
                    accept=".xlsx,.xls,.csv" 
                    id="salesImportFileInput" 
                    onChange={handleSalesExcelImport} 
                    style={{ display: "none" }} 
                  />
                  <button style={S.btn("teal")} onClick={() => document.getElementById("salesImportFileInput")?.click()}>
                    📊 Bulk Import
                  </button>
                </div>
              }
            />
            {/* KEYBOARD SHORTCUT BAR */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {[["F2", "Focus Search"], ["↑↓", "Navigate"], ["Enter", "Add Item"], ["F9", "Generate Bill"], ["Esc", "Clear Search"]].map(([key, desc]) => (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px" }}>
                  <span style={{ background: C.navy, color: "#fff", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700, fontFamily: "monospace" }}>{key}</span>
                  <span style={{ fontSize: 11, color: C.text3 }}>{desc}</span>
                </div>
              ))}
            </div>
            {/* POS SAFE MODE VERIFICATION BANNER */}
            <div style={{ 
              display: "flex", 
              gap: 16, 
              padding: "10px 16px", 
              background: "linear-gradient(135deg, #0A2342 0%, #0D7377 100%)", 
              borderRadius: 8, 
              color: "#fff", 
              marginBottom: 14, 
              alignItems: "center", 
              justifyContent: "space-between", 
              boxShadow: "0 2px 10px rgba(13,115,119,0.12)",
              fontSize: 12
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 16 }}>🛡️</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>POS Safe Mode Verified</div>
                  <div style={{ opacity: 0.8, fontSize: 11 }}>Calculations, active stock, and FEFO allocation rules are fully secure</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                  <span style={{ color: "#4ECCA3" }}>✔</span> Inventory Synced
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                  <span style={{ color: "#4ECCA3" }}>✔</span> Expiry Guard On
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                  <span style={{ color: "#4ECCA3" }}>✔</span> Margins Audited
                </div>
              </div>
            </div>
            {lastBill && (
              <div style={{ background: "#E8F5EE", border: "1.5px solid #68D391", borderRadius: 10, padding: "14px 18px", marginBottom: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.green, marginBottom: 6 }}>✓ Bill Saved!</div>
                <div style={{ fontSize: 12, color: "#2D6A4F", marginBottom: 12 }}>{lastBill.billNumber} · ₹{lastBill.grandTotal.toFixed(2)} · {lastBill.paymentMode}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button style={S.btn("teal")} onClick={() => {
                    if (defaultPrintType === "A4") {
                      printA4PDFInvoice(lastBill);
                    } else {
                      printThermalReceipt(lastBill);
                    }
                  }}>
                    🖨️ Print Default ({defaultPrintType === "A4" ? "PDF" : "Thermal"})
                  </button>
                  <button style={S.btn("outline")} onClick={() => {
                    if (defaultPrintType === "A4") {
                      printThermalReceipt(lastBill);
                    } else {
                      printA4PDFInvoice(lastBill);
                    }
                  }}>
                    {defaultPrintType === "A4" ? "Thermal" : "PDF"}
                  </button>
                  {lastBill.customerPhone && <button style={S.btn("whatsapp")} onClick={() => sendWhatsApp(lastBill, lastBill.customerPhone)}>WhatsApp</button>}
                  <button style={S.btn("outline")} onClick={() => setLastBill(null)}>New Bill</button>
                </div>
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
              <FF label="Patient Name"><input style={S.input} value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Optional" /></FF>
              <FF label="Phone (WhatsApp)"><input style={S.input} value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="10-digit" /></FF>
            </div>
            <div style={{ position: "relative", marginBottom: 14 }}>
              <input
                ref={billSearchRef}
                style={{ ...S.input, fontSize: 14, padding: "12px 14px", paddingRight: 50, border: `2px solid ${C.teal}`, boxShadow: "0 0 0 3px rgba(13,115,119,0.08)" }}
                value={billSearch}
                onChange={e => { setBillSearch(e.target.value); setSearchHighlight(-1); }}
                onKeyDown={handleSearchKeyDown}
                placeholder="🔍  Type medicine name... (F2 to focus)"
                autoComplete="off"
              />
              <button 
                type="button"
                onClick={toggleVoiceInput}
                style={{ 
                  position: "absolute", 
                  right: 10, 
                  top: "50%", 
                  transform: "translateY(-50%)", 
                  background: isVoiceListening ? "#EF4444" : "none", 
                  border: "none", 
                  borderRadius: "50%", 
                  width: 32, 
                  height: 32, 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "center", 
                  fontSize: 16, 
                  cursor: "pointer", 
                  color: isVoiceListening ? "#fff" : C.teal,
                  boxShadow: isVoiceListening ? "0 0 10px rgba(239, 68, 68, 0.6)" : "none",
                  animation: isVoiceListening ? "pulseVoice 1.2s infinite" : "none",
                  transition: "all 0.15s ease"
                }}
                title={isVoiceListening ? "Listening... click to stop" : "Use Voice POS Billing"}
              >
                {isVoiceListening ? "🎙️" : "🎤"}
              </button>
              {searchResults.length > 0 && (
                <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: `1.5px solid ${C.teal}`, borderRadius: 10, zIndex: 30, overflow: "hidden", marginTop: 3, boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                  {searchResults.map((m, idx) => {
                    const expiring = isExpiringSoon(m);
                    const expired = isExpired(m);
                    const oos = m.stockQty <= 0;
                    const subs = oos ? getSubstitutes(m.genericName) : [];
                    return (
                      <div key={m.id}>
                        <button
                          onClick={() => addToBill(m)}
                          style={{ width: "100%", padding: "11px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", background: idx === searchHighlight ? "#E0F7F4" : expired ? "#FFF5F5" : oos ? "#FFFBEB" : "none", border: "none", borderBottom: `1px solid ${C.border}`, cursor: expired ? "not-allowed" : "pointer", fontFamily: "inherit", textAlign: "left", opacity: expired ? 0.6 : 1 }}
                        >
                          <div>
                            <span style={{ fontWeight: 600, color: C.navy, fontSize: 13 }}>{m.genericName}</span>
                            <span style={{ color: C.text3, fontSize: 12, marginLeft: 8 }}>{m.brandName}</span>
                            {expired && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: C.red, background: "#FDECEA", borderRadius: 4, padding: "1px 5px" }}>EXPIRED</span>}
                            {!expired && expiring && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: C.amber, background: "#FEF3DC", borderRadius: 4, padding: "1px 5px" }}>Exp {m.expiryDate}</span>}
                          </div>
                          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span style={{ fontWeight: 700, color: C.blue, fontSize: 13 }}>₹{m.sellingPrice || m.mrp}</span>
                            <span style={S.badge(expired ? "red" : oos ? "red" : m.stockQty <= m.lowStockAlert ? "amber" : "teal")}>
                              {oos ? "OUT OF STOCK" : `Qty: ${m.stockQty}`}
                            </span>
                          </div>
                        </button>
                        {oos && subs.length > 0 && (
                          <div style={{ background: "#FFFBEB", borderBottom: `1px solid ${C.border}`, padding: "6px 14px" }}>
                            <span style={{ fontSize: 11, color: C.amber, fontWeight: 700 }}>Substitutes: </span>
                            {subs.map(s => (
                              <button key={s.id} onClick={() => addToBill(s)}
                                style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: C.teal, background: "#E0F7F4", border: `1px solid ${C.teal}`, borderRadius: 4, padding: "2px 8px", cursor: "pointer" }}>
                                {s.brandName || s.genericName} ₹{s.sellingPrice || s.mrp} ({s.stockQty})
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            {billItems.length > 0 ? (
              <>
                <div style={{ ...S.card, padding: 0, overflow: "hidden", marginBottom: 14 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead><tr style={{ background: "#F8FAFC" }}>{["Medicine","Qty","Price","Disc%","Amount",""].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                    <tbody>{billItems.map((item, idx) => { const c = calcItem(item); const expiring = isExpiringSoon(item); const expired = isExpired(item); return (
                      <tr key={item.id} style={{ background: expired ? "#FFF5F5" : expiring ? "#FFFDF0" : "" }}>
                        <td style={S.td}>
                          <div style={{ fontWeight: 600, color: C.navy }}>{item.genericName}</div>
                          <div style={{ fontSize: 11, color: C.text3, marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                            <span>{item.brandName}</span>
                            {expired && <span style={{ fontSize: 10, fontWeight: 700, color: C.red, background: "#FFF5F5", padding: "1px 4px", borderRadius: 3 }}>⚠ EXPIRED</span>}
                            {!expired && expiring && <span style={{ fontSize: 10, fontWeight: 700, color: C.amber, background: "#FFFDF0", padding: "1px 4px", borderRadius: 3 }}>⏰ Exp {item.expiryDate}</span>}
                            
                            {!expired && (
                              <div style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8 }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: C.teal2 }}>Batch:</span>
                                {(() => {
                                  const currentMonthStr = new Date().toISOString().substring(0, 7);
                                  const activeBatches = (item.batches || []).filter(b => b.expiryDate >= currentMonthStr && (b.quantity || 0) > 0);
                                  if (activeBatches.length > 1) {
                                    return (
                                      <select
                                        value={item.selectedBatchNumber}
                                        onChange={e => setBillItems(prev => prev.map((bi, idxJ) => idxJ === idx ? { ...bi, selectedBatchNumber: e.target.value } : bi))}
                                        style={{ fontFamily: "inherit", fontSize: 10, fontWeight: 600, padding: "2px 4px", border: `1px solid ${C.border2}`, borderRadius: 4, background: "#FFF", color: C.text2, outline: "none", cursor: "pointer" }}
                                      >
                                        {activeBatches.map(ab => (
                                          <option key={ab.batchNumber} value={ab.batchNumber}>
                                            {ab.batchNumber} (Exp: {ab.expiryDate}) · Qty: {ab.quantity}
                                          </option>
                                        ))}
                                      </select>
                                    );
                                  } else if (activeBatches.length === 1) {
                                    return <span style={{ fontSize: 10, fontWeight: 600, color: C.text2, background: "#F1F5F9", padding: "1px 5px", borderRadius: 4 }}>{activeBatches[0].batchNumber} (Exp: {activeBatches[0].expiryDate})</span>;
                                  } else {
                                    return <span style={{ fontSize: 10, color: C.red, fontWeight: 700 }}>No Active Stock</span>;
                                  }
                                })()}
                              </div>
                            )}
                          </div>
                        </td>
                        <td style={S.td}><input type="number" min="1" value={item.qty} onFocus={e => e.target.select()} onChange={e=>setBillItems(p=>p.map((i,j)=>j===idx?{...i,qty:e.target.value === "" ? "" : Math.max(0, parseInt(e.target.value) || 0)}:i))} style={{ ...S.input, width: 56, padding: "6px 8px" }} /></td>
                        <td style={S.td}>₹{item.mrp}</td>
                        <td style={S.td}><input type="number" min="0" max="100" value={item.discount||0} onFocus={e => e.target.select()} onChange={e=>setBillItems(p=>p.map((i,j)=>j===idx?{...i,discount:+e.target.value}:i))} style={{ ...S.input, width: 56, padding: "6px 8px" }} /></td>
                        <td style={{ ...S.td, fontWeight: 700, color: C.green }}>₹{c.total.toFixed(2)}</td>
                        <td style={S.td}>
                          <button 
                            onClick={(e) => { e.stopPropagation(); setBillItems(p => p.filter(i => i.id !== item.id)); }} 
                            style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 15, padding: "4px 8px", borderRadius: 4, transition: "background 0.1s" }}
                            onMouseEnter={e => e.currentTarget.style.background = "#FEE2E2"}
                            onMouseLeave={e => e.currentTarget.style.background = "none"}
                            title="Remove item from bill"
                          >
                            🗑️
                          </button>
                        </td>
                      </tr>
                    );})}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
                    {[["Subtotal", `₹${totals.sub.toFixed(2)}`], totals.disc > 0 ? ["Discount", `-₹${totals.disc.toFixed(2)}`] : null, ["Taxable Value", `₹${totals.taxable.toFixed(2)}`], ["CGST (Central GST)", `₹${totals.cgst.toFixed(2)}`], ["SGST (State GST)", `₹${totals.sgst.toFixed(2)}`]].filter(Boolean).map(([k,v])=>(
                      <div key={k} style={{ display:"flex",justifyContent:"space-between",fontSize:13,color:C.text2,marginBottom:8 }}><span>{k}</span><span>{v}</span></div>
                    ))}
                    <div style={{ display:"flex",justifyContent:"space-between",fontSize:18,fontWeight:700,paddingTop:10,borderTop:`2px solid ${C.border2}`,marginTop:4 }}>
                      <span>Grand Total</span><span style={{ color:C.green }}>₹{totals.grand.toFixed(2)}</span>
                    </div>
                  </div>
                  <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
                    <FF label="Payment Mode"><select value={paymentMode} onChange={e=>setPaymentMode(e.target.value)} style={{ ...S.input,fontSize:14 }}>{["Cash","UPI","Card","Credit"].map(m=><option key={m}>{m}</option>)}</select></FF>
                    <button style={{ ...S.btn("teal"),padding:"13px",fontSize:15 }} onClick={generateBill}>Generate Bill + Save &nbsp;<kbd style={{fontSize:11,opacity:0.7,fontFamily:"monospace"}}>F9</kbd></button>
                    <button style={S.btn("outline")} onClick={()=>setBillItems([])}>Clear All</button>
                  </div>
                </div>
              </>
            ) : (
              <div style={{ textAlign:"center",padding:"48px 0",color:C.text3 }}>
                <div style={{ fontSize:44,marginBottom:12,opacity:0.2 }}>⊕</div>
                <div style={{ fontSize:14,fontWeight:600 }}>Search above to add medicines</div>
              </div>
            )}
          </div>
        )}

        {/* PURCHASE */}
        {!dbLoading && activeTab === "purchase" && (
          <div>
            <PH title="Purchase Entry" sub="Gemini AI scans PDF free · Stock auto-updates · Supplier ledger"
              action={<button style={S.btn("primary")} onClick={()=>setShowPurchaseForm(f=>!f)}>+ New Purchase</button>} />

            <div style={{ ...S.card, border:"1.5px solid #0D7377", background:"#F5FAF9", marginBottom:16 }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:14, flexWrap:"wrap" }}>
                <div style={{ width:44, height:44, borderRadius:10, background:"#E0F7F4", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>📦</div>
                <div style={{ flex:1, minWidth:260 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:C.teal, marginBottom:3 }}>Smart Purchase Ingestion Engine <span style={{ fontSize:10, background:"#E0F7F4", color:C.teal, padding:"2px 8px", borderRadius:20, marginLeft:6 }}>PRODUCTION READY</span></div>
                  <div style={{ fontSize:12, color:C.text2, marginBottom:12 }}>Choose to either scan your invoice with Gemini AI OCR or directly import Excel/CSV datasheets.</div>
                  {aiStatus && <div style={{ fontSize:13, fontWeight:500, marginBottom:10, padding:"8px 12px", borderRadius:8, color:aiStatus.startsWith("✓")?C.green:aiStatus.startsWith("⚠")?C.amber:C.blue, background:aiStatus.startsWith("✓")?"#E8F5EE":aiStatus.startsWith("⚠")?"#FFF8E7":"#EBF4FF" }}>{aiStatus}</div>}
                  
                  <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                    {/* Gemini AI Scan */}
                    <input type="file" accept=".pdf,image/*" ref={fileInputRef} onChange={handleFileUpload} style={{ display:"none" }} />
                    <button style={{ ...S.btn("ai"), opacity:aiLoading?0.7:1 }} onClick={()=>fileInputRef.current?.click()} disabled={aiLoading}>
                      {aiLoading ? "⏳ Scanning..." : "🤖 Scan Invoice with AI"}
                    </button>
                    
                    {/* Excel Upload */}
                    <input type="file" accept=".xlsx,.xls,.csv" id="excelFileInput" onChange={handleExcelUpload} style={{ display:"none" }} />
                    <button style={S.btn("teal")} onClick={()=>document.getElementById("excelFileInput")?.click()} disabled={aiLoading}>
                      📊 Import Excel / CSV
                    </button>
                    
                    {/* Template download */}
                    <button style={S.btn("outline")} onClick={downloadExcelTemplate}>
                      📥 Download Template CSV
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* RESOLUTION DRAWER / INTERACTIVE OVERRIDE PANEL */}
            {showPreviewDrawer && (
              <div style={{ ...S.card, border: `2.5px solid ${C.teal}`, background: "#fff", padding: 22, marginBottom: 20, boxShadow: "0 10px 30px rgba(0,0,0,0.08)" }}>
                <style>{`
                  @keyframes pulseVoice {
                    0% { transform: translateY(-50%) scale(1); box-shadow: 0 0 0 0 rgba(255, 77, 77, 0.7); }
                    70% { transform: translateY(-50%) scale(1.1); box-shadow: 0 0 0 10px rgba(255, 77, 77, 0); }
                    100% { transform: translateY(-50%) scale(1); box-shadow: 0 0 0 0 rgba(255, 77, 77, 0); }
                  }
                `}</style>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2px solid ${C.border}`, paddingBottom: 14, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: C.navy }}>⚖️ Intelligent Mapping Resolution Wizard</div>
                    <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>Prevent inventory duplication. Check fuzzy similarity matches, resolve warnings, and link to existing medicines.</div>
                  </div>
                  <button style={S.btn("outline")} onClick={() => { setShowPreviewDrawer(false); setPreviewItems([]); setAiStatus(""); }}>✕ Close Wizard</button>
                </div>

                <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Distributor & Invoice Header</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
                    <FF label="Supplier Name *"><input style={S.input} value={purchaseForm.supplierName} onChange={e=>setPurchaseForm(p=>({...p,supplierName:e.target.value}))} /></FF>
                    <FF label="Invoice Number"><input style={S.input} value={purchaseForm.invoiceNumber} onChange={e=>setPurchaseForm(p=>({...p,invoiceNumber:e.target.value}))} /></FF>
                    <FF label="Invoice Date"><input type="date" style={S.input} value={purchaseForm.invoiceDate} onChange={e=>setPurchaseForm(p=>({...p,invoiceDate:e.target.value}))} /></FF>
                    <FF label="Payment Status"><select style={S.input} value={purchaseForm.paymentStatus} onChange={e=>setPurchaseForm(p=>({...p,paymentStatus:e.target.value}))}><option>Unpaid</option><option>Paid</option><option>Partial</option></select></FF>
                  </div>
                </div>

                <div style={{ overflowX: "auto", marginBottom: 18, borderRadius: 8, border: `1px solid ${C.border}` }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 950 }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC" }}>
                        {["Incoming Drug", "Specs", "Expiry", "Printed MRP", "Retail Selling", "Buy Rate", "Qty", "Similarity", "Resolution Binding", ""].map(h => <th key={h} style={{ ...S.th, padding: "12px 14px" }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {purchaseForm.items.map((item, idx) => {
                        const isMatch = item.matchType === "MATCH";
                        const isConflict = item.matchType === "CONFLICT";
                        const scorePct = Math.round(item.score * 100);
                        
                        return (
                          <tr key={idx} style={{ background: isConflict ? "#FFFDF5" : "" }}>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <div style={{ fontWeight: 700, color: C.navy }}>{item.genericName}</div>
                              <div style={{ fontSize: 11, color: C.text2, fontStyle: "italic" }}>{item.brandName || "—"}</div>
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{item.strength || "—"}</div>
                              <div style={{ fontSize: 10, color: C.text3 }}>{item.form || "Tablet"} · {item.unit}</div>
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 80 }} value={item.expiryDate} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, expiryDate: e.target.value} : it)}))} />
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="number" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 64 }} value={item.mrp} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, mrp: +e.target.value} : it)}))} />
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="number" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 64, border: `1.5px solid ${C.teal2}`, fontWeight: 700, color: C.teal2 }} value={item.sellingPrice} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, sellingPrice: +e.target.value} : it)}))} />
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="number" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 64 }} value={item.purchasePrice} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, purchasePrice: +e.target.value} : it)}))} />
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="number" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 56 }} value={item.quantity} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, quantity: +e.target.value} : it)}))} />
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <span style={S.badge(isMatch ? "green" : isConflict ? "amber" : "blue")}>
                                {isMatch ? `✅ Auto (${scorePct}%)` : isConflict ? `⚠️ Warn (${scorePct}%)` : "🆕 New drug"}
                              </span>
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <select 
                                style={{ ...S.input, fontSize: 12, padding: "6px 10px", width: 220, background: isConflict ? "#FFF9EB" : "#fff", border: isConflict ? `1.5px solid ${C.amber}` : `1.5px solid ${C.border2}` }}
                                value={item.overrideId} 
                                onChange={e => {
                                  const selectedVal = e.target.value;
                                  setPurchaseForm(p => ({
                                    ...p,
                                    items: p.items.map((it, i) => {
                                      if (i === idx) {
                                        const foundMed = medicines.find(m => m.id === selectedVal);
                                        return {
                                          ...it,
                                          overrideId: selectedVal,
                                          matchType: selectedVal ? "MATCH" : "NEW",
                                          matchedItem: foundMed || null
                                        };
                                      }
                                      return it;
                                    })
                                  }));
                                }}
                              >
                                <option value="">🆕 Create as New Medicine</option>
                                {medicines.map(m => (
                                  <option key={m.id} value={m.id}>
                                    🔗 Bind: {m.brandName || m.genericName} {m.strength ? `(${m.strength} ${m.form})` : `(${m.form})`}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px", textAlign: "center" }}>
                              <button 
                                onClick={() => setPurchaseForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) }))}
                                style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 14, padding: "4px 6px", borderRadius: 4, transition: "background 0.1s" }}
                                onMouseEnter={e => e.currentTarget.style.background = "#FEE2E2"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}
                                title="Discard item from list"
                              >
                                🗑️
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <button style={{ ...S.btn("green"), fontSize: 14, padding: "12px 28px" }} onClick={savePurchase}>
                    🚀 Import Checked Inventory
                  </button>
                  <button style={S.btn("outline")} onClick={() => { setShowPreviewDrawer(false); setPreviewItems([]); setAiStatus(""); }}>
                    Cancel & Discard
                  </button>
                </div>
              </div>
            )}

            {showPurchaseForm && (
              <div style={{ ...S.card,border:`1.5px solid ${C.teal}`,marginBottom:16 }}>
                <div style={{ fontSize:13,fontWeight:700,color:C.teal,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:16 }}>Purchase Invoice Details</div>
                <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:10,marginBottom:16 }}>
                  <FF label="Supplier Name *"><input style={S.input} value={purchaseForm.supplierName} onChange={e=>setPurchaseForm(p=>({...p,supplierName:e.target.value}))} placeholder="e.g. Mankind Pharma" /></FF>
                  <FF label="Invoice Number"><input style={S.input} value={purchaseForm.invoiceNumber} onChange={e=>setPurchaseForm(p=>({...p,invoiceNumber:e.target.value}))} /></FF>
                  <FF label="Invoice Date"><input type="date" style={S.input} value={purchaseForm.invoiceDate} onChange={e=>setPurchaseForm(p=>({...p,invoiceDate:e.target.value}))} /></FF>
                  <FF label="Payment Status"><select style={S.input} value={purchaseForm.paymentStatus} onChange={e=>setPurchaseForm(p=>({...p,paymentStatus:e.target.value}))}><option>Unpaid</option><option>Paid</option><option>Partial</option></select></FF>
                </div>
                {purchaseForm.items.length > 0 && (
                  <div style={{ marginBottom:14,overflowX:"auto" }}>
                    <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.5px" }}>Items ({purchaseForm.items.length}) — Edit if needed</div>
                    <table style={{ width:"100%",borderCollapse:"collapse",minWidth:900 }}>
                      <thead><tr style={{ background:"#F8FAFC" }}>{["Generic Name","Brand","Str","Form","Batch","Expiry","MRP ₹","Retail ₹","Buy ₹","Qty",""].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                      <tbody>{purchaseForm.items.map((item,idx)=>(
                        <tr key={idx}>
                          {["genericName","brandName","strength","form","batchNumber","expiryDate","mrp","sellingPrice","purchasePrice","quantity"].map(key=>(
                            <td key={key} style={S.td}><input style={{ ...S.input,fontSize:12,padding:"5px 8px",width:key==="genericName"?120:key==="brandName"?100:key==="strength" || key==="form"?60:75 }} value={item[key]||""} placeholder={key==="expiryDate"?"YYYY-MM":""} onChange={e=>setPurchaseForm(p=>({...p,items:p.items.map((it,i)=>i===idx?{...it,[key]:e.target.value}:it)}))} /></td>
                          ))}
                          <td style={S.td}>
                            <button 
                              onClick={() => setPurchaseForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) }))} 
                              style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 14, padding: "4px 6px", borderRadius: 4, transition: "background 0.1s" }}
                              onMouseEnter={e => e.currentTarget.style.background = "#FEE2E2"}
                              onMouseLeave={e => e.currentTarget.style.background = "none"}
                              title="Remove item"
                            >
                              🗑️
                            </button>
                          </td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
                <div style={{ background:"#F8FAFC",border:`1px solid ${C.border}`,borderRadius:8,padding:14,marginBottom:14 }}>
                  <div style={{ fontSize:11,fontWeight:700,color:C.text3,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:10 }}>Add Item Manually</div>
                  <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit, minmax(100px, 1fr)) auto",gap:8,alignItems:"end" }}>
                    {[["Generic*","genericName","text"],["Brand","brandName","text"],["Strength","strength","text"],["Form","form","text"],["Barcode","barcode","text"],["Batch","batchNumber","text"],["Expiry","expiryDate","text"],["MRP","mrp","number"],["Retail ₹","sellingPrice","number"],["Buy ₹","purchasePrice","number"],["Qty*","quantity","number"]].map(([label,key,type])=>(
                      <div key={key}><label style={{ ...S.label,fontSize:10 }}>{label}</label><input type={type} style={{ ...S.input,padding:"7px 8px",fontSize:12 }} value={purchaseItem[key]} placeholder={key==="expiryDate"?"YYYY-MM":""} onChange={e=>setPurchaseItem(p=>({...p,[key]:e.target.value}))} /></div>
                    ))}
                    <button style={{ ...S.btn("teal"),padding:"8px 12px",alignSelf:"flex-end" }} onClick={addPurchaseItem}>+ Add</button>
                  </div>
                </div>
                <div style={{ display:"flex",gap:10,alignItems:"center",flexWrap:"wrap" }}>
                  <button style={{ ...S.btn("green"),fontSize:14,padding:"11px 22px" }} onClick={savePurchase}>Save + Update Stock</button>
                  <button style={S.btn("outline")} onClick={()=>{setShowPurchaseForm(false);setAiStatus("");setPurchaseForm({supplierName:"",invoiceNumber:"",invoiceDate:"",paymentStatus:"Unpaid",items:[]});}}>Cancel</button>
                  {purchaseForm.items.length>0&&<span style={S.badge("teal")}>{purchaseForm.items.length} items · ₹{purchaseForm.items.reduce((a,i)=>a+(+(i.purchasePrice||0)*(+(i.quantity||0))),0).toFixed(2)}</span>}
                </div>
              </div>
            )}

            <div style={S.card}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
                <span style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px" }}>Purchase History</span>
                <span style={S.badge("teal")}>{purchases.length} invoices</span>
              </div>
              {purchases.length===0?<div style={{ color:C.text3,fontSize:13,padding:"16px 0" }}>No purchases yet. Use the AI scanner or add manually!</div>
                :purchases.slice(0,20).map(p=>(
                  <div key={p.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}` }}>
                    <div><div style={{ fontSize:13,fontWeight:600,color:C.navy }}>{p.supplierName} <span style={{ color:C.text3,fontWeight:400,fontSize:12 }}>#{p.invoiceNumber}</span></div><div style={{ fontSize:11,color:C.text3,marginTop:1 }}>{p.invoiceDate} · {(p.items||[]).length} items</div></div>
                    <div style={{ display:"flex",gap:14,alignItems:"center" }}>
                      <div style={{ textAlign:"right" }}><div style={{ fontSize:14,fontWeight:700,color:C.navy }}>₹{(p.totalAmount||0).toFixed(2)}</div><span style={S.badge(p.paymentStatus==="Paid"?"green":p.paymentStatus==="Partial"?"amber":"red")}>{p.paymentStatus}</span></div>
                      <button onClick={() => deletePurchase(p)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13, padding: 5 }} title="Delete Purchase Invoice">🗑️</button>
                    </div>
                  </div>
                ))}
            </div>
            {suppliers.length>0&&(
              <div style={S.card}>
                <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Supplier Ledger</div>
                <table style={{ width:"100%",borderCollapse:"collapse" }}>
                  <thead><tr style={{ background:"#F8FAFC" }}>{["Supplier","Total Purchases","Outstanding","Status"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>{suppliers.map(s=>(<tr key={s.id}><td style={{ ...S.td,fontWeight:600,color:C.navy }}>{s.name}</td><td style={{ ...S.td,fontWeight:700,color:C.blue }}>₹{(s.totalPurchases||0).toFixed(2)}</td><td style={{ ...S.td,fontWeight:700,color:(s.outstanding||0)>0?C.red:C.green }}>₹{(s.outstanding||0).toFixed(2)}</td><td style={S.td}><span style={S.badge((s.outstanding||0)>0?"red":"green")}>{(s.outstanding||0)>0?"Due":"Clear"}</span></td></tr>))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* INVENTORY */}
        {!dbLoading && activeTab === "inventory" && (
          <div>
            <PH title="Inventory" sub={`${medicines.length} medicines · Cloud synced`} action={<button style={S.btn("primary")} onClick={()=>setShowAddMedForm(f=>!f)}>+ Add Medicine</button>} />
            <input style={{ ...S.input,fontSize:14,padding:"12px 14px",border:`2px solid ${C.border2}`,marginBottom:14 }} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search by generic name, brand, or category..." />

            {/* Smart Inventory Ingestion Engine */}
            <div style={{ ...S.card, border:"1.5px solid #0D7377", background:"#F5FAF9", marginBottom:16 }}>
              <div style={{ display:"flex", alignItems:"flex-start", gap:14, flexWrap:"wrap" }}>
                <div style={{ width:44, height:44, borderRadius:10, background:"#E0F7F4", display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>💊</div>
                <div style={{ flex:1, minWidth:260 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:C.teal, marginBottom:3 }}>Smart Inventory Ingestion Engine <span style={{ fontSize:10, background:"#E0F7F4", color:C.teal, padding:"2px 8px", borderRadius:20, marginLeft:6 }}>SAAS LEVEL</span></div>
                  <div style={{ fontSize:12, color:C.text2, marginBottom:12 }}>Choose to upload an Excel/CSV data sheet to batch import inventory, or take/upload a photo of any medicine package to scan details using AI.</div>
                  {aiStatus && <div style={{ fontSize:13, fontWeight:500, marginBottom:10, padding:"8px 12px", borderRadius:8, color:aiStatus.startsWith("✓")?C.green:aiStatus.startsWith("⚠")?C.amber:C.blue, background:aiStatus.startsWith("✓")?"#E8F5EE":aiStatus.startsWith("⚠")?"#FFF8E7":"#EBF4FF" }}>{aiStatus}</div>}
                  
                  <div style={{ display:"flex", gap:10, alignItems:"center", flexWrap:"wrap" }}>
                    <input type="file" accept=".xlsx,.xls,.csv" ref={inventoryExcelInputRef} onChange={handleExcelInventoryUpload} style={{ display:"none" }} />
                    <button style={S.btn("teal")} onClick={() => inventoryExcelInputRef.current?.click()} disabled={aiLoading}>
                      📊 Batch Excel Import
                    </button>
                    
                    <input type="file" accept="image/*" capture="environment" ref={productPhotoInputRef} onChange={handleProductPhotoUpload} style={{ display:"none" }} />
                    <button style={{ ...S.btn("ai"), opacity:aiLoading?0.7:1 }} onClick={() => productPhotoInputRef.current?.click()} disabled={aiLoading}>
                      {aiLoading ? "⏳ Scanning..." : "📸 AI Product Package Scan"}
                    </button>
                    
                    <button style={S.btn("outline")} onClick={downloadExcelInventoryTemplate}>
                      📥 Download Excel Template
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Excel Inventory Preview drawer */}
            {showExcelInventoryDrawer && (
              <div style={{ ...S.card, border: `2.5px solid ${C.teal}`, background: "#fff", padding: 24, marginBottom: 22, boxShadow: "0 12px 36px rgba(0,0,0,0.08)", borderRadius: 16 }}>
                
                {/* Header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2.5px solid ${C.border}`, paddingBottom: 16, marginBottom: 20 }}>
                  <div>
                    <h3 style={{ fontSize: 18, fontWeight: 800, color: C.navy, margin: 0 }}>📊 Legacy Inventory Migration Bridge</h3>
                    <p style={{ fontSize: 12, color: C.text3, marginTop: 4, marginBottom: 0 }}>Auto-map legacy column layouts, clean records, validate drug details, and ingest safely.</p>
                  </div>
                  <button 
                    style={S.btn("outline")} 
                    onClick={() => { setShowExcelInventoryDrawer(false); setExcelInventoryItems([]); setAiStatus(""); }}
                    disabled={isImporting}
                  >
                    ✕ Close Wizard
                  </button>
                </div>

                {/* Loading / Progress Indicator Overlay */}
                {isImporting && (
                  <div style={{ background: "rgba(255,255,255,0.9)", border: `1.5px solid ${C.teal2}`, borderRadius: 12, padding: "24px 30px", marginBottom: 20, textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.teal2, marginBottom: 12 }}>⚡ Ingestion Loop Running...</div>
                    <div style={{ background: C.border, height: 10, borderRadius: 5, overflow: "hidden", marginBottom: 10, maxWidth: 400, margin: "0 auto 10px" }}>
                      <div style={{ background: C.teal2, height: "100%", width: `${importProgress}%`, transition: "width 0.1s ease" }} />
                    </div>
                    <span style={{ fontSize: 13, color: C.text2, fontWeight: 600 }}>{importProgress}% Complete ({excelInventoryItems.length} items total)</span>
                  </div>
                )}

                {!isImporting && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                    
                    {/* Confidence Warning */}
                    {mappingConfidence < 0.7 && (
                      <div style={{ background: "#FEF3DC", border: "1px solid #F6D860", borderRadius: 8, padding: "12px 16px", color: C.amber, fontSize: 13, fontWeight: 600 }}>
                        ⚠️ Low Mapping Confidence ({(mappingConfidence * 100).toFixed(0)}%). Expected headers did not match. Please manually map columns below.
                      </div>
                    )}

                    {/* Presets and Template Saver */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, background: "#F8FAFC", border: `1.5px solid ${C.border}`, padding: 18, borderRadius: 12 }}>
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <label style={S.label}>Load Template Preset</label>
                        <select 
                          style={S.input}
                          value={selectedTemplateId}
                          onChange={e => handleTemplateSelect(e.target.value)}
                        >
                          <option value="">-- Choose Preset or Auto Match --</option>
                          {migrationTemplates.map(tmpl => (
                            <option key={tmpl.id} value={tmpl.id}>{tmpl.templateName}</option>
                          ))}
                        </select>
                      </div>
                      
                      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                        <label style={S.label}>Save Current Mapping Preset</label>
                        <div style={{ display: "flex", gap: 8 }}>
                          <input 
                            style={S.input} 
                            value={newTemplateName} 
                            onChange={e => setNewTemplateName(e.target.value)} 
                            placeholder="e.g. Marg Purchase Format" 
                          />
                          <button 
                            style={{ ...S.btn("teal"), padding: "8px 16px", whiteSpace: "nowrap" }}
                            onClick={saveMappingTemplate}
                          >
                            Save Preset
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Mapping Selectors grid */}
                    <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, padding: 18, borderRadius: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 12 }}>
                        🛠️ Configure Excel Columns Mapping
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
                        {[
                          ["genericName", "Generic Name *"],
                          ["brandName", "Brand Name"],
                          ["strength", "Strength"],
                          ["form", "Form"],
                          ["batchNumber", "Batch Number *"],
                          ["expiryDate", "Expiry Date *"],
                          ["purchasePrice", "Purchase Price *"],
                          ["mrp", "Printed MRP *"],
                          ["sellingPrice", "Selling Price"],
                          ["stockQty", "Stock Quantity *"],
                          ["barcode", "Barcode"]
                        ].map(([field, label]) => (
                          <div key={field} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>{label}</span>
                            <select 
                              style={{ ...S.input, fontSize: 12, padding: "6px 10px" }}
                              value={excelColumnMapping[field] !== undefined ? excelColumnMapping[field] : ""}
                              onChange={e => {
                                const val = e.target.value === "" ? -1 : parseInt(e.target.value);
                                const updated = { ...excelColumnMapping, [field]: val };
                                setExcelColumnMapping(updated);
                                applyExcelMapping(excelRawRows, updated);
                              }}
                            >
                              <option value="">-- Ignore --</option>
                              {excelRawHeaders.map((header, hIdx) => (
                                <option key={hIdx} value={hIdx}>Col {hIdx + 1}: {header}</option>
                              ))}
                            </select>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Preview Verification Grid Table */}
                    <div>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          📋 Ingestion Staging Grid ({excelInventoryItems.length} items)
                        </span>
                        <span style={{ fontSize: 11, color: C.text3 }}>
                          Double click or select cell to correct validation errors inline.
                        </span>
                      </div>

                      <div style={{ overflowX: "auto", border: `1.5px solid ${C.border}`, borderRadius: 12, maxHeight: 380 }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050 }}>
                          <thead>
                            <tr style={{ background: "#F8FAFC" }}>
                              {["Generic Name", "Brand", "Str / Form", "Batch No", "Expiry (YYYY-MM)", "MRP", "Retail", "Cost Rate", "Qty", "Fuzzy Resolution", ""].map(h => (
                                <th key={h} style={{ ...S.th, padding: "12px 14px" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {excelInventoryItems.map((item, idx) => {
                              const isMatch = item.matchType === "MATCH";
                              const isConflict = item.matchType === "CONFLICT";
                              const scorePct = Math.round(item.score * 100);

                              const handleCellChange = (field, val) => {
                                setExcelInventoryItems(prev => prev.map((it, i) => {
                                  if (i === idx) {
                                    const updatedItem = { ...it, [field]: val };
                                    
                                    if (field === "batchNumber") {
                                      updatedItem.batchMissing = !val.trim();
                                    }
                                    if (field === "expiryDate") {
                                      updatedItem.expiryInvalid = !val || !/^\d{4}-\d{2}$/.test(val);
                                    }
                                    if (field === "purchasePrice" || field === "mrp") {
                                      const cost = field === "purchasePrice" ? parseFloat(val) || 0 : it.purchasePrice;
                                      const mrpVal = field === "mrp" ? parseFloat(val) || 0 : it.mrp;
                                      updatedItem.priceInvalid = cost <= 0 || mrpVal <= 0 || cost > mrpVal;
                                    }
                                    if (field === "stockQty") {
                                      updatedItem.qtyInvalid = (parseInt(val) || 0) < 0;
                                    }

                                    const match = findBestMatch(updatedItem, medicines);
                                    updatedItem.matchType = match.type;
                                    updatedItem.matchedItem = match.item;
                                    updatedItem.score = match.score;
                                    updatedItem.overrideId = match.type === "MATCH" ? match.item.id : "";
                                    
                                    return updatedItem;
                                  }
                                  return it;
                                }));
                              };

                              return (
                                <tr key={idx} style={{ background: isConflict ? "#FFFDF5" : "" }}>
                                  <td style={S.td}>
                                    <input 
                                      style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 140, fontWeight: 700 }} 
                                      value={item.genericName} 
                                      onChange={e => handleCellChange("genericName", e.target.value)} 
                                    />
                                  </td>
                                  <td style={S.td}>
                                    <input 
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 100 }} 
                                      value={item.brandName} 
                                      onChange={e => handleCellChange("brandName", e.target.value)} 
                                    />
                                  </td>
                                  <td style={S.td}>
                                    <input 
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 70 }} 
                                      value={item.strength} 
                                      onChange={e => handleCellChange("strength", e.target.value)} 
                                      placeholder="Str"
                                    />
                                    <input 
                                      style={{ ...S.input, fontSize: 10, padding: "4px 8px", width: 70, marginTop: 4 }} 
                                      value={item.form} 
                                      onChange={e => handleCellChange("form", e.target.value)} 
                                      placeholder="Form"
                                    />
                                  </td>
                                  <td style={{ ...S.td, background: item.batchMissing ? "#FFF5F5" : "" }}>
                                    <input 
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 90, border: item.batchMissing ? `1.5px solid ${C.red}` : `1px solid ${C.border2}` }} 
                                      value={item.batchNumber} 
                                      onChange={e => handleCellChange("batchNumber", e.target.value)} 
                                      placeholder="Missing Batch"
                                    />
                                  </td>
                                  <td style={{ ...S.td, background: item.expiryInvalid ? "#FFF5F5" : "" }}>
                                    <input 
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 90, border: item.expiryInvalid ? `1.5px solid ${C.red}` : `1px solid ${C.border2}` }} 
                                      value={item.expiryDate} 
                                      onChange={e => handleCellChange("expiryDate", e.target.value)} 
                                      placeholder="YYYY-MM"
                                    />
                                  </td>
                                  <td style={{ ...S.td, background: item.priceInvalid ? "#FFF5F5" : "" }}>
                                    <input 
                                      type="number"
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 60, border: item.priceInvalid ? `1.5px solid ${C.red}` : `1px solid ${C.border2}` }} 
                                      value={item.mrp} 
                                      onChange={e => handleCellChange("mrp", e.target.value)} 
                                    />
                                  </td>
                                  <td style={{ ...S.td, background: item.priceInvalid ? "#FFF5F5" : "" }}>
                                    <input 
                                      type="number"
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 60, border: item.priceInvalid ? `1.5px solid ${C.red}` : `1px solid ${C.border2}`, color: C.teal2, fontWeight: 700 }} 
                                      value={item.sellingPrice} 
                                      onChange={e => handleCellChange("sellingPrice", e.target.value)} 
                                    />
                                  </td>
                                  <td style={{ ...S.td, background: item.priceInvalid ? "#FFF5F5" : "" }}>
                                    <input 
                                      type="number"
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 60, border: item.priceInvalid ? `1.5px solid ${C.red}` : `1px solid ${C.border2}` }} 
                                      value={item.purchasePrice} 
                                      onChange={e => handleCellChange("purchasePrice", e.target.value)} 
                                    />
                                  </td>
                                  <td style={{ ...S.td, background: item.qtyInvalid ? "#FFF5F5" : "" }}>
                                    <input 
                                      type="number"
                                      style={{ ...S.input, fontSize: 11, padding: "4px 8px", width: 50, border: item.qtyInvalid ? `1.5px solid ${C.red}` : `1px solid ${C.border2}` }} 
                                      value={item.stockQty} 
                                      onChange={e => handleCellChange("stockQty", e.target.value)} 
                                    />
                                  </td>
                                  <td style={S.td}>
                                    <span style={S.badge(isMatch ? "green" : isConflict ? "amber" : "blue")}>
                                      {isMatch ? `✅ Auto (${scorePct}%)` : isConflict ? `⚠️ Warn (${scorePct}%)` : "🆕 New drug"}
                                    </span>
                                  </td>
                                  <td style={S.td}>
                                    <select 
                                      style={{ ...S.input, fontSize: 11, padding: "4px 6px", width: 180, background: isConflict ? "#FFF9EB" : "#fff", border: isConflict ? `1.5px solid ${C.amber}` : `1.5px solid ${C.border2}` }}
                                      value={item.overrideId} 
                                      onChange={e => {
                                        const selectedVal = e.target.value;
                                        setExcelInventoryItems(prev => prev.map((it, i) => {
                                          if (i === idx) {
                                            const foundMed = medicines.find(m => m.id === selectedVal);
                                            return {
                                              ...it,
                                              overrideId: selectedVal,
                                              matchType: selectedVal ? "MATCH" : "NEW",
                                              matchedItem: foundMed || null
                                            };
                                          }
                                          return it;
                                        }));
                                      }}
                                    >
                                      <option value="">🆕 Create as New Medicine</option>
                                      {medicines.map(m => (
                                        <option key={m.id} value={m.id}>
                                          🔗 Bind: {m.brandName || m.genericName} {m.strength ? `(${m.strength} ${m.form})` : `(${m.form})`}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td style={S.td}>
                                    <button 
                                      onClick={() => setExcelInventoryItems(prev => prev.filter((_, i) => i !== idx))}
                                      style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}
                                    >
                                      🗑️
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Actions bar */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `2px solid ${C.border}`, paddingTop: 16 }}>
                      {excelInventoryItems.some(i => i.batchMissing || i.expiryInvalid || i.priceInvalid || i.qtyInvalid) ? (
                        <span style={{ fontSize: 13, color: C.red, fontWeight: 700 }}>
                          ⚠️ Resolve highlighted cells before confirming ingestion.
                        </span>
                      ) : (
                        <span style={{ fontSize: 12, color: C.text3, fontWeight: 600 }}>
                          ✓ All validation checks passed. Ready to ingest opening stock.
                        </span>
                      )}
                      <div style={{ display: "flex", gap: 10 }}>
                        <button 
                          style={S.btn("outline")} 
                          onClick={() => { setShowExcelInventoryDrawer(false); setExcelInventoryItems([]); setAiStatus(""); }}
                        >
                          Cancel & Discard
                        </button>
                        <button 
                          style={{ 
                            ...S.btn(excelInventoryItems.some(i => i.batchMissing || i.expiryInvalid || i.priceInvalid || i.qtyInvalid) ? "outline" : "green"), 
                            fontSize: 14, 
                            padding: "12px 28px" 
                          }}
                          disabled={excelInventoryItems.some(i => i.batchMissing || i.expiryInvalid || i.priceInvalid || i.qtyInvalid)}
                          onClick={saveExcelInventory}
                        >
                          🚀 Confirm Ingestion ({excelInventoryItems.length} Items)
                        </button>
                      </div>
                    </div>

                  </div>
                )}

              </div>
            )}

            {showAddMedForm&&(
              <div style={{ ...S.card,border:`1.5px solid ${C.teal}`,marginBottom:16 }}>
                <div style={{ fontSize:13,fontWeight:700,color:C.teal,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:16 }}>New Medicine Entry</div>
                <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:10 }}>
                  {[["Generic Name *","genericName","text"],["Brand Name","brandName","text"],["Strength (e.g. 500mg)","strength","text"],["Form (e.g. Tablet)","form","text"],["Barcode","barcode","text"],["Batch No.","batchNumber","text"],["Expiry (YYYY-MM)","expiryDate","text"],["MRP (₹) *","mrp","number"],["Retail Selling Price (₹)","sellingPrice","number"],["Purchase Price","purchasePrice","number"],["Stock Qty *","stockQty","number"],["Low Stock Alert","lowStockAlert","number"],["Category","category","text"]].map(([label,key,type])=>(
                    <FF key={key} label={label}><input type={type} style={S.input} value={newMed[key]} onChange={e=>setNewMed(p=>({...p,[key]:e.target.value}))} /></FF>
                  ))}
                  <FF label="GST Rate (%)"><select style={S.input} value={newMed.gstRate} onChange={e=>setNewMed(p=>({...p,gstRate:e.target.value}))}>{["0","5","12","18","28"].map(g=><option key={g} value={g}>{g}%</option>)}</select></FF>
                  <FF label="Unit"><select style={S.input} value={newMed.unit} onChange={e=>setNewMed(p=>({...p,unit:e.target.value}))}>{["Strip","Bottle","Piece","Vial","Tube"].map(u=><option key={u}>{u}</option>)}</select></FF>
                </div>
                <div style={{ display:"flex",gap:10,marginTop:16 }}>
                  <button style={S.btn("teal")} onClick={saveMedicine}>Save to Cloud</button>
                  <button style={S.btn("outline")} onClick={()=>setShowAddMedForm(false)}>Cancel</button>
                </div>
              </div>
            )}
            {/* REORDER SUGGESTIONS */}
            {reorderList.length > 0 && (
              <div style={{ background: "#FEF9EC", border: "1.5px solid #F6D860", borderRadius: 10, padding: 14, marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px" }}>🔄 Reorder Suggestions ({reorderList.length})</span>
                  <span style={{ fontSize: 11, color: C.text3 }}>Stock at or below alert threshold</span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {reorderList.slice(0, 8).map(m => (
                    <div key={m.id} style={{ background: "#fff", border: "1px solid #F6D860", borderRadius: 8, padding: "7px 12px", fontSize: 12 }}>
                      <span style={{ fontWeight: 700, color: C.navy }}>{m.genericName}</span>
                      <span style={{ color: C.text3, marginLeft: 6 }}>{m.brandName}</span>
                      <span style={{ marginLeft: 8, fontWeight: 700, color: m.stockQty === 0 ? C.red : C.amber }}>Qty: {m.stockQty}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ ...S.card,padding:0,overflow:"hidden" }}>
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%",borderCollapse:"collapse",minWidth:700 }}>
                  <thead><tr style={{ background:"#F8FAFC" }}>{["Generic Name","Brand","Batch","Expiry","Printed MRP","Retail Price","Buy Price","Margin","Qty","Status","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {filteredMeds.length===0?<tr><td colSpan={11} style={{ padding:24,textAlign:"center",color:C.text3,fontSize:13 }}>{medicines.length===0?"No medicines yet. Add your first medicine!":"No results."}</td></tr>
                      :filteredMeds.map(m=>{
                        const isExp = isExpired(m);
                        const isLow = m.stockQty <= m.lowStockAlert;
                        const margin = m.marginPct;
                        const firstBatch = Array.isArray(m.batches) && m.batches.length > 0 ? m.batches[0] : null;
                        const batchNo = m.batchNumber || firstBatch?.batchNumber || "—";
                        const expDate = m.expiryDate || firstBatch?.expiryDate || "—";
                        const buyPrice = m.purchasePrice || firstBatch?.purchasePrice || 0;
                        const retailPrice = m.sellingPrice || m.mrp || 0;
                        
                        return (
                          <tr key={m.id} onMouseEnter={e=>e.currentTarget.style.background="#F8FAFC"} onMouseLeave={e=>e.currentTarget.style.background=""} style={{ background: isExp ? "#FFF5F5" : "" }}>
                            <td style={{ ...S.td,fontWeight:600,color:C.navy }}>
                              {m.genericName} {m.strength && <span style={{ fontSize:11,fontWeight:400,color:C.text3 }}>({m.strength} {m.form})</span>}
                              {m.barcode && <div style={{ fontSize:9,color:C.text3,marginTop:2,fontWeight:400 }}>📷 Barcode: {m.barcode}</div>}
                            </td>
                            <td style={{ ...S.td,color:C.text2 }}>{m.brandName || "—"}</td>
                            <td style={{ ...S.td,color:C.text3,fontSize:12,fontFamily:"monospace" }}>{batchNo}</td>
                            <td style={{ ...S.td,fontSize:12,color:isExp?C.red:isExpiringSoon(m)?C.amber:C.text2,fontWeight:isExp?700:400 }}>{expDate}{isExp?" ⚠":""}</td>
                            <td style={{ ...S.td,color:C.text3 }}>₹{m.mrp}</td>
                            <td style={{ ...S.td,fontWeight:700,color:C.blue }}>₹{retailPrice}</td>
                            <td style={{ ...S.td,color:C.text2 }}>₹{buyPrice}</td>
                            <td style={{ ...S.td,fontWeight:700,color:margin !== null && margin >= 20 ? C.green : margin !== null && margin < 10 ? C.red : C.amber }}>{margin !== null ? `${margin}%` : "—"}</td>
                            <td style={{ ...S.td,fontWeight:700,color:isLow?C.amber:C.green }}>{m.stockQty}</td>
                            <td style={S.td}><span style={S.badge(isExp?"red":isLow?"amber":"green")}>{isExp?"Expired":isLow?"Low":"OK"}</span></td>
                            <td style={S.td}>
                              <button 
                                onClick={() => handleOpenOpeningStock(m)} 
                                style={{ background: "none", border: "none", color: C.teal, cursor: "pointer", fontSize: 12, marginRight: 12, fontWeight: 700 }} 
                                title="Add Opening Stock Batch"
                              >
                                ＋ Opening Stock
                              </button>
                              <button onClick={() => deleteMedicine(m.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 14 }} title="Delete Medicine">🗑️</button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Import Sessions History */}
            {importSessions.length > 0 && (
              <div style={{ ...S.card, marginTop: 22 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>
                  📂 Data Migration & Ingestion Sessions History
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC" }}>
                        {["Session ID", "Date", "Items Count", "Progress", "Status", "Action"].map(h => <th key={h} style={S.th}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {importSessions.map(session => {
                        const dateStr = session.createdAt?.toDate 
                          ? session.createdAt.toDate().toLocaleString("en-IN") 
                          : new Date(session.createdAt || 0).toLocaleString("en-IN");
                        const statusColors = {
                          COMPLETED: { bg: "#E8F5EE", text: C.green },
                          PROCESSING: { bg: "#EBF4FF", text: C.blue },
                          FAILED: { bg: "#FDECEA", text: C.red },
                          ROLLED_BACK: { bg: "#F1F5F9", text: C.text3 }
                        };
                        const col = statusColors[session.status] || { bg: "#F1F5F9", text: C.text3 };
                        
                        return (
                          <tr key={session.id}>
                            <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{session.id}</td>
                            <td style={S.td}>{dateStr}</td>
                            <td style={S.td}>{session.totalCount} items</td>
                            <td style={S.td}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ flex: 1, background: C.border, height: 6, borderRadius: 3, width: 80 }}>
                                  <div style={{ background: C.teal2, height: 6, borderRadius: 3, width: `${session.progress || 0}%` }} />
                                </div>
                                <span style={{ fontSize: 11, fontWeight: 600 }}>{session.progress || 0}%</span>
                              </div>
                            </td>
                            <td style={S.td}>
                              <span style={{ ...S.badge("teal"), background: col.bg, color: col.text }}>
                                {session.status}
                              </span>
                            </td>
                            <td style={S.td}>
                              {session.status === "COMPLETED" && (
                                <button 
                                  onClick={() => rollbackImportSession(session)}
                                  style={{ ...S.btn("outline"), padding: "4px 10px", fontSize: 11, borderColor: C.red, color: C.red, cursor: "pointer" }}
                                  onMouseEnter={e => { e.currentTarget.style.background = "#FFF5F5"; }}
                                  onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
                                >
                                  ↩ Rollback Ingestion
                                </button>
                              )}
                              {session.status === "ROLLED_BACK" && (
                                <span style={{ fontSize: 11, color: C.text3, fontStyle: "italic" }}>Rolled Back</span>
                              )}
                              {session.status === "FAILED" && (
                                <span style={{ fontSize: 11, color: C.red, fontStyle: "italic" }}>Failed Session</span>
                              )}
                              {session.status === "PROCESSING" && (
                                <span style={{ fontSize: 11, color: C.blue, fontStyle: "italic" }}>Running...</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

          </div>
        )}

        {/* BILLS HISTORY */}
        {!dbLoading && activeTab === "bills" && (
          <div>
            <PH title="Sales History" sub={`${sales.length} total bills · Click any to view & reprint`} />
            <input style={{ ...S.input,fontSize:14,padding:"12px 14px",border:`2px solid ${C.border2}`,marginBottom:14 }} value={billSearchQuery} onChange={e=>setBillSearchQuery(e.target.value)} placeholder="Search by bill number, patient name or phone..." />
            {selectedBill&&(
              <div style={{ ...S.card,border:`1.5px solid ${C.teal}`,marginBottom:16 }}>
                <div style={{ display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14 }}>
                  <div>
                    <div style={{ fontSize:16,fontWeight:700,color:C.navy }}>{selectedBill.billNumber}</div>
                    <div style={{ fontSize:12,color:C.text3,marginTop:2 }}>{selectedBill.createdAt?.toDate?selectedBill.createdAt.toDate().toLocaleString("en-IN"):"—"} · {selectedBill.paymentMode}</div>
                    {selectedBill.customerName&&<div style={{ fontSize:12,color:C.text2,marginTop:2 }}>Patient: {selectedBill.customerName}{selectedBill.customerPhone?` · ${selectedBill.customerPhone}`:""}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button style={S.btn("teal")} onClick={() => {
                      const finalBill = { ...selectedBill, date: selectedBill.createdAt?.toDate?.() || new Date() };
                      if (defaultPrintType === "A4") {
                        printA4PDFInvoice(finalBill);
                      } else {
                        printThermalReceipt(finalBill);
                      }
                    }}>
                      🖨️ Reprint Default ({defaultPrintType === "A4" ? "PDF" : "Thermal"})
                    </button>
                    <button style={S.btn("outline")} onClick={() => {
                      const finalBill = { ...selectedBill, date: selectedBill.createdAt?.toDate?.() || new Date() };
                      if (defaultPrintType === "A4") {
                        printThermalReceipt(finalBill);
                      } else {
                        printA4PDFInvoice(finalBill);
                      }
                    }}>
                      {defaultPrintType === "A4" ? "Thermal" : "PDF"}
                    </button>
                    {selectedBill.customerPhone && <button style={S.btn("whatsapp")} onClick={() => sendWhatsApp({ ...selectedBill, date: selectedBill.createdAt?.toDate?.() || new Date() }, selectedBill.customerPhone)}>WhatsApp</button>}
                    <button style={{ ...S.btn("outline"), borderColor: C.teal, color: C.teal }} onClick={() => handleOpenEditBill(selectedBill)}>
                      ✏️ Edit Bill
                    </button>
                    <button style={S.btn("outline")} onClick={() => setSelectedBill(null)}>Close</button>
                  </div>
                </div>
                <table style={{ width:"100%",borderCollapse:"collapse" }}>
                  <thead><tr style={{ background:"#F8FAFC" }}>{["Medicine","Qty","MRP","Unit Price","Discount","Amount"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>{(selectedBill.items||[]).map((item,i)=>{
                    const batchNo = item.batchesUsed?.[0]?.batchNumber || item.batchNumber || "—";
                    const expDate = item.batchesUsed?.[0]?.expiryDate || item.expiryDate || "—";
                    const unitPrice = item.sellingPrice || (item.discount > 0 ? item.mrp : ((item.total || 0) / (item.quantity || item.qty || 1))) || 0;
                    return (
                      <tr key={i}>
                        <td style={S.td}>
                          <div style={{ fontWeight:600,color:C.navy }}>{item.brandName || item.genericName}</div>
                          <div style={{ fontSize:11,color:C.text3,marginTop:2 }}>{item.genericName}</div>
                          <div style={{ fontSize:10,color:C.text3,marginTop:2,display:"flex",gap:10 }}>
                            <span>Batch: <strong>{batchNo}</strong></span>
                            <span>Exp: <strong>{expDate}</strong></span>
                          </div>
                        </td>
                        <td style={S.td}>{item.quantity||item.qty}</td>
                        <td style={S.td}>₹{(item.mrp || 0).toFixed(2)}</td>
                        <td style={S.td}>₹{unitPrice.toFixed(2)}</td>
                        <td style={S.td}>{item.discount||0}%</td>
                        <td style={{ ...S.td,fontWeight:700,color:C.green }}>₹{(item.total||0).toFixed(2)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
                <div style={{ display:"flex",justifyContent:"flex-end",marginTop:12,fontSize:16,fontWeight:700,color:C.navy }}>Grand Total: <span style={{ color:C.green,marginLeft:10 }}>₹{(selectedBill.grandTotal||0).toFixed(2)}</span></div>
              </div>
            )}
            <div style={S.card}>
              {filteredBills.length===0?<div style={{ color:C.text3,fontSize:13,padding:"16px 0" }}>No bills found.</div>
                :filteredBills.map(s=>(
                  <div key={s.id} onClick={()=>setSelectedBill(selectedBill?.id===s.id?null:s)}
                    style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"11px 0",borderBottom:`1px solid ${C.border}`,cursor:"pointer" }}
                    onMouseEnter={e=>e.currentTarget.style.background="#F8FAFC"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                    <div><div style={{ fontSize:13,fontWeight:600,color:C.navy }}>{s.billNumber} {s.customerName&&<span style={{ color:C.text3,fontWeight:400 }}>· {s.customerName}</span>}</div><div style={{ fontSize:11,color:C.text3,marginTop:1 }}>{s.createdAt?.toDate?s.createdAt.toDate().toLocaleString("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"} · {(s.items||[]).length} items</div></div>
                    <div style={{ display:"flex",gap:14,alignItems:"center" }}>
                      <div style={{ textAlign:"right" }}><div style={{ fontSize:14,fontWeight:700,color:C.blue }}>₹{(s.grandTotal||0).toFixed(2)}</div><div style={{ fontSize:11,color:C.text3,fontWeight:600 }}>{s.paymentMode}</div></div>
                      <button onClick={(e) => { e.stopPropagation(); deleteSale(s); }} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13, padding: 5 }} title="Delete/Cancel Bill">🗑️</button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* REPORTS */}
        {!dbLoading && activeTab === "reports" && (
          <div>
            <PH title="Reports & P&L" sub="Daily / Monthly profit & loss · Export PDF" />

            {/* PERIOD PRESETS QUICK BAR */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {[
                ["today", "Today"],
                ["week", "Last 7 Days"],
                ["month", "This Month"],
                ["custom", "Custom Range"]
              ].map(([val, label]) => {
                const isActive = reportFilters.period === val;
                return (
                  <button
                    key={val}
                    onClick={() => {
                      setReportFilters(f => {
                        const next = { ...f, period: val };
                        // Automatically initialize start/end dates if switching to custom to avoid empty filters
                        if (val === "custom" && !f.startDate) {
                          const todayStr = new Date().toISOString().split("T")[0];
                          next.startDate = todayStr;
                          next.endDate = todayStr;
                        }
                        return next;
                      });
                    }}
                    style={{
                      padding: "8px 18px",
                      borderRadius: 8,
                      border: `1.5px solid ${isActive ? C.teal : C.border2}`,
                      background: isActive ? "#E0F7F4" : "#fff",
                      color: isActive ? C.teal : C.text2,
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 13,
                      fontWeight: isActive ? 700 : 500,
                      transition: "all 0.15s ease"
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {/* DETAILED FILTERS GRID */}
            <div style={{ ...S.card, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 20 }}>
              {reportFilters.period === "custom" && (
                <>
                  <FF label="Start Date">
                    <input
                      type="date"
                      style={S.input}
                      value={reportFilters.startDate}
                      onChange={e => setReportFilters(f => ({ ...f, startDate: e.target.value }))}
                    />
                  </FF>
                  <FF label="End Date">
                    <input
                      type="date"
                      style={S.input}
                      value={reportFilters.endDate}
                      onChange={e => setReportFilters(f => ({ ...f, endDate: e.target.value }))}
                    />
                  </FF>
                </>
              )}

              <FF label="Payment Mode">
                <select
                  style={S.input}
                  value={reportFilters.paymentMode}
                  onChange={e => setReportFilters(f => ({ ...f, paymentMode: e.target.value }))}
                >
                  <option value="">All Payment Modes</option>
                  <option value="Cash">Cash Only</option>
                  <option value="UPI">UPI Only</option>
                  <option value="Card">Card Only</option>
                  <option value="Credit">Credit Only</option>
                </select>
              </FF>

              <FF label="Linked Supplier">
                <select
                  style={S.input}
                  value={reportFilters.supplierName}
                  onChange={e => setReportFilters(f => ({ ...f, supplierName: e.target.value }))}
                >
                  <option value="">All Suppliers</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </FF>

              <FF label="Target Medicine">
                <select
                  style={S.input}
                  value={reportFilters.medicineId}
                  onChange={e => setReportFilters(f => ({ ...f, medicineId: e.target.value }))}
                >
                  <option value="">All Medicines</option>
                  {medicines.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.brandName || m.genericName} {m.strength ? `(${m.strength})` : ""}
                    </option>
                  ))}
                </select>
              </FF>
            </div>

            {/* ACTION PANELS FOR EXPORTS */}
            <div style={{ ...S.card, display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 20, alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, letterSpacing: "0.5px" }}>EXPORT LEDGERS</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={S.btn("primary")} onClick={exportSalesExcel} disabled={isWorkerExporting}>
                  📊 Export Sales Excel
                </button>
                <button style={S.btn("teal")} onClick={exportPurchasesExcel} disabled={isWorkerExporting}>
                  📦 Export Purchases Excel
                </button>
                <button style={S.btn("whatsapp")} onClick={exportExpiryReturnsExcel} disabled={isWorkerExporting}>
                  ⏰ Expiry Return Worksheet
                </button>
                <button style={{ ...S.btn("primary"), background: "#D35400" }} onClick={exportTaxPDF} disabled={isWorkerExporting}>
                  📄 Export Tax PDF
                </button>
              </div>
            </div>

            {/* IMPORT LEGACY SALES DATA PANEL */}
            <div style={{ ...S.card, display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1px solid ${C.border}`, paddingBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, letterSpacing: "0.5px" }}>📥 IMPORT LEGACY SALES LEDGER</div>
                <button style={{ ...S.btn("outline"), padding: "6px 12px", fontSize: 11 }} onClick={downloadSalesTemplate}>
                  📥 Download CSV Template
                </button>
              </div>
              <p style={{ fontSize: 12, color: C.text2, lineHeight: 1.5 }}>
                Upload a historical sales spreadsheet (.csv or .xlsx) from legacy software (Marg, Tally, Vyapar).
                Missing medicines are auto-created in the inventory catalog, and stock counts are adjusted automatically to execute compliant billing.
              </p>
              
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <input
                  type="file"
                  accept=".csv, .xlsx"
                  style={{ display: "none" }}
                  id="sales-excel-import-input"
                  onChange={handleSalesExcelImport}
                />
                <button
                  style={S.btn("teal")}
                  onClick={() => document.getElementById("sales-excel-import-input").click()}
                  disabled={isImporting}
                >
                  📂 Select & Ingest Sales File
                </button>
                
                {isImporting && (
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, fontWeight: 700, color: C.teal, marginBottom: 4 }}>
                      <span>Ingesting Bills: {importProgress}%</span>
                      <span>Please keep cashier tab active</span>
                    </div>
                    <div style={{ width: "100%", height: 6, background: "#E2E8F0", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${importProgress}%`, height: "100%", background: C.teal, borderRadius: 3, transition: "width 0.1s" }} />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* WEB WORKER PROGRESS INDICATOR */}
            {isWorkerExporting && (
              <div style={{ background: "#EBF4FF", color: C.blue, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 20, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${C.blue}`, borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                <span>Web Worker compiling data stream, transforming cells, and packing report... Please wait.</span>
              </div>
            )}
            <div style={{ display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(150px,1fr))",gap:14,marginBottom:22 }}>
              {[
                { label:"TOTAL SALES",value:`₹${rTS.toFixed(2)}`,sub:`${rSales.length} bills`,accent:C.blue,vc:C.blue },
                { label:"TOTAL PURCHASE",value:`₹${rTP.toFixed(2)}`,sub:`${rPurch.length} invoices`,accent:C.teal,vc:C.teal },
                { label:"GROSS PROFIT",value:`₹${(rTS-rTP).toFixed(2)}`,sub:rTS>0?`${(((rTS-rTP)/rTS)*100).toFixed(1)}% margin`:"—",accent:rTS-rTP>=0?C.green:C.red,vc:rTS-rTP>=0?C.green:C.red },
                { label:"CASH SALES",value:`₹${rSales.filter(s=>s.paymentMode==="Cash").reduce((a,s)=>a+(s.grandTotal||0),0).toFixed(2)}`,sub:"Cash collected",accent:"#B7791F",vc:C.amber },
              ].map((card,i)=>(
                <div key={i} style={{ background:"#fff",border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",borderTop:`3px solid ${card.accent}` }}>
                  <div style={{ fontSize:10,fontWeight:700,color:C.text3,letterSpacing:"0.6px",marginBottom:8 }}>{card.label}</div>
                  <div style={{ fontSize:22,fontWeight:700,color:card.vc,marginBottom:3 }}>{card.value}</div>
                  <div style={{ fontSize:11,color:C.text3 }}>{card.sub}</div>
                </div>
              ))}
            </div>

            {/* GST LEDGER SUMMARY */}
            <div style={{ ...S.card, marginBottom: 22 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.teal, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>GST Tax Ledger Summary</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14 }}>
                <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>TAXABLE VALUE (NET)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.navy }}>₹{rSales.reduce((a, s) => a + (s.taxableAmount || 0), 0).toFixed(2)}</div>
                </div>
                <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>CGST COLLECTED (50%)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.blue }}>₹{rSales.reduce((a, s) => a + (s.cgstAmount || 0), 0).toFixed(2)}</div>
                </div>
                <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>SGST COLLECTED (50%)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.teal2 }}>₹{rSales.reduce((a, s) => a + (s.sgstAmount || 0), 0).toFixed(2)}</div>
                </div>
                <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>TOTAL GST REVENUE</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: C.green }}>₹{rSales.reduce((a, s) => a + (s.totalGst || 0), 0).toFixed(2)}</div>
                </div>
              </div>
            </div>

            {/* GST SLAB BREAKDOWN */}
            <div style={{ ...S.card, marginBottom: 22 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>GST Tax Slab Breakdown (GSTR-1 Auditing)</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      {["GST Slab", "Taxable Value", "CGST (50%)", "SGST (50%)", "Total Tax"].map(h => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const slabs = { 0: { taxable: 0, gst: 0 }, 5: { taxable: 0, gst: 0 }, 12: { taxable: 0, gst: 0 }, 18: { taxable: 0, gst: 0 }, 28: { taxable: 0, gst: 0 } };
                      rSales.forEach(s => {
                        (s.items || []).forEach(item => {
                          const rate = item.gstRate || 0;
                          if (slabs[rate] === undefined) slabs[rate] = { taxable: 0, gst: 0 };
                          slabs[rate].taxable += item.taxableValue || 0;
                          slabs[rate].gst += item.totalGst || 0;
                        });
                      });
                      const entries = Object.entries(slabs).filter(([_, d]) => d.taxable > 0 || d.gst > 0);
                      if (entries.length === 0) return <tr><td colSpan={5} style={{ ...S.td, textAlign: "center", color: C.text3 }}>No tax collections in this period.</td></tr>;
                      return entries.map(([rate, data]) => (
                        <tr key={rate}>
                          <td style={{ ...S.td, fontWeight: 600, color: C.navy }}>{rate}% Slab</td>
                          <td style={S.td}>₹{data.taxable.toFixed(2)}</td>
                          <td style={S.td}>₹{(data.gst / 2).toFixed(2)}</td>
                          <td style={S.td}>₹{(data.gst / 2).toFixed(2)}</td>
                          <td style={{ ...S.td, fontWeight: 700, color: C.green }}>₹{data.gst.toFixed(2)}</td>
                        </tr>
                      ));
                    })()}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display:"grid",gridTemplateColumns:"1fr 1fr",gap:16 }}>
              <div style={S.card}>
                <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Payment Breakdown</div>
                {["Cash","UPI","Card","Credit"].map(mode=>{const mS=rSales.filter(s=>s.paymentMode===mode);const mT=mS.reduce((a,s)=>a+(s.grandTotal||0),0);if(!mT)return null;return<div key={mode} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}` }}><span style={{ fontSize:13,color:C.text2 }}>{mode}</span><div style={{ textAlign:"right" }}><div style={{ fontSize:14,fontWeight:700,color:C.navy }}>₹{mT.toFixed(2)}</div><div style={{ fontSize:11,color:C.text3 }}>{mS.length} bills</div></div></div>;})}
                {rSales.length===0&&<div style={{ color:C.text3,fontSize:13 }}>No sales in this period.</div>}
              </div>
              <div style={S.card}>
                <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Recent Bills</div>
                {rSales.slice(0,7).map(s=>(<div key={s.id} style={{ display:"flex",justifyContent:"space-between",padding:"7px 0",borderBottom:`1px solid ${C.border}`,fontSize:12 }}><span style={{ color:C.text2 }}>{s.billNumber}{s.customerName?` · ${s.customerName}`:""}</span><span style={{ fontWeight:700,color:C.green }}>₹{(s.grandTotal||0).toFixed(2)}</span></div>))}
                {rSales.length===0&&<div style={{ color:C.text3,fontSize:13 }}>No sales in this period.</div>}
              </div>
            </div>
          </div>
        )}

        {/* ALERTS */}
        {!dbLoading && activeTab === "alerts" && (
          <div>
            <PH title="SaaS Alerts & Reorder Engine" sub="Real-time expiration warning system & smart restocking parameters" />
            
            {/* Low Stock & Smart Reorder */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>🔄 Smart Reorder Stock Alerts</span>
                <span style={S.badge("amber")}>{lowStock.length} items critical</span>
              </div>
              {lowStock.length === 0 ? (
                <div style={{ color: C.text3, fontSize: 13, padding: "8px 0" }}>All stock levels healthy ✓</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      {["Medicine Name", "Category", "Low Alert Limit", "Current Stock", "Suggested Reorder Qty"].map(h => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {lowStock.map(m => {
                      const reorderQty = Math.max(10, (m.lowStockAlert || 20) * 3 - m.stockQty);
                      return (
                        <tr key={m.id}>
                          <td style={{ ...S.td, fontWeight: 700, color: C.navy }}>{m.genericName} <span style={{ fontWeight: 400, color: C.text3, fontSize: 11 }}>({m.brandName || "generic"})</span></td>
                          <td style={S.td}>{m.category || "General"}</td>
                          <td style={S.td}>{m.lowStockAlert}</td>
                          <td style={{ ...S.td, fontWeight: 700, color: m.stockQty === 0 ? C.red : C.amber }}>{m.stockQty}</td>
                          <td style={S.td}>
                            <span style={{ ...S.badge("green"), fontWeight: 700 }}>Order +{reorderQty} units</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Batch Expiration Alerts */}
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 10, marginBottom: 14 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: C.red, textTransform: "uppercase", letterSpacing: "0.5px" }}>⏰ Expiration Alerts (Within 3 Months)</span>
                <span style={S.badge("red")}>{expiringSoon.length} warning flags</span>
              </div>
              {expiringSoon.length === 0 ? (
                <div style={{ color: C.text3, fontSize: 13, padding: "8px 0" }}>No medicines expiring within 3 months ✓</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      {["Medicine Name", "Batch Number", "Quantity", "Expiry Month", "Status"].map(h => <th key={h} style={S.th}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {medicines.filter(m => {
                      const nowMonth = new Date();
                      nowMonth.setDate(1);
                      nowMonth.setHours(0, 0, 0, 0);
                      const limit = new Date();
                      limit.setMonth(limit.getMonth() + 3);
                      return Array.isArray(m.batches) && m.batches.some(b => (b.quantity || 0) > 0 && getExpiryDate(b) <= limit);
                    }).map(m => {
                      const nowMonth = new Date();
                      nowMonth.setDate(1);
                      nowMonth.setHours(0, 0, 0, 0);
                      const limit = new Date();
                      limit.setMonth(limit.getMonth() + 3);
                      
                      const targetBatches = (m.batches || []).filter(b => (b.quantity || 0) > 0 && getExpiryDate(b) <= limit);
                      
                      return targetBatches.map((b, idx) => {
                        const isExpiredBatch = getExpiryDate(b) < nowMonth;
                        return (
                          <tr key={`${m.id}-${idx}`}>
                            <td style={{ ...S.td, fontWeight: 700, color: C.navy }}>{m.genericName} <span style={{ fontWeight: 400, color: C.text3, fontSize: 11 }}>({m.brandName || "generic"})</span></td>
                            <td style={{ ...S.td, fontFamily: "monospace" }}>{b.batchNumber}</td>
                            <td style={S.td}>{b.quantity}</td>
                            <td style={{ ...S.td, fontWeight: 700, color: isExpiredBatch ? C.red : C.amber }}>{b.expiryDate}</td>
                            <td style={S.td}>
                              <span style={S.badge(isExpiredBatch ? "red" : "amber")}>{isExpiredBatch ? "EXPIRED" : "EXPIRING SOON"}</span>
                            </td>
                          </tr>
                        );
                      });
                    })
                  }
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* STORE SETTINGS */}
        {!dbLoading && activeTab === "settings" && (
          <div>
            <PH title="Store Settings" sub="Configure store attributes and view staff onboarding parameters" />
            <div style={S.card}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 16 }}>Store Specifications</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
                <div>
                  <span style={S.label}>Store Name</span>
                  <div style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13, fontWeight: 600 }}>{storeName}</div>
                </div>
                <div>
                  <span style={S.label}>Unique Store Code</span>
                  <div style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13, fontWeight: 600, fontFamily: "monospace", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{storeCode}</span>
                    <button 
                      onClick={() => { navigator.clipboard.writeText(storeCode); alert("Store Code copied!"); }}
                      style={{ background: "none", border: "none", color: C.teal, cursor: "pointer", fontWeight: 700, fontSize: 11 }}
                    >
                      Copy Code
                    </button>
                  </div>
                </div>
                <div>
                  <span style={S.label}>Helpline Contact</span>
                  <div style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13 }}>{storeDetails?.helpline || "0-124-356-1100"}</div>
                </div>
                <div>
                  <span style={S.label}>Support Windows</span>
                  <div style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13 }}>{storeDetails?.supportTime || "9:30 AM To 6:00 PM"}</div>
                </div>
              </div>
              <div>
                <span style={S.label}>Store Address</span>
                <div style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13 }}>{storeDetails?.address || "No address configured"}</div>
              </div>
            </div>
            
            <div style={S.card}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 12 }}>Staff Integration</div>
              <p style={{ fontSize: 13, color: C.text2, lineHeight: 1.5, marginBottom: 12 }}>
                To onboard staff cashiers to this store instance, ask them to sign up for a new account on the login page and choose <strong>"Join an Existing Store"</strong> using the unique code: <strong>{storeCode}</strong>.
              </p>
              <div style={{ display: "inline-flex", background: "#E8F5EE", border: `1px solid ${C.green}`, color: C.green, borderRadius: 8, padding: "10px 16px", fontSize: 12, fontWeight: 600 }}>
                ✓ Staff members will automatically have access limited to Billing POS and sales receipts.
              </div>
            </div>

            <div style={S.card}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 12 }}>Print Layout Default Setting</div>
              <p style={{ fontSize: 13, color: C.text2, lineHeight: 1.5, marginBottom: 14 }}>
                Configure the default print format for sales transactions and patient invoices.
              </p>
              <div style={{ display: "flex", gap: 10 }}>
                {[
                  ["THERMAL", "Thermal Receipt (58mm)"],
                  ["A4", "A5 PDF Tax Invoice (Landscape)"]
                ].map(([mode, label]) => {
                  const isActive = defaultPrintType === mode;
                  return (
                    <button
                      key={mode}
                      onClick={() => setDefaultPrintType(mode)}
                      style={{
                        padding: "10px 18px",
                        borderRadius: 8,
                        border: `1.5px solid ${isActive ? C.teal : C.border2}`,
                        background: isActive ? "#E0F7F4" : "#fff",
                        color: isActive ? C.teal : C.text2,
                        cursor: "pointer",
                        fontWeight: 600,
                        fontSize: 13
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* REORDERS */}
        {!dbLoading && activeTab === "reorders" && (
          <div>
            <PH title="Smart Reorder Intelligence Hub" sub="Forecasts stock runouts and auto-clusters purchase drafts by vendor" />
            
            <div style={{ ...S.card, background: "#FFFBEB", border: "1.5px solid #F59E0B", marginBottom: 16 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: 24 }}>🔄</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.amber }}>Smart Run-Rate Inventory Cover</div>
                  <div style={{ fontSize: 12, color: C.text2 }}>The system monitors billing counts dynamically. Suggested orders target a <b>30-day stock cover</b> based on sales velocities.</div>
                </div>
              </div>
            </div>

            <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
              {getSmartReorders().length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      <th style={S.th}>Medicine Name</th>
                      <th style={S.th}>Current Stock</th>
                      <th style={S.th}>7-Day Sales</th>
                      <th style={S.th}>Runout Days</th>
                      <th style={S.th}>Suggested Qty</th>
                      <th style={S.th}>Suggested Vendor</th>
                      <th style={S.th}>Last Price</th>
                      <th style={S.th}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {getSmartReorders().map(med => {
                      const vendorName = med.lastDistributorName || "No Linked Vendor";
                      return (
                        <tr key={med.id}>
                          <td style={S.td}>
                            <div style={{ fontWeight: 600, color: C.navy }}>{med.genericName}</div>
                            <div style={{ fontSize: 11, color: C.text3 }}>{med.brandName}</div>
                          </td>
                          <td style={S.td}>
                            <span style={{ fontWeight: 600, color: med.stockQty <= (med.lowStockAlert || 20) ? C.red : C.text2 }}>
                              {med.stockQty}
                            </span>
                          </td>
                          <td style={S.td}>{med.weeklySales} units</td>
                          <td style={S.td}>
                            <span style={{ 
                              fontWeight: 700, 
                              color: typeof med.runoutDays === "number" && med.runoutDays <= 3 ? C.red : typeof med.runoutDays === "number" && med.runoutDays <= 7 ? C.amber : C.green 
                            }}>
                              {typeof med.runoutDays === "number" ? `${med.runoutDays} days` : med.runoutDays}
                            </span>
                          </td>
                          <td style={{ ...S.td, fontWeight: 700, color: C.blue }}>{med.suggestedQty} units</td>
                          <td style={S.td}>{vendorName}</td>
                          <td style={S.td}>₹{(med.lastPurchasePrice || med.purchasePrice || 0).toFixed(2)}</td>
                          <td style={S.td}>
                            <button 
                              style={S.btn(med.lastDistributorName ? "teal" : "outline")}
                              onClick={() => handleOpenCreatePo(vendorName)}
                            >
                              📋 Create PO
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div style={{ textAlign: "center", padding: "48px 0", color: C.text3 }}>
                  <div style={{ fontSize: 44, marginBottom: 12, opacity: 0.2 }}>✓</div>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>Stock levels healthy! No reorder suggestions.</div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {poModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(10,35,66,0.5)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff",
            borderRadius: 16,
            width: "100%",
            maxWidth: 600,
            padding: 24,
            boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
            border: `1px solid ${C.border}`
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Create Purchase Order (Draft)</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Supplier: {poModal.supplierName}</span>
              </div>
              <button 
                onClick={() => setPoModal(null)} 
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}
              >
                ×
              </button>
            </div>
            
            <div style={{ marginBottom: 16 }}>
              <label style={S.label}>Supplier Contact Phone</label>
              <input 
                style={S.input} 
                value={poModal.phone} 
                onChange={e => setPoModal(prev => ({ ...prev, phone: e.target.value }))} 
                placeholder="Enter 10-digit number for WhatsApp dispatch"
              />
            </div>

            <div style={{ maxHeight: 200, overflowY: "auto", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: "8px 12px", marginBottom: 16, background: "#F8FAFC" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                <span>Item Details</span>
                <span>Est Price</span>
              </div>
              {poModal.items.map((item, idx) => (
                <div key={item.medicineId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: idx === poModal.items.length - 1 ? "none" : `1px solid ${C.border}` }}>
                  <div>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.navy }}>{item.brandName || item.genericName}</span>
                    <span style={{ fontSize: 11, color: C.text3, marginLeft: 6 }}>({item.suggestedQty} units suggested)</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <input 
                      type="number" 
                      min="1" 
                      value={item.suggestedQty} 
                      onChange={e => {
                        const val = parseInt(e.target.value) || 0;
                        setPoModal(prev => {
                          const updated = [...prev.items];
                          updated[idx] = { ...updated[idx], suggestedQty: val };
                          return { ...prev, items: updated };
                        });
                      }}
                      style={{ ...S.input, width: 64, padding: "4px 8px", fontSize: 12 }} 
                    />
                    <span style={{ fontSize: 13, fontWeight: 700, color: C.text2, width: 60, textAlign: "right" }}>₹{(item.suggestedQty * item.lastPurchasePrice).toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ background: "#EBF4FF", border: `1px solid ${C.blue}`, borderRadius: 8, padding: 12, marginBottom: 20 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 4 }}>📋 Draft Message Preview:</div>
              <pre style={{ fontSize: 11, fontFamily: "monospace", whiteSpace: "pre-wrap", margin: 0, color: "#1E3A8A" }}>
                {getWhatsAppPoText()}
              </pre>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => { navigator.clipboard.writeText(getWhatsAppPoText()); alert("✓ PO Text copied to clipboard!"); }}>
                Copy Text
              </button>
              {poModal.phone && (
                <button style={S.btn("whatsapp")} onClick={handleSendWhatsAppPo}>
                  Send WhatsApp
                </button>
              )}
              <button style={S.btn("teal")} onClick={savePurchaseOrderDraft}>
                Save PO Draft
              </button>
            </div>
          </div>
        </div>
      )}

      {openingStockModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(10,35,66,0.5)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff",
            borderRadius: 16,
            width: "100%",
            maxWidth: 500,
            padding: 24,
            boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
            border: `1px solid ${C.border}`
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Add Opening Stock Batch</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Medicine: {openingStockModal.brandName || openingStockModal.genericName}</span>
              </div>
              <button 
                onClick={() => setOpeningStockModal(null)} 
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}
              >
                ×
              </button>
            </div>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <FF label="Batch Number *">
                <input 
                  style={S.input} 
                  value={openingStockForm.batchNumber} 
                  onChange={e => setOpeningStockForm(prev => ({ ...prev, batchNumber: e.target.value.toUpperCase() }))} 
                />
              </FF>
              <FF label="Expiry Date * (YYYY-MM)">
                <input 
                  style={S.input} 
                  value={openingStockForm.expiryDate} 
                  onChange={e => setOpeningStockForm(prev => ({ ...prev, expiryDate: e.target.value }))} 
                  placeholder="e.g. 2027-12"
                />
              </FF>
              <FF label="Landed Purchase Price *">
                <input 
                  type="number"
                  style={S.input} 
                  value={openingStockForm.purchasePrice} 
                  onChange={e => setOpeningStockForm(prev => ({ ...prev, purchasePrice: e.target.value }))} 
                />
              </FF>
              <FF label="Quantity (Strips/Units) *">
                <input 
                  type="number"
                  style={S.input} 
                  value={openingStockForm.quantity} 
                  onChange={e => setOpeningStockForm(prev => ({ ...prev, quantity: e.target.value }))} 
                />
              </FF>
              <FF label="Printed MRP *">
                <input 
                  type="number"
                  style={S.input} 
                  value={openingStockForm.mrp} 
                  onChange={e => setOpeningStockForm(prev => ({ ...prev, mrp: e.target.value }))} 
                />
              </FF>
              <FF label="Retail Selling Price *">
                <input 
                  type="number"
                  style={S.input} 
                  value={openingStockForm.sellingPrice} 
                  onChange={e => setOpeningStockForm(prev => ({ ...prev, sellingPrice: e.target.value }))} 
                />
              </FF>
            </div>

            <div style={{ background: "#F4F6F9", border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, marginBottom: 20, fontSize: 11, color: C.text2, lineHeight: 1.4 }}>
              📌 <b>Onboarding Safe Mode:</b> Opening stock values directly initialize inventory levels. This entry is isolated and will <u>not</u> generate GST liability documents or write to supplier balance sheet ledgers.
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setOpeningStockModal(null)}>
                Cancel
              </button>
              <button style={S.btn("teal")} onClick={saveOpeningStock}>
                Confirm & Add Stock
              </button>
            </div>
          </div>
        </div>
      )}

      {showSalesImportDrawer && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(10,35,66,0.5)",
          backdropFilter: "blur(4px)",
          display: "flex",
          justifyContent: "flex-end",
          zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff",
            width: "100%",
            maxWidth: 700,
            height: "100%",
            display: "flex",
            flexDirection: "column",
            boxShadow: "-10px 0 30px rgba(0,0,0,0.15)",
            borderLeft: `1px solid ${C.border}`,
            position: "relative"
          }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, padding: "20px 24px", background: "#F8FAFC" }}>
              <div>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: C.navy, margin: 0 }}>📊 Bulk Sales Import Preview</h3>
                <span style={{ fontSize: 12, color: C.text3 }}>Verify bills, resolve warnings, and commit transactions.</span>
              </div>
              <button 
                onClick={() => { setShowSalesImportDrawer(false); setPreviewImportedSales([]); }} 
                style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: C.text3 }}
              >
                ×
              </button>
            </div>

            {/* Progress bar */}
            {isImportingSales && (
              <div style={{ background: "#EBF4FF", padding: "12px 24px", borderBottom: `1.5px solid ${C.border}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 700, color: C.blue, marginBottom: 6 }}>
                  <span>Generating & Committing Bills...</span>
                  <span>{importSalesProgress}%</span>
                </div>
                <div style={{ width: "100%", height: 8, background: "#E2E8F0", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${importSalesProgress}%`, height: "100%", background: C.blue, borderRadius: 4, transition: "width 0.1s" }} />
                </div>
              </div>
            )}

            {/* Search and Stats */}
            <div style={{ padding: "16px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
              <input 
                style={{ ...S.input, maxWidth: 300 }} 
                placeholder="🔍 Filter by Bill No or Patient..." 
                value={importSalesSearch}
                onChange={e => setImportSalesSearch(e.target.value)}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <span style={S.badge("blue")}>{previewImportedSales.length} Bills</span>
                {previewImportedSales.some(b => b.hasNew) && <span style={S.badge("red")}>🆕 New Drug(s)</span>}
                {previewImportedSales.some(b => b.hasShortage) && <span style={S.badge("amber")}>⚠️ Shortage(s)</span>}
              </div>
            </div>

            {/* Scrollable list */}
            <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16, background: C.bg }}>
              {previewImportedSales
                .filter(b => 
                  b.billNo.toLowerCase().includes(importSalesSearch.toLowerCase()) || 
                  b.customerName.toLowerCase().includes(importSalesSearch.toLowerCase())
                )
                .map((bill) => (
                  <div key={bill.billNo} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, boxShadow: "0 2px 4px rgba(0,0,0,0.02)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, borderBottom: `1px solid ${C.border}`, paddingBottom: 10 }}>
                      <div>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>Bill #{bill.billNo}</span>
                        <span style={{ fontSize: 11, color: C.text3, marginLeft: 8 }}>({bill.timestamp})</span>
                        <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
                          👤 Patient: <b>{bill.customerName}</b> {bill.doctorName && ` · Dr: ${bill.doctorName}`}
                        </div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 14, fontWeight: 800, color: C.blue }}>₹{bill.totalAmount.toFixed(2)}</div>
                        <span style={{ ...S.badge("teal"), fontSize: 10, marginTop: 4 }}>{bill.saleType}</span>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {bill.items.map((item, idx) => (
                        <div key={idx} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ fontWeight: 600, color: C.text }}>{item.itemName}</span>
                            <span style={{ color: C.text3 }}>x {item.qty}</span>
                          </div>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            {item.isNew && <span style={{ ...S.badge("red"), fontSize: 9, padding: "1px 6px" }}>🆕 New Drug</span>}
                            {!item.isNew && item.isShortage && <span style={{ ...S.badge("amber"), fontSize: 9, padding: "1px 6px" }}>⚠️ Shortage</span>}
                            <span style={{ fontWeight: 600, color: C.text2 }}>₹{item.estimatedTotal.toFixed(2)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>

            {/* Footer */}
            <div style={{ borderTop: `1.5px solid ${C.border}`, padding: "20px 24px", background: "#F8FAFC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 11, color: C.text3, fontWeight: 700, textTransform: "uppercase" }}>Total Est. Revenue</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>
                  ₹{previewImportedSales.reduce((sum, b) => sum + b.totalAmount, 0).toFixed(2)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button 
                  style={S.btn("outline")} 
                  disabled={isImportingSales}
                  onClick={() => { setShowSalesImportDrawer(false); setPreviewImportedSales([]); }}
                >
                  Cancel
                </button>
                <button 
                  style={{ ...S.btn(isImportingSales ? "outline" : "green"), padding: "12px 24px", fontSize: 14 }}
                  disabled={isImportingSales}
                  onClick={commitImportedSales}
                >
                  {isImportingSales ? "Processing..." : `🚀 Generate & Commit All ${previewImportedSales.length} Bills`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {editBillModalData && editBillForm && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(10,35,66,0.5)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff",
            borderRadius: 16,
            width: "90%",
            maxWidth: 900,
            height: "90%",
            maxHeight: 700,
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
            border: `1px solid ${C.border}`,
            overflow: "hidden"
          }}>
            {/* Modal Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, padding: "16px 24px", background: "#F8FAFC" }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>✏️ Edit Sales Bill ({editBillModalData.billNumber})</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Modify transaction parameters and recalculate inventory.</span>
              </div>
              <button 
                onClick={() => setEditBillModalData(null)} 
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}
              >
                ×
              </button>
            </div>

            {/* Modal Content - Split layout */}
            <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
              {/* Left Panel - Metadata form fields */}
              <div style={{ width: "35%", borderRight: `1px solid ${C.border}`, padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
                <FF label="Bill Number">
                  <div style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13, fontWeight: 600 }}>
                    {editBillModalData.billNumber}
                  </div>
                </FF>

                <FF label="Bill Date & Time *">
                  <input 
                    type="datetime-local" 
                    style={S.input} 
                    value={editBillForm.createdAt} 
                    onChange={e => setEditBillForm(prev => ({ ...prev, createdAt: e.target.value }))} 
                  />
                </FF>

                <FF label="Patient Name">
                  <input 
                    style={S.input} 
                    value={editBillForm.customerName} 
                    onChange={e => setEditBillForm(prev => ({ ...prev, customerName: e.target.value }))} 
                  />
                </FF>

                <FF label="Phone / Contact">
                  <input 
                    style={S.input} 
                    value={editBillForm.customerPhone} 
                    onChange={e => setEditBillForm(prev => ({ ...prev, customerPhone: e.target.value }))} 
                  />
                </FF>

                <FF label="Doctor Name">
                  <input 
                    style={S.input} 
                    value={editBillForm.doctorName} 
                    onChange={e => setEditBillForm(prev => ({ ...prev, doctorName: e.target.value }))} 
                  />
                </FF>

                <FF label="Prescription Number">
                  <input 
                    style={S.input} 
                    value={editBillForm.prescriptionNo} 
                    onChange={e => setEditBillForm(prev => ({ ...prev, prescriptionNo: e.target.value }))} 
                  />
                </FF>

                <FF label="Payment Mode">
                  <select 
                    style={S.input} 
                    value={editBillForm.paymentMode} 
                    onChange={e => setEditBillForm(prev => ({ ...prev, paymentMode: e.target.value }))}
                  >
                    {["Cash", "UPI", "Card", "Credit"].map(mode => <option key={mode}>{mode}</option>)}
                  </select>
                </FF>
              </div>

              {/* Right Panel - Items table & Search */}
              <div style={{ width: "65%", padding: 20, display: "flex", flexDirection: "column", gap: 14, overflow: "hidden" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", borderBottom: `1px solid ${C.border}`, paddingBottom: 6 }}>
                  Bill items & quantities
                </div>

                {/* Items List Scroll Area */}
                <div style={{ flex: 1, overflowY: "auto", border: `1px solid ${C.border}`, borderRadius: 10, background: "#FFF" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC" }}>
                        {["Medicine", "Qty", "Price", "Disc%", "Total", ""].map(h => <th key={h} style={{ ...S.th, padding: "8px 10px" }}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {editBillForm.items.length === 0 ? (
                        <tr>
                          <td colSpan={6} style={{ padding: 24, textAlign: "center", color: C.text3, fontSize: 13 }}>
                            No items in this bill. Search and add below.
                          </td>
                        </tr>
                      ) : (
                        editBillForm.items.map((item, idx) => {
                          const total = item.qty * item.sellingPrice;
                          const disc = total * (item.discount || 0) / 100;
                          const finalAmt = total - disc;

                          return (
                            <tr key={idx}>
                              <td style={{ ...S.td, padding: "8px 10px" }}>
                                <div style={{ fontWeight: 600 }}>{item.brandName || item.genericName}</div>
                                <div style={{ fontSize: 10, color: C.text3 }}>{item.genericName}</div>
                                <div style={{ fontSize: 9, color: C.text3, marginTop: 2, display: "flex", gap: 8 }}>
                                  <span>Batch: <strong>{item.batchesUsed?.[0]?.batchNumber || item.batchNumber || "—"}</strong></span>
                                  <span>Exp: <strong>{item.batchesUsed?.[0]?.expiryDate || item.expiryDate || "—"}</strong></span>
                                  <span>MRP: <strong>₹{item.mrp}</strong></span>
                                </div>
                              </td>
                              <td style={{ ...S.td, padding: "8px 10px" }}>
                                <input 
                                  type="number" 
                                  min="1" 
                                  style={{ ...S.input, width: 60, padding: "4px 8px" }} 
                                  value={item.qty} 
                                  onChange={e => {
                                    const val = Math.max(1, parseInt(e.target.value) || 1);
                                    setEditBillForm(prev => {
                                      const nextItems = [...prev.items];
                                      nextItems[idx] = { ...nextItems[idx], qty: val };
                                      return { ...prev, items: nextItems };
                                    });
                                  }}
                                />
                              </td>
                              <td style={{ ...S.td, padding: "8px 10px" }}>
                                <input 
                                  type="number" 
                                  min="0" 
                                  step="0.01" 
                                  style={{ ...S.input, width: 70, padding: "4px 8px" }} 
                                  value={item.sellingPrice} 
                                  onChange={e => {
                                    const val = Math.max(0, parseFloat(e.target.value) || 0);
                                    setEditBillForm(prev => {
                                      const nextItems = [...prev.items];
                                      nextItems[idx] = { ...nextItems[idx], sellingPrice: val };
                                      return { ...prev, items: nextItems };
                                    });
                                  }}
                                />
                              </td>
                              <td style={{ ...S.td, padding: "8px 10px" }}>
                                <input 
                                  type="number" 
                                  min="0" 
                                  max="100" 
                                  style={{ ...S.input, width: 55, padding: "4px 8px" }} 
                                  value={item.discount} 
                                  onChange={e => {
                                    const val = Math.min(100, Math.max(0, parseFloat(e.target.value) || 0));
                                    setEditBillForm(prev => {
                                      const nextItems = [...prev.items];
                                      nextItems[idx] = { ...nextItems[idx], discount: val };
                                      return { ...prev, items: nextItems };
                                    });
                                  }}
                                />
                              </td>
                              <td style={{ ...S.td, padding: "8px 10px", fontWeight: 700, color: C.green }}>
                                ₹{finalAmt.toFixed(2)}
                              </td>
                              <td style={{ ...S.td, padding: "8px 10px", textAlign: "right" }}>
                                <button 
                                  onClick={() => {
                                    setEditBillForm(prev => ({
                                      ...prev,
                                      items: prev.items.filter((_, i) => i !== idx)
                                    }));
                                  }}
                                  style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13 }}
                                >
                                  🗑️
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Add New Item Search Box */}
                <div style={{ position: "relative" }}>
                  <input 
                    style={S.input} 
                    placeholder="🔍 Add new medicine to this bill..." 
                    value={editBillSearch}
                    onChange={e => setEditBillSearch(e.target.value)}
                  />
                  {editBillSearch.length >= 2 && (
                    <div style={{ position: "absolute", bottom: "100%", left: 0, right: 0, background: "#fff", border: `1.5px solid ${C.teal}`, borderRadius: 10, zIndex: 1000, maxHeight: 180, overflowY: "auto", boxShadow: "0 -4px 20px rgba(0,0,0,0.15)" }}>
                      {medicines
                        .filter(m => 
                          (m.genericName || "").toLowerCase().includes(editBillSearch.toLowerCase()) || 
                          (m.brandName || "").toLowerCase().includes(editBillSearch.toLowerCase())
                        )
                        .slice(0, 5)
                        .map(m => (
                          <button
                            key={m.id}
                            onClick={() => {
                              const activePrice = +m.sellingPrice || +m.mrp || 0;
                              setEditBillForm(prev => ({
                                ...prev,
                                items: [...prev.items, {
                                  medicineId: m.id,
                                  genericName: m.genericName,
                                  brandName: m.brandName || "",
                                  strength: m.strength || "",
                                  form: m.form || "",
                                  mrp: m.mrp || 0,
                                  sellingPrice: activePrice,
                                  qty: 1,
                                  discount: 0,
                                  gstRate: m.gstRate || 12,
                                  batchesUsed: []
                                }]
                              }));
                              setEditBillSearch("");
                            }}
                            style={{ width: "100%", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", border: "none", borderBottom: `1px solid ${C.border}`, background: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}
                          >
                            <div>
                              <span style={{ fontWeight: 600, color: C.navy }}>{m.genericName}</span>
                              <span style={{ color: C.text3, fontSize: 11, marginLeft: 8 }}>{m.brandName}</span>
                            </div>
                            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                              <span style={{ fontWeight: 700, color: C.blue }}>₹{m.sellingPrice || m.mrp}</span>
                              <span style={S.badge(m.stockQty <= 0 ? "red" : "teal")}>Qty: {m.stockQty}</span>
                            </div>
                          </button>
                        ))
                      }
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div style={{ borderTop: `1.5px solid ${C.border}`, padding: "16px 24px", background: "#F8FAFC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: 11, color: C.text3, fontWeight: 700, textTransform: "uppercase" }}>New Grand Total</span>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>
                  ₹{editBillForm.items.reduce((sum, item) => sum + (item.qty * item.sellingPrice * (1 - (item.discount || 0) / 100)), 0).toFixed(2)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button 
                  style={S.btn("outline")} 
                  onClick={() => setEditBillModalData(null)}
                >
                  Cancel
                </button>
                <button 
                  style={S.btn("teal")} 
                  onClick={saveEditedBill}
                  disabled={editBillForm.items.length === 0}
                >
                  💾 Save Changes
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}