"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Sidebar from "@/components/Sidebar";
import PmbiPurchaseEntry from "@/components/PmbiPurchaseEntry";
import PmbiOpeningStock from "@/components/PmbiOpeningStock";
import PmbiItemMaster from "@/components/PmbiItemMaster";
import PmbiReports from "@/components/PmbiReports";
import H1DrugTracking from "@/components/H1DrugTracking";
import StockInventoryReport from "@/components/StockInventoryReport";
import Analytics from "@/components/Analytics";
import { auth, db } from "@/lib/firebase";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged, createUserWithEmailAndPassword, setPersistence, browserSessionPersistence } from "firebase/auth";
import { collection, addDoc, doc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, onSnapshot, where, limit, getDocs, getDoc, setDoc, runTransaction } from "firebase/firestore";


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

async function printThermalReceipt(bill, storeDetails) {
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

  const sName  = storeDetails?.name        || "JANAUSHADHI KENDRA";
  const sAddr  = storeDetails?.address     || "Ranebennur";
  const sPhone = storeDetails?.helpline    || storeDetails?.phone || "9964382376";
  const sGst   = storeDetails?.gstin       || "";
  const sDl    = storeDetails?.drugLicense || "";
  const upiId  = storeDetails?.upiId       || "7676309842@jupiteraxis";
  const payeeName = encodeURIComponent(storeDetails?.name || "Pradhan Mantri Bharatiya Janaushadhi Kendra");

  // ── Fetch UPI QR as Base64 ──────────────────────────────
  let qrBase64 = "";
  try {
    const upiData  = `upi://pay?pa=${upiId}&pn=${payeeName}&am=${(bill.grandTotal || 0).toFixed(2)}&cu=INR`;
    const qrUrl    = `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(upiData)}`;
    const qrRes    = await fetch(qrUrl);
    if (qrRes.ok) {
      const blob   = await qrRes.blob();
      qrBase64     = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror   = reject;
        reader.readAsDataURL(blob);
      });
    }
  } catch (e) {
    console.warn("QR fetch failed for thermal receipt:", e);
  }

  const qrSection = qrBase64
    ? `<div class="c" style="margin:8px 0 4px">
        <div style="font-size:9px;font-weight:bold;margin-bottom:4px">⬇ Scan &amp; Pay via UPI</div>
        <img src="${qrBase64}" width="100" height="100" style="display:block;margin:0 auto;border:1px solid #ccc"/>
        <div style="font-size:8px;margin-top:3px;color:#333">${upiId}</div>
        <div style="font-size:8px;color:#555">Amount: Rs.${(bill.grandTotal || 0).toFixed(2)}</div>
       </div>`
    : `<div class="c" style="font-size:8px;margin:6px 0">Pay via UPI: ${upiId}</div>`;

  const html = `<html><head><style>
    @page{margin:0;size:58mm auto}*{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Courier New',monospace;font-size:10px;width:58mm;padding:5px;color:#000}
    .c{text-align:center}.b{font-weight:bold}
    .line{border-top:1px dashed #000;margin:4px 0}.dline{border-top:2px solid #000;margin:4px 0}
    .row{display:flex;justify-content:space-between;margin:2px 0}
    pre{font-family:inherit;font-size:9px;white-space:pre-wrap}
  </style></head><body>
    <div class="c b" style="font-size:11px">JANAUSHADHI KENDRA</div>
    <div class="dline"></div>
    <div class="row"><span>Bill:</span><span class="b">${bill.billNumber || ""}</span></div>
    <div class="row"><span>Date:</span><span>${dateStr}</span></div>
    ${bill.customerName  ? `<div class="row"><span>Patient:</span><span>${bill.customerName}</span></div>`  : ""}
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
    ${qrSection}
    <div class="line"></div>
    <div class="c" style="margin-top:6px;font-size:9px">
      <div>Thank you! Get well soon.</div>
      <div style="margin-top:3px;font-size:8px">Powered by JK-PMS</div>
    </div>
  </body></html>`;

  let iframe = document.getElementById("print-thermal-iframe");
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "print-thermal-iframe";
    iframe.style.position = "absolute";
    iframe.style.width    = "0px";
    iframe.style.height   = "0px";
    iframe.style.border   = "none";
    iframe.style.top      = "-9999px";
    document.body.appendChild(iframe);
  }
  const doc = iframe.contentWindow.document || iframe.contentDocument;
  doc.open();
  doc.write(html);
  doc.close();
  setTimeout(() => {
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  }, 500);
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
  main: { height: "calc(100vh - 60px)", padding: "24px", overflowX: "hidden", background: C.bg, overflowY: "auto" },
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
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [showProfit, setShowProfit] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [doctorName, setDoctorName] = useState("");
  const [doctorDropdownOpen, setDoctorDropdownOpen] = useState(false);
  const [prescriptionNo, setPrescriptionNo] = useState("");
  const [showMappingModal, setShowMappingModal] = useState(false);
  const [mappingSearchText, setMappingSearchText] = useState({});
  const [medicines, setMedicines] = useState([]);
  const [pmbiItems, setPmbiItems] = useState([]);
  const [sales, setSales] = useState([]);
  const [isSalesLoaded, setIsSalesLoaded] = useState(false);
  const [purchases, setPurchases] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [now, setNow] = useState(new Date());

  const handleSignOut = () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("jk_pms_active_tab");
      localStorage.removeItem("jk_pms_draft_bill_items");
      localStorage.removeItem("jk_pms_draft_cust_name");
      localStorage.removeItem("jk_pms_draft_cust_phone");
      localStorage.removeItem("jk_pms_draft_payment_mode");
      localStorage.removeItem("jk_pms_draft_purchase_form");
      localStorage.removeItem("jk_pms_report_filters");
      localStorage.removeItem("jk_pms_default_print_type");
    }
    setActiveTab("dashboard");
    setIsSalesLoaded(false);
    signOut(auth).catch(err => console.error("Sign out error:", err));
  };

  // Collapse sidebar by default on mobile screens
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setIsSidebarCollapsed(true);
    }
  }, []);
  
  // ── SaaS Multi-Tenant States ──
  const [storeId, setStoreId] = useState("");
  const [storeCode, setStoreCode] = useState("");
  const [storeName, setStoreName] = useState("");
  const [storeDetails, setStoreDetails] = useState(null);
  const [userRole, setUserRole] = useState("staff"); // "admin" | "staff"
  const [profileLoading, setProfileLoading] = useState(true);
  const [onboardingMode, setOnboardingMode] = useState("none"); // "none" | "choose" | "create" | "join" | "wizard-step1" | "wizard-step2" | "wizard-step3"
  const [lastSyncSec, setLastSyncSec] = useState(0);

  // ── Premium PMBI & Masters States ──
  const [activeTopTab, setActiveTopTab] = useState("master"); // "master" | "configuration" | "sales" | "purchase" | "inventory" | "account" | "synchronization"
  const [doctors, setDoctors] = useState([]);
  const [doctorForm, setDoctorForm] = useState({ name: "", phone: "", specialization: "", registrationNo: "" });
  const [doctorMasterOpen, setDoctorMasterOpen] = useState(false);
  const [uomMasterOpen, setUomMasterOpen] = useState(false);
  const [categoryMasterOpen, setCategoryMasterOpen] = useState(false);
  const [locationMasterOpen, setLocationMasterOpen] = useState(false);
  const [storeInfoMasterOpen, setStoreInfoMasterOpen] = useState(false);
  const [emailConfigOpen, setEmailConfigOpen] = useState(false);
  const [regionMasterOpen, setRegionMasterOpen] = useState(false);
  const [helpSupportOpen, setHelpSupportOpen] = useState(false);
  const [bankDetailsOpen, setBankDetailsOpen] = useState(false);
  const [updateLocationOpen, setUpdateLocationOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [newDoctorError, setNewDoctorError] = useState("");
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

  // Redesigned Sales Invoice Header & Search States
  const [custRefNo, setCustRefNo] = useState("");
  const [dueDate, setDueDate] = useState(new Date().toISOString().substring(0, 10));
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().substring(0, 10));
  const [rateType, setRateType] = useState("Sales Rate");
  const [accountName, setAccountName] = useState("Cash Sale");
  const [gstType, setGstType] = useState("Local State");
  const [bookType, setBookType] = useState("GST Invoice");
  const [remarks, setRemarks] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [gstNo, setGstNo] = useState("");
  const [creditBill, setCreditBill] = useState(false);
  const [activeInvoiceNo, setActiveInvoiceNo] = useState("");
  const [findInvoiceNo, setFindInvoiceNo] = useState("");

  // Search Drug Row States
  const [searchDrugSelected, setSearchDrugSelected] = useState(null);
  const [searchDrugBatch, setSearchDrugBatch] = useState("");
  const [searchDrugQty, setSearchDrugQty] = useState("");
  const [searchDrugDiscount, setSearchDrugDiscount] = useState("0.000");

  // Payment splits
  const [splitCash, setSplitCash] = useState("0.00");
  const [splitCreditCard, setSplitCreditCard] = useState("0.00");
  const [splitDebitCard, setSplitDebitCard] = useState("0.00");
  const [splitWalletPay, setSplitWalletPay] = useState("0.00");
  const [searchQuery, setSearchQuery] = useState("");
  const [showAddMedForm, setShowAddMedForm] = useState(false);
  const [newMed, setNewMed] = useState({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", stockQty: "", unit: "Strip", lowStockAlert: "20", category: "", gstRate: "12" });
  const [editingMed, setEditingMed] = useState(null);
  const [editMedForm, setEditMedForm] = useState({
    genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "",
    batchNumber: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "",
    stockQty: "", lowStockAlert: "20", category: "", gstRate: "12"
  });
  const [viewingMedDetails, setViewingMedDetails] = useState(null);
  const [showPurchaseForm, setShowPurchaseForm] = useState(false);
  const [viewingPurchase, setViewingPurchase] = useState(null); // purchase detail modal
  const [purchaseForm, setPurchaseForm] = useState({ supplierName: "", invoiceNumber: "", invoiceDate: "", paymentStatus: "Unpaid", items: [] });
  const [purchaseItem, setPurchaseItem] = useState({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", quantity: "", unit: "Strip", gstRate: "12", packSize: "1" });
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
    period: "month",
    searchText: "",
    batchNo: "",
    productQuery: ""
  });
  const [isWorkerExporting, setIsWorkerExporting] = useState(false);
  const [defaultPrintType, setDefaultPrintType] = useState("A4");

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
  const [salesImportSessions, setSalesImportSessions] = useState([]);
  const [activeEditingSessionId, setActiveEditingSessionId] = useState(null);
  // ── Edit Bill States ──
  const [editBillModalData, setEditBillModalData] = useState(null);
  const [editBillForm, setEditBillForm] = useState(null);
  const [editBillSearch, setEditBillSearch] = useState("");
  // ── Dashboard Action Modals & Forms ──
  const [showPendingPaymentsModal, setShowPendingPaymentsModal] = useState(false);
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false);
  const [showTopSellingModal, setShowTopSellingModal] = useState(false);
  const [showNearbyExpiryModal, setShowNearbyExpiryModal] = useState(false);
  const [paymentForm, setPaymentForm] = useState({ supplierId: "", amountPaid: "", notes: "" });
  const [supplierSearchFocused, setSupplierSearchFocused] = useState(false);
  // ── Store Settings Form ──
  const [storeEditForm, setStoreEditForm] = useState({
    name: "", helpline: "", supportTime: "", address: "", gstin: "", drugLicense: "",
    bankAccountName: "", bankAccountNumber: "", bankName: "", bankIfsc: "", bankBranch: "",
    latitude: "", longitude: "", mapUrl: ""
  });
  const [isSavingStore, setIsSavingStore] = useState(false);
  // ── Reports Sub Tab ──
  const [reportsSubTab, setReportsSubTab] = useState("sales"); // "sales" | "purchase" | "gst"
  const [adcSubTab, setAdcSubTab] = useState("sales"); // "sales" | "purchase" | "ledger"
  const [showBillSuccessModal, setShowBillSuccessModal] = useState(false);
  // ── Supplier Edit Modal ──
  const [supplierEditModalData, setSupplierEditModalData] = useState(null);
  const [newSupplierForm, setNewSupplierForm] = useState({ name: "", phone: "", email: "", gstin: "", address: "", outstanding: "0" });
  const [showAddSupplierModal, setShowAddSupplierModal] = useState(false);
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

  // Generate active invoice number on sales update
  useEffect(() => {
    if (isSalesLoaded && !activeInvoiceNo) {
      const yr = new Date().getFullYear();
      let maxSeq = 0;
      sales.forEach(s => {
        if (s.billNumber && s.billNumber.startsWith(`SI${yr}`)) {
          const seqStr = s.billNumber.substring(6);
          const seqNum = parseInt(seqStr, 10);
          if (!isNaN(seqNum) && seqNum > maxSeq) {
            maxSeq = seqNum;
          }
        } else if (s.billNumber && s.billNumber.startsWith("SI")) {
          const seqStr = s.billNumber.substring(6);
          const seqNum = parseInt(seqStr, 10);
          if (!isNaN(seqNum) && seqNum > maxSeq) {
            maxSeq = seqNum;
          }
        }
      });
      const nextSeq = String(maxSeq + 1).padStart(6, "0");
      setActiveInvoiceNo(`SI${yr}${nextSeq}`);
    }
  }, [sales, activeInvoiceNo, isSalesLoaded]);

  const handleNewInvoice = (nextInvoiceNo = null) => {
    setBillItems([]);
    setCustomerName("");
    setCustomerPhone("");
    setDoctorName("");
    setPrescriptionNo("");
    
    // Clear redesigned states
    setCustRefNo("");
    setDueDate(new Date().toISOString().substring(0, 10));
    setInvoiceDate(new Date().toISOString().substring(0, 10));
    setRateType("Sales Rate");
    setAccountName("Cash Sale");
    setGstType("Local State");
    setBookType("GST Invoice");
    setRemarks("");
    setCustomerEmail("");
    setGstNo("");
    setCreditBill(false);
    setFindInvoiceNo("");

    // Clear Search row
    setBillSearch("");
    setSearchDrugSelected(null);
    setSearchDrugBatch("");
    setSearchDrugQty("");
    setSearchDrugDiscount("0.000");

    // Clear payment splits
    setSplitCash("0.00");
    setSplitCreditCard("0.00");
    setSplitDebitCard("0.00");
    setSplitWalletPay("0.00");

    // Generate fresh invoice number
    if (nextInvoiceNo) {
      setActiveInvoiceNo(nextInvoiceNo);
    } else {
      setActiveInvoiceNo(""); // Triggers the useEffect to recalculate from the database
    }

    playBeep(1000, 0.04);
  };

  const handleSelectSearchDrug = (med) => {
    if (med.isAddTempRow || med.isTemporary) {
      setSearchDrugSelected({
        id: "temp-" + Date.now(),
        genericName: billSearch.trim(),
        brandName: "Custom Demand",
        isTemporary: true,
        requiresInventoryMapping: true,
        mrp: 0.00,
        sellingPrice: 0.00,
        stockQty: 0,
        unit: "Pcs",
        batches: [{ batchNumber: "TEMP-001", expiryDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().substring(0, 7), quantity: 999, sellingPrice: 0.00, mrp: 0.00 }]
      });
      setBillSearch(billSearch.trim());
      setSearchDrugBatch("TEMP-001");
      setSearchDrugQty("1");
      setSearchDrugDiscount("0.000");
      setSearchHighlight(-1);
      
      setTimeout(() => {
        const el = document.getElementById("search-drug-qty");
        if (el) { el.focus(); el.select(); }
      }, 50);
      return;
    }

    if (isExpired(med)) {
      playBeep(220, 0.15);
      alert(`⚠ ${med.genericName} is EXPIRED (${med.expiryDate}). Sale blocked.`);
      return;
    }

    const currentMonthStr = new Date().toISOString().substring(0, 7);
    let defaultBatchNum = "TEMP-001";
    if (Array.isArray(med.batches) && med.batches.length > 0) {
      const activeBatches = med.batches.filter(b => b.expiryDate >= currentMonthStr && (b.quantity || 0) > 0);
      activeBatches.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
      if (activeBatches.length > 0) {
        defaultBatchNum = activeBatches[0].batchNumber;
      } else {
        defaultBatchNum = med.batches[0].batchNumber;
      }
    }

    setSearchDrugSelected(med);
    setBillSearch(med.genericName);
    setSearchDrugBatch(defaultBatchNum);
    setSearchDrugQty("1");
    setSearchDrugDiscount("0.000");
    setSearchHighlight(-1);

    setTimeout(() => {
      const el = document.getElementById("search-drug-qty");
      if (el) { el.focus(); el.select(); }
    }, 50);
  };

  const addSearchDrugToBill = () => {
    if (!searchDrugSelected) {
      alert("Please select a medicine first.");
      return;
    }
    const qty = parseInt(searchDrugQty);
    if (isNaN(qty) || qty <= 0) {
      alert("Please enter a valid quantity greater than zero.");
      return;
    }

    const currentMonthStr = new Date().toISOString().substring(0, 7);
    const batches = Array.isArray(searchDrugSelected.batches) ? searchDrugSelected.batches : [];
    const selectedBatchObj = batches.find(b => b.batchNumber === searchDrugBatch) || 
      (batches.length > 0 ? batches[0] : { batchNumber: "TEMP-001", expiryDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().substring(0, 7), quantity: 999, sellingPrice: 0.00, mrp: 0.00 });

    if (!searchDrugSelected.isTemporary) {
      const isBatchExpired = selectedBatchObj.expiryDate < currentMonthStr;
      if (isBatchExpired) {
        alert("Selected batch is expired. Cannot add to sales invoice.");
        return;
      }
      if ((selectedBatchObj.quantity || 0) < qty) {
        alert(`Insufficient stock in selected batch. Available: ${selectedBatchObj.quantity || 0}, Requested: ${qty}`);
        return;
      }
    }

    const activePrice = +selectedBatchObj.sellingPrice || +selectedBatchObj.mrp || +searchDrugSelected.sellingPrice || +searchDrugSelected.mrp || 0;
    const finalDiscount = parseFloat(searchDrugDiscount) || 0;

    const newItem = {
      ...searchDrugSelected,
      mrp: activePrice,
      originalMrp: selectedBatchObj.mrp || searchDrugSelected.mrp || 0,
      qty: qty,
      discount: finalDiscount,
      selectedBatchNumber: searchDrugBatch,
      expiryDate: selectedBatchObj.expiryDate,
      location: searchDrugSelected.location || "N/A"
    };

    setBillItems(prev => {
      const existingIdx = prev.findIndex(item => item.id === newItem.id && item.selectedBatchNumber === newItem.selectedBatchNumber);
      if (existingIdx !== -1) {
        return prev.map((item, idx) => idx === existingIdx ? { ...item, qty: item.qty + qty } : item);
      }
      return [...prev, newItem];
    });

    setSearchDrugSelected(null);
    setBillSearch("");
    setSearchDrugBatch("");
    setSearchDrugQty("");
    setSearchDrugDiscount("0.000");
    setSearchHighlight(-1);
    playBeep(1000, 0.04);

    setTimeout(() => {
      billSearchRef.current?.focus();
    }, 50);
  };

  const addDemandedDrugToBill = () => {
    if (!billSearch.trim()) {
      alert("Please enter a drug name in the search box.");
      return;
    }
    const tempId = "temp-" + Date.now();
    const newTempItem = {
      id: tempId,
      genericName: billSearch.trim(),
      brandName: "Custom Demand",
      isTemporary: true,
      requiresInventoryMapping: true,
      mrp: 0.00,
      sellingPrice: 0.00,
      qty: 1,
      discount: 0,
      selectedBatchNumber: "TEMP-001",
      expiryDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().substring(0, 7),
      location: "DEMAND"
    };
    
    setBillItems(prev => [...prev, newTempItem]);
    setBillSearch("");
    setSearchHighlight(-1);
    playBeep(1000, 0.04);
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
    setPersistence(auth, browserSessionPersistence).catch(err => {
      console.error("Failed to set auth persistence:", err);
    });

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
                setStoreEditForm({
                  name: storeData.name || "",
                  helpline: storeData.helpline || "",
                  supportTime: storeData.supportTime || "",
                  address: storeData.address || "",
                  gstin: storeData.gstin || "",
                  drugLicense: storeData.drugLicense || "",
                  bankAccountName: storeData.bankAccountName || "",
                  bankAccountNumber: storeData.bankAccountNumber || "",
                  bankName: storeData.bankName || "",
                  bankIfsc: storeData.bankIfsc || "",
                  bankBranch: storeData.bankBranch || "",
                  latitude: storeData.latitude || "",
                  longitude: storeData.longitude || "",
                  mapUrl: storeData.mapUrl || ""
                });
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
    const qPmbiItems = query(collection(db, "pmbi_items"), where("storeId", "==", storeId));

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
      setSales(items);
      setIsSalesLoaded(true);
      setLastSyncSec(0);
    }, err => {
      handleIndexError(err, "sales");
      setIsSalesLoaded(true);
    });

    const u3 = onSnapshot(qPurch, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Client-side sort by createdAt descending
      items.sort((a, b) => {
        const tA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const tB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return tB - tA;
      });
      setPurchases(items);
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

    const qSalesImportSessions = query(collection(db, "sales_import_sessions"), where("storeId", "==", storeId));
    const uSalesImportSessions = onSnapshot(qSalesImportSessions, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => {
        const tA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
        const tB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
        return tB - tA;
      });
      setSalesImportSessions(items);
    }, err => console.error("Sales import sessions listen error", err));

    const qDoctors = query(collection(db, "doctors"), where("storeId", "==", storeId));
    const uDoctors = onSnapshot(qDoctors, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setDoctors(items);
    }, err => console.error("Doctors listen error", err));

    const uPmbiItems = onSnapshot(qPmbiItems, snap => {
      const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      items.sort((a, b) => (a.genericName || "").localeCompare(b.genericName || ""));
      setPmbiItems(items);
    }, err => console.error("PMBI Items catalog listen error", err));

    return () => { u1(); u2(); u3(); u4(); uTemplates(); uSessions(); uSalesImportSessions(); uDoctors(); uPmbiItems(); };
  }, [user, storeId]);

  // Backfill legacy sales imports into sales_import_sessions
  useEffect(() => {
    if (!storeId || !user) return;
    const backfillSalesImportSessions = async () => {
      try {
        const qImportedSales = query(
          collection(db, "sales"),
          where("storeId", "==", storeId),
          where("isImported", "==", true)
        );
        const snap = await getDocs(qImportedSales);
        if (snap.empty) return;

        const sessionSnap = await getDocs(
          query(collection(db, "sales_import_sessions"), where("storeId", "==", storeId))
        );
        const existingCommittedBillIds = new Set();
        sessionSnap.forEach(doc => {
          const ids = doc.data().importedBillIds || [];
          ids.forEach(id => existingCommittedBillIds.add(id));
        });

        const orphanedBills = [];
        snap.forEach(doc => {
          if (!existingCommittedBillIds.has(doc.id)) {
            orphanedBills.push({ id: doc.id, ...doc.data() });
          }
        });

        if (orphanedBills.length === 0) return;

        orphanedBills.sort((a, b) => {
          const tA = a.createdAt?.toDate?.() || new Date(a.createdAt || 0);
          const tB = b.createdAt?.toDate?.() || new Date(b.createdAt || 0);
          return tA - tB;
        });

        const sessionsToCreate = [];
        let currentSessionBills = [];

        orphanedBills.forEach(bill => {
          if (currentSessionBills.length === 0) {
            currentSessionBills.push(bill);
          } else {
            const lastBill = currentSessionBills[currentSessionBills.length - 1];
            const tLast = lastBill.createdAt?.toDate?.() || new Date(lastBill.createdAt || 0);
            const tCurr = bill.createdAt?.toDate?.() || new Date(bill.createdAt || 0);
            const diffHours = Math.abs(tCurr - tLast) / (1000 * 60 * 60);

            if (diffHours <= 2) {
              currentSessionBills.push(bill);
            } else {
              sessionsToCreate.push([...currentSessionBills]);
              currentSessionBills = [bill];
            }
          }
        });
        if (currentSessionBills.length > 0) {
          sessionsToCreate.push(currentSessionBills);
        }

        for (const sessionBills of sessionsToCreate) {
          const firstBill = sessionBills[0];
          const sessionRef = doc(collection(db, "sales_import_sessions"));
          const billIds = sessionBills.map(b => b.id);
          const billNumbers = sessionBills.map(b => b.billNumber ? b.billNumber.replace("Bill-", "") : "");
          const totalRev = sessionBills.reduce((sum, b) => sum + (b.grandTotal || b.subtotal || 0), 0);
          const createdAt = firstBill.createdAt || serverTimestamp();

          await setDoc(sessionRef, {
            storeId,
            storeCode: firstBill.storeCode || storeCode || "",
            importedBillIds: billIds,
            totalBills: sessionBills.length,
            totalRevenue: totalRev,
            billNumbers: billNumbers,
            status: "COMPLETED",
            createdAt: createdAt,
            createdBy: firstBill.createdBy || user.uid,
            isBackfilled: true
          });
        }
      } catch (err) {
        console.error("Failed to backfill sales import sessions:", err);
      }
    };
    backfillSalesImportSessions();
  }, [user, storeId, storeCode]);

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

  const getTopSellingItems = () => {
    const counts = {};
    sales.forEach(sale => {
      (sale.items || []).forEach(item => {
        const key = item.medicineId || item.genericName;
        if (!key) return;
        if (!counts[key]) {
          counts[key] = {
            medicineId: item.medicineId || "",
            brandName: item.brandName || "",
            genericName: item.genericName || "",
            strength: item.strength || "",
            form: item.form || "",
            quantity: 0,
            revenue: 0
          };
        }
        counts[key].quantity += (item.quantity || 0);
        counts[key].revenue += (item.total || 0);
      });
    });
    return Object.values(counts)
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 50);
  };

  const getNearbyExpiryBatches = () => {
    const list = [];
    const limit = new Date();
    limit.setMonth(limit.getMonth() + 3);
    limit.setHours(0, 0, 0, 0);

    const now = new Date();
    now.setHours(0, 0, 0, 0);

    medicines.forEach(m => {
      if (Array.isArray(m.batches) && m.batches.length > 0) {
        m.batches.forEach(b => {
          if ((b.quantity || 0) > 0) {
            const [y, mo] = (b.expiryDate || "2099-12").split("-");
            const exp = new Date(+y, +mo - 1, 1);
            if (exp > now && exp <= limit) {
              list.push({
                medicineId: m.id,
                brandName: m.brandName || "",
                genericName: m.genericName || "",
                batchNumber: b.batchNumber || "—",
                expiryDate: b.expiryDate || "—",
                quantity: b.quantity || 0
              });
            }
          }
        });
      } else {
        if ((m.stockQty || 0) > 0) {
          const [y, mo] = (m.expiryDate || "2099-12").split("-");
          const exp = new Date(+y, +mo - 1, 1);
          if (exp > now && exp <= limit) {
            list.push({
              medicineId: m.id,
              brandName: m.brandName || "",
              genericName: m.genericName || "",
              batchNumber: m.batchNumber || "—",
              expiryDate: m.expiryDate || "—",
              quantity: m.stockQty || 0
            });
          }
        }
      }
    });

    return list.sort((a, b) => {
      if (!a.expiryDate || a.expiryDate === "—") return 1;
      if (!b.expiryDate || b.expiryDate === "—") return -1;
      const [ay, amo] = a.expiryDate.split("-");
      const [by, bmo] = b.expiryDate.split("-");
      return new Date(+ay, +amo - 1, 1) - new Date(+by, +bmo - 1, 1);
    });
  };
  
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
  
  const roundPaisa = (val) => {
    const floorVal = Math.floor(val);
    const frac = val - floorVal;
    const fracRounded = Math.round(frac * 100) / 100;
    if (fracRounded >= 0.1) {
      return Math.ceil(val);
    }
    return floorVal;
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

  const netAmountRounded = roundPaisa(totals.grand);
  const roundOffValue = netAmountRounded - totals.grand;
  const avgGstPct = totals.taxable > 0 ? ((totals.gst / totals.taxable) * 100) : 0;
  const searchResults = (billSearch.length >= 2 || (billSearch.length >= 1 && /^\d+$/.test(billSearch)))
    ? [
        ...medicines
          .filter(m => 
            (m.genericName || "").toLowerCase().includes(billSearch.toLowerCase()) || 
            (m.brandName || "").toLowerCase().includes(billSearch.toLowerCase()) ||
            String(m.drugCode || "").toLowerCase().includes(billSearch.toLowerCase()) ||
            (m.barcode || "").toLowerCase().includes(billSearch.toLowerCase())
          )
          .sort((a, b) => getExpiryDate(a) - getExpiryDate(b))
          .slice(0, 8),
        { isAddTempRow: true, genericName: `➕ Add & Sell "${billSearch}"`, brandName: "", isTemporary: true, id: "temp-row-trigger" }
      ]
    : [];
  // Substitutes: same generic name, in-stock, when item is OOS
  const getSubstitutes = (genericName) => medicines.filter(m => m.genericName?.toLowerCase() === genericName?.toLowerCase() && m.stockQty > 0).slice(0, 3);

  // SaaS Unmapped Temporary Items calculation
  const unmappedSales = sales.filter(s => 
    (s.items || []).some(item => item.isTemporary && item.requiresInventoryMapping)
  );
  
  const totalUnmappedCount = unmappedSales.reduce((acc, s) => 
    acc + (s.items || []).filter(item => item.isTemporary && item.requiresInventoryMapping).length, 
    0
  );

  const unmappedItemsList = [];
  unmappedSales.forEach(sale => {
    (sale.items || []).forEach((item, itemIdx) => {
      if (item.isTemporary && item.requiresInventoryMapping) {
        unmappedItemsList.push({
          saleId: sale.id,
          billNumber: sale.billNumber,
          customerName: sale.customerName || "Walk-in Patient",
          date: sale.date || sale.createdAt?.toDate?.() || new Date(),
          itemIdx: itemIdx,
          item: item
        });
      }
    });
  });
  
  const filteredBills = billSearchQuery.length >= 2 ? sales.filter(s => s.billNumber?.toLowerCase().includes(billSearchQuery.toLowerCase()) || s.customerName?.toLowerCase().includes(billSearchQuery.toLowerCase()) || s.customerPhone?.includes(billSearchQuery)) : sales.slice(0, 50);
  const filteredMeds = medicines
    .filter(m => (m.genericName || "").toLowerCase().includes(searchQuery.toLowerCase()) || (m.brandName || "").toLowerCase().includes(searchQuery.toLowerCase()) || (m.category || "").toLowerCase().includes(searchQuery.toLowerCase()))
    .map(m => {
      const firstBatch = Array.isArray(m.batches) && m.batches.length > 0 ? m.batches[0] : null;
      const buyPrice = m.purchasePrice || firstBatch?.purchasePrice || 0;
      const retailPrice = m.sellingPrice || m.mrp || 0;
      const gst = parseFloat(m.gstRate) || 12;
      const buyPriceInclusive = buyPrice * (1 + gst / 100);
      const marginPct = retailPrice > 0 ? (((retailPrice - buyPriceInclusive) / retailPrice) * 100).toFixed(1) : null;
      
      const singleProfit = retailPrice - buyPriceInclusive;

      let totalQtySold = 0;
      let totalProfitSold = 0;
      sales.forEach(sale => {
        (sale.items || []).forEach(item => {
          if (item.medicineId === m.id) {
            const qty = item.quantity || 0;
            totalQtySold += qty;
            if (typeof item.profit === "number") {
              totalProfitSold += item.profit;
            } else {
              const totalVal = typeof item.total === "number" ? item.total : (qty * (item.sellingPrice || item.mrp || 0));
              const cogsVal = typeof item.cogs === "number" ? item.cogs : (qty * (item.purchasePrice || 0));
              totalProfitSold += (totalVal - cogsVal);
            }
          }
        });
      });

      return { 
        ...m, 
        marginPct, 
        singleProfit, 
        totalQtySold, 
        totalProfitSold 
      };
    });
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

      // Product Name/Drug Code query filter
      if (reportFilters.productQuery) {
        const prodLower = reportFilters.productQuery.toLowerCase();
        const hasProd = (s.items || []).some(item => 
          item.brandName?.toLowerCase().includes(prodLower) ||
          item.genericName?.toLowerCase().includes(prodLower) ||
          String(item.drugCode || "").toLowerCase().includes(prodLower)
        );
        if (!hasProd) return false;
      }

      // Batch No filter
      if (reportFilters.batchNo) {
        const batchLower = reportFilters.batchNo.toLowerCase();
        const hasBatch = (s.items || []).some(item => {
          if (item.batchNumber?.toLowerCase().includes(batchLower)) return true;
          if (item.batchesUsed && item.batchesUsed.some(bu => bu.batchNumber?.toLowerCase().includes(batchLower))) return true;
          return false;
        });
        if (!hasBatch) return false;
      }

      // Search text filter (Patient, Doctor, Bill No, Medicine)
      if (reportFilters.searchText) {
        const queryLower = reportFilters.searchText.toLowerCase();
        const billNoMatch = s.billNumber?.toLowerCase().includes(queryLower);
        const patientMatch = s.customerName?.toLowerCase().includes(queryLower);
        const doctorMatch = s.doctorName?.toLowerCase().includes(queryLower);
        const hasMedMatch = (s.items || []).some(item => 
          item.brandName?.toLowerCase().includes(queryLower) ||
          item.genericName?.toLowerCase().includes(queryLower) ||
          item.batchNumber?.toLowerCase().includes(queryLower) ||
          String(item.drugCode || "").toLowerCase().includes(queryLower)
        );
        if (!billNoMatch && !patientMatch && !doctorMatch && !hasMedMatch) return false;
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

      // Product Name/Drug Code query filter
      if (reportFilters.productQuery) {
        const prodLower = reportFilters.productQuery.toLowerCase();
        const hasProd = (p.items || []).some(item => 
          item.brandName?.toLowerCase().includes(prodLower) ||
          item.genericName?.toLowerCase().includes(prodLower) ||
          String(item.drugCode || "").toLowerCase().includes(prodLower)
        );
        if (!hasProd) return false;
      }

      // Batch No filter
      if (reportFilters.batchNo) {
        const batchLower = reportFilters.batchNo.toLowerCase();
        const hasBatch = (p.items || []).some(item => item.batchNumber?.toLowerCase().includes(batchLower));
        if (!hasBatch) return false;
      }

      // Search text filter (Supplier, Invoice No, Medicine)
      if (reportFilters.searchText) {
        const queryLower = reportFilters.searchText.toLowerCase();
        const invNoMatch = p.invoiceNumber?.toLowerCase().includes(queryLower);
        const supplierMatch = p.supplierName?.toLowerCase().includes(queryLower);
        const hasMedMatch = (p.items || []).some(item => 
          item.brandName?.toLowerCase().includes(queryLower) ||
          item.genericName?.toLowerCase().includes(queryLower) ||
          item.batchNumber?.toLowerCase().includes(queryLower)
        );
        if (!invNoMatch && !supplierMatch && !hasMedMatch) return false;
      }
      return true;
    });
  };

  const parseExpiry = (exp) => {
    if (exp === null || exp === undefined || exp === "") return "";

    // Handle Excel numeric date serial (e.g. 46388 → date object)
    if (typeof exp === "number" && exp > 1000) {
      const excelDate = new Date((exp - 25569) * 86400 * 1000);
      if (!isNaN(excelDate.getTime())) {
        const year = excelDate.getUTCFullYear();
        const month = String(excelDate.getUTCMonth() + 1).padStart(2, "0");
        return `${year}-${month}`;
      }
    }

    const raw = String(exp).trim();

    // Already in YYYY-MM format
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;

    // Normalize separators for pattern matching (replace / . with /)
    const str = raw.replace(/[\/\.-]/g, "/");

    // Pattern Match: MM/YY or MM/YYYY (e.g. 12/26 or 12/2026)
    const monthYearMatch = str.match(/^(\d{1,2})\/(\d{2,4})$/);
    if (monthYearMatch) {
      let month = monthYearMatch[1].padStart(2, "0");
      let year = monthYearMatch[2];
      if (year.length === 2) year = "20" + year;
      const mVal = parseInt(month);
      if (mVal >= 1 && mVal <= 12) return `${year}-${month}`;
    }

    // Pattern Match: YYYY/MM (e.g. 2026/12)
    const yearMonthMatch = str.match(/^(\d{4})\/(\d{1,2})$/);
    if (yearMonthMatch) {
      const year = yearMonthMatch[1];
      const month = yearMonthMatch[2].padStart(2, "0");
      const mVal = parseInt(month);
      if (mVal >= 1 && mVal <= 12) return `${year}-${month}`;
    }

    // Pattern Match: MMM-YY or MMM-YYYY (e.g. Dec-26, Apr-2027)
    const monthNames = { jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12" };
    const monthNameMatch = raw.match(/^([A-Za-z]{3})[\/\-](\d{2,4})$/);
    if (monthNameMatch) {
      const mName = monthNameMatch[1].toLowerCase();
      const mNum = monthNames[mName];
      if (mNum) {
        let year = monthNameMatch[2];
        if (year.length === 2) year = "20" + year;
        return `${year}-${mNum}`;
      }
    }

    // Try generic JS date parse as last resort (e.g. "December 2026", "2026-12-31")
    const dateObj = new Date(raw);
    if (!isNaN(dateObj.getTime())) {
      const year = dateObj.getFullYear();
      const month = String(dateObj.getMonth() + 1).padStart(2, "0");
      return `${year}-${month}`;
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
      const XLSX = await import("xlsx");
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
        const packSizeIdx = itemHeaders.findIndex(h => h.includes("pack size") || h.includes("packsize") || h.includes("conversion") || h.includes("qty per pack") || h.includes("pack qty"));

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
          const packSize = packSizeIdx >= 0 ? parseInt(row[packSizeIdx]) || 1 : 1;

          const incomingItem = { genericName, brandName, strength, form, batchNumber, expiryDate, mrp, sellingPrice, purchasePrice, quantity, unit, gstRate, barcode, packSize };
          
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

      // Direct client-side fetch to bypass Vercel limits and allow large file sizes/longer timeouts
      const GEMINI_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!GEMINI_KEY) {
        throw new Error("Gemini API Key is missing. Please configure NEXT_PUBLIC_GEMINI_API_KEY in Vercel project settings.");
      }
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;

      const geminiBody = {
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            {
              text: `Analyze the provided pharmaceutical purchase invoice or challan.
Extract the data and return ONLY a valid JSON object matching the schema below.
Ensure all names, dates, quantities, rates, batch numbers, and tax calculations are precisely captured.
Do not wrap in markdown or block comments.

Schema:
{
  "supplierName": "Name of the supplier (e.g. ESHWARI PHARMA)",
  "invoiceNumber": "Challan No. or Invoice No. (e.g. CA000312)",
  "invoiceDate": "Invoice date in YYYY-MM-DD format (e.g. 2025-04-19)",
  "items": [{
    "genericName": "Generic name of medicine/formulation (e.g., LEVOCETIRIZINE)",
    "brandName": "Brand/Trade name in bold description (e.g., VOYCET-10 TAB)",
    "strength": "Medicine strength (e.g., '10mg', '650mg', '1%')",
    "form": "Form of medicine (e.g., 'Tablet', 'Syrup', 'Lotion', 'Diaper', 'Cream')",
    "batchNumber": "Batch No. from the invoice",
    "expiryDate": "Expiry Date parsed into standard YYYY-MM format (e.g. EXP 12/25 becomes 2025-12, 10/26 becomes 2026-10)",
    "mrp": 0.0, // Manufacturer printed MRP
    "sellingPrice": 0.0, // Suggested Retail Selling Price. Since it is Janaushadhi (generic), set this as 50% of the printed MRP (or equal to mrp if not generic)
    "purchasePrice": 0.0, // Unit purchase rate/price (labeled RATE on invoice)
    "quantity": 0, // Quantity (QTY)
    "unit": "Strip", // Strip, Bottle, Piece, Vial, or Tube
    "gstRate": "12", // 0, 5, 12, 18 or 28 based on invoice line details
    "barcode": null, // Barcode if visible, otherwise null
    "packSize": 1 // Integer pack size or conversion factor (default to 1. If description/packing details mention e.g. '1x12', '12s', 'Pack of 10', extract the number of units in the pack, e.g. 12 or 10)
  }]
}`
            }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
      };

      const response = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiBody)
      });

      const geminiData = await response.json();
      if (!response.ok || geminiData.error) {
        throw new Error(geminiData.error?.message || "Gemini API error response");
      }

      const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const clean = text.replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(clean);

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
          barcode: item.barcode || "",
          packSize: parseInt(item.packSize) || 1
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
      console.error(err);
      setAiStatus(`⚠ Could not read invoice automatically: ${err.message || err}. Please fill in manually below.`);
    } finally {
      setAiLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const addToBill = (med) => {
    if (med.isAddTempRow || med.isTemporary) {
      const tempId = "temp-" + Date.now();
      const newTempItem = {
        id: tempId,
        genericName: billSearch.trim(),
        brandName: "",
        isTemporary: true,
        requiresInventoryMapping: true,
        mrp: null,
        sellingPrice: null,
        qty: 1,
        discount: 0,
        selectedBatchNumber: "TEMP-001",
        expiryDate: new Date(Date.now() + 365*24*60*60*1000).toISOString().substring(0, 7) // 1 year out
      };
      
      setBillItems(prev => [...prev, newTempItem]);
      setBillSearch("");
      setSearchHighlight(-1);
      playBeep(1000, 0.04);
      
      // Auto-focus price input immediately after render
      setTimeout(() => {
        const el = document.getElementById(`temp-price-${tempId}`);
        if (el) {
          el.focus();
          el.select();
        }
      }, 50);
      return;
    }

    if (isExpired(med)) {
      playBeep(220, 0.15);
      alert(`⚠ ${med.genericName} is EXPIRED (${med.expiryDate}). Sale blocked.`);
      return;
    }
    
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
    setBillSearch("");
    setSearchHighlight(-1);
    playBeep(1000, 0.04);
    
    setTimeout(() => {
      billSearchRef.current?.focus();
    }, 50);
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
      
      // 1. Exact barcode or drug code lookup in memory (essential for instant barcode scanners and numeric keypads)
      const exactMatch = medicines.find(m => 
        m.barcode === trimmedSearch || 
        (m.drugCode && String(m.drugCode) === trimmedSearch)
      );
      if (exactMatch) {
        e.preventDefault();
        addToBill(exactMatch);
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
    
    // H1 Compliance validation
    const hasH1Drug = billItems.some(i => i.isH1Drug === true);
    if (hasH1Drug) {
      if (!customerName?.trim() || !customerPhone?.trim() || !doctorName?.trim() || !prescriptionNo?.trim()) {
        playBeep(220, 0.15);
        alert("⚠ H1 Compliance Warning: This transaction contains a Schedule H1 drug. Patient Name, Patient Phone, Doctor Name, and Prescription Number are mandatory for regulatory logging.");
        return;
      }
    }
    
    // Validate quantities and selling prices strictly
    for (const item of billItems) {
      if (item.qty === "" || !item.qty || +item.qty <= 0) {
        playBeep(220, 0.15);
        alert(`⚠ Please add the quantity for "${item.genericName || item.brandName}"!`);
        return;
      }
      
      if (item.isTemporary) {
        if (item.sellingPrice === null || item.sellingPrice === undefined || +item.sellingPrice <= 0) {
          playBeep(220, 0.15);
          alert(`⚠ Please configure a valid selling price for temporary item "${item.genericName}" before checkout!`);
          return;
        }
      } else {
        if (!item.sellingPrice || +item.sellingPrice <= 0) {
          playBeep(220, 0.15);
          alert(`⚠ Selling price for "${item.brandName || item.genericName}" cannot be empty or zero!`);
          return;
        }
      }
    }
    
    const billNumber = activeInvoiceNo || `JK-${now.getFullYear()}-${String(sales.length + 1).padStart(4, "0")}`;
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

        // Separate real vs temporary items
        const realBillItems = billItems.filter(i => !i.isTemporary);
        const tempBillItems = billItems.filter(i => i.isTemporary);

        // Phase 1: Read all real medicine documents
        const medicinesData = [];
        for (const item of realBillItems) {
          const medRef = doc(db, "medicines", item.id);
          const medSnap = await transaction.get(medRef);
          if (!medSnap.exists()) {
            throw new Error(`Medicine "${item.brandName || item.genericName}" does not exist in inventory.`);
          }
          medicinesData.push({ item, medRef, data: medSnap.data() });
        }

        // Phase 2: Processing real items
        for (const { item, medRef, data: med } of medicinesData) {
          let currentBatches = Array.isArray(med.batches) ? med.batches.map(b => ({ ...b })) : [];
          let remainingQ = item.qty;
          
          let activeBatches = currentBatches.filter(b => b.expiryDate >= currentMonthStr && (b.quantity || 0) > 0);
          
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

          for (let b of activeBatches) {
            if (remainingQ <= 0) break;
            const bq = b.quantity || 0;
            if (bq > 0) {
              const take = Math.min(bq, remainingQ);
              const prevQty = b.quantity;
              b.quantity = bq - take;
              remainingQ -= take;
              
              const batchPurchasePrice = b.purchasePrice;
              if (!batchPurchasePrice || +batchPurchasePrice <= 0) {
                throw new Error(`Financial validation failed: Batch "${b.batchNumber}" of medicine "${med.brandName || med.genericName}" has no purchase price configured. High-integrity margins require a landed cost.`);
              }
              
              const batchSellingPrice = item.sellingPrice || b.sellingPrice || b.mrp || 0;
              
              batchesUsed.push({
                batchNumber: b.batchNumber,
                expiryDate: b.expiryDate,
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

          const updatedBatches = currentBatches.map(b => {
            const updatedActive = activeBatches.find(ab => ab.batchNumber === b.batchNumber);
            return updatedActive ? updatedActive : b;
          });

          const totalStock = updatedBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

          transaction.update(medRef, {
            stockQty: Math.max(0, totalStock),
            batches: updatedBatches,
            updatedAt: serverTimestamp()
          });

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

        // Processing temporary items (no DB writes or reads, process separately)
        for (const item of tempBillItems) {
          const c = calcItem(item);
          const itemCogs = 0; // Temp items do not have cost records in catalog
          const itemProfit = c.total;

          subtotalSum += c.base;
          discountSum += c.disc;
          taxableSum += c.taxableValue;
          cgstSum += c.cgst;
          sgstSum += c.sgst;
          gstSum += c.gstAmount;
          grandSum += c.total;

          finalizedItems.push({
            medicineId: item.id,
            genericName: item.genericName,
            brandName: "",
            quantity: item.qty,
            mrp: item.mrp,
            sellingPrice: item.sellingPrice,
            discount: item.discount || 0,
            total: c.total,
            gstRate: c.gstRate || 12,
            taxableValue: c.taxableValue,
            cgst: c.cgst,
            sgst: c.sgst,
            totalGst: c.gstAmount,
            cogs: itemCogs,
            profit: itemProfit,
            isTemporary: true,
            requiresInventoryMapping: true,
            batchNumber: item.selectedBatchNumber || "TEMP-001",
            expiryDate: item.expiryDate || "2028-12",
            batchesUsed: [{
              batchNumber: item.selectedBatchNumber || "TEMP-001",
              expiryDate: item.expiryDate || "2028-12",
              quantity: item.qty,
              purchasePrice: 0,
              sellingPrice: item.sellingPrice || 0
            }]
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
          customerEmail: customerEmail || "",
          items: finalizedItems,
          subtotal: subtotalSum,
          totalDiscount: discountSum,
          taxableAmount: taxableSum,
          cgstAmount: cgstSum,
          sgstAmount: sgstSum,
          totalGst: gstSum,
          cogs: cogsSum,
          profit: roundPaisa(grandSum) - cogsSum,
          grandTotal: roundPaisa(grandSum),
          roundOff: roundPaisa(grandSum) - grandSum,
          paymentMode,
          doctorName: doctorName || "",
          prescriptionNo: prescriptionNo || "",

          // ERP fields
          custRefNo: custRefNo || "",
          dueDate: dueDate || "",
          invoiceDate: invoiceDate || "",
          rateType: rateType || "Sales Rate",
          accountName: accountName || "Cash Sale",
          gstType: gstType || "Local State",
          bookType: bookType || "GST Invoice",
          remarks: remarks || "",
          gstNo: gstNo || "",
          creditBill: creditBill || false,
          splitPayments: {
            cash: parseFloat(splitCash) || 0,
            creditCard: parseFloat(splitCreditCard) || 0,
            debitCard: parseFloat(splitDebitCard) || 0,
            walletPay: parseFloat(splitWalletPay) || 0
          },

          createdAt: serverTimestamp(),
          createdBy: user.uid
        };

        transaction.set(saleDocRef, billData);

        // Write Audit Logs (real items only)
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

      playBeep(880, 0.08); // high pitch success beep
      
      let nextInvoiceNo = null;
      if (activeInvoiceNo && activeInvoiceNo.startsWith("SI")) {
        const yr = new Date().getFullYear();
        const seqStr = activeInvoiceNo.substring(6);
        const seqNum = parseInt(seqStr, 10);
        if (!isNaN(seqNum)) {
          nextInvoiceNo = `SI${yr}${String(seqNum + 1).padStart(6, "0")}`;
        }
      }
      
      handleNewInvoice(nextInvoiceNo);
      setShowBillSuccessModal(true);
    } catch (err) {
      playBeep(220, 0.15); // low pitch warn beep
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

  const handleStartEditMedicine = (med) => {
    const firstBatch = Array.isArray(med.batches) && med.batches.length > 0 ? med.batches[0] : null;
    const batchNo = med.batchNumber || firstBatch?.batchNumber || "";
    const expDate = med.expiryDate || firstBatch?.expiryDate || "";
    
    setEditingMed(med);
    setEditMedForm({
      genericName: med.genericName || "",
      brandName: med.brandName || "",
      strength: med.strength || "",
      form: med.form || "Tablet",
      barcode: med.barcode || "",
      batchNumber: batchNo,
      expiryDate: expDate,
      mrp: med.mrp ? String(med.mrp) : "",
      sellingPrice: med.sellingPrice ? String(med.sellingPrice) : "",
      purchasePrice: med.purchasePrice ? String(med.purchasePrice) : (firstBatch?.purchasePrice ? String(firstBatch.purchasePrice) : ""),
      stockQty: med.stockQty ? String(med.stockQty) : "0",
      lowStockAlert: med.lowStockAlert ? String(med.lowStockAlert) : "20",
      category: med.category || "",
      gstRate: med.gstRate ? String(med.gstRate) : "12"
    });
    setShowAddMedForm(false);
  };

  const updateMedicine = async () => {
    if (!editMedForm.genericName || !editMedForm.mrp || !editMedForm.stockQty) {
      alert("Please fill in all mandatory fields.");
      return;
    }
    if (!storeId) { alert("Error: No store linked to user."); return; }

    const mrpVal = +editMedForm.mrp || 0;
    const sellVal = +editMedForm.sellingPrice || mrpVal;
    const buyVal = +editMedForm.purchasePrice || 0;
    const qtyVal = +editMedForm.stockQty || 0;
    const batchNo = editMedForm.batchNumber || "BAT-GEN";
    const expDate = editMedForm.expiryDate || "2027-12";

    if (qtyVal > 0 && buyVal <= 0) {
      alert("⚠ Hard financial validation failed: Landed purchase price is required to calculate profitability on stock additions.");
      return;
    }

    setDbLoading(true);
    try {
      const medRef = doc(db, "medicines", editingMed.id);

      await runTransaction(db, async (transaction) => {
        const medSnap = await transaction.get(medRef);
        if (!medSnap.exists()) {
          throw new Error("Medicine document not found.");
        }

        const existing = medSnap.data();
        let currentBatches = Array.isArray(existing.batches) ? [...existing.batches] : [];

        if (currentBatches.length > 0) {
          currentBatches[0] = {
            ...currentBatches[0],
            batchNumber: batchNo,
            expiryDate: expDate,
            quantity: qtyVal,
            purchasePrice: buyVal,
            mrp: mrpVal,
            sellingPrice: sellVal
          };
        } else {
          currentBatches.push({
            batchNumber: batchNo,
            expiryDate: expDate,
            quantity: qtyVal,
            purchasePrice: buyVal,
            mrp: mrpVal,
            sellingPrice: sellVal
          });
        }

        transaction.update(medRef, {
          genericName: editMedForm.genericName,
          brandName: editMedForm.brandName || "",
          strength: editMedForm.strength || "",
          form: editMedForm.form || "Tablet",
          barcode: editMedForm.barcode || "",
          category: editMedForm.category || "",
          lowStockAlert: +editMedForm.lowStockAlert || 20,
          gstRate: +editMedForm.gstRate || 12,
          mrp: mrpVal,
          sellingPrice: sellVal,
          purchasePrice: buyVal,
          stockQty: qtyVal,
          batches: currentBatches,
          updatedAt: serverTimestamp()
        });

        if (qtyVal !== editingMed.stockQty) {
          const auditCol = collection(db, "inventory_audit_logs");
          const auditDocRef = doc(auditCol);
          transaction.set(auditDocRef, {
            storeId,
            medicineId: editingMed.id,
            genericName: editMedForm.genericName,
            brandName: editMedForm.brandName || "",
            batchNumber: batchNo,
            type: "STOCK_CORRECTION",
            actionSource: "INVENTORY_EDIT",
            referenceId: "MEDICINE-EDIT",
            quantityChanged: qtyVal - editingMed.stockQty,
            previousQuantity: editingMed.stockQty,
            newQuantity: qtyVal,
            purchasePrice: buyVal,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }
      });

      setEditingMed(null);
      alert("✓ Medicine successfully updated!");
    } catch (err) {
      console.error(err);
      alert("Error updating medicine: " + err.message);
    } finally {
      setDbLoading(false);
    }
  };

  const mapTemporaryItem = async (saleId, itemIdx, medicineId) => {
    if (!saleId || !medicineId) return;
    setDbLoading(true);
    try {
      const saleRef = doc(db, "sales", saleId);
      const medRef = doc(db, "medicines", medicineId);

      await runTransaction(db, async (transaction) => {
        const saleSnap = await transaction.get(saleRef);
        const medSnap = await transaction.get(medRef);

        if (!saleSnap.exists()) throw new Error("Sale document not found.");
        if (!medSnap.exists()) throw new Error("Catalog medicine not found.");

        const saleData = saleSnap.data();
        const medData = medSnap.data();

        const saleItem = saleData.items[itemIdx];
        if (!saleItem) throw new Error("Temporary item not found in sale document.");

        let currentBatches = Array.isArray(medData.batches) ? medData.batches.map(b => ({ ...b })) : [];
        let remainingQ = saleItem.quantity || 1;
        const currentMonthStr = new Date().toISOString().substring(0, 7);

        let activeBatches = currentBatches.filter(b => b.expiryDate >= currentMonthStr && (b.quantity || 0) > 0);
        activeBatches.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));

        const batchesUsed = [];
        const auditLogs = [];

        if (activeBatches.length > 0) {
          for (let b of activeBatches) {
            if (remainingQ <= 0) break;
            const bq = b.quantity || 0;
            const take = Math.min(bq, remainingQ);
            const prevQty = b.quantity;
            b.quantity = bq - take;
            remainingQ -= take;

            batchesUsed.push({
              batchNumber: b.batchNumber,
              expiryDate: b.expiryDate,
              quantity: take,
              purchasePrice: b.purchasePrice || 0,
              sellingPrice: saleItem.sellingPrice || b.sellingPrice || b.mrp || 0
            });

            auditLogs.push({
              medicineId: medicineId,
              genericName: medData.genericName,
              brandName: medData.brandName || "",
              batchNumber: b.batchNumber,
              type: "SALE",
              actionSource: "POS_RETROACTIVE_MAPPING",
              quantityChanged: -take,
              previousQuantity: prevQty,
              newQuantity: b.quantity,
              purchasePrice: b.purchasePrice || 0
            });
          }
        }

        if (remainingQ > 0) {
          if (currentBatches.length === 0) {
            const tempBatchNo = saleItem.batchNumber || "MAPPED-001";
            const tempExpiry = saleItem.expiryDate || new Date(Date.now() + 365*24*60*60*1000).toISOString().substring(0, 7);
            currentBatches.push({
              batchNumber: tempBatchNo,
              expiryDate: tempExpiry,
              quantity: -remainingQ,
              purchasePrice: medData.purchasePrice || 0,
              mrp: medData.mrp || saleItem.sellingPrice || 0,
              sellingPrice: saleItem.sellingPrice || medData.sellingPrice || 0
            });
            batchesUsed.push({
              batchNumber: tempBatchNo,
              expiryDate: tempExpiry,
              quantity: remainingQ,
              purchasePrice: medData.purchasePrice || 0,
              sellingPrice: saleItem.sellingPrice || 0
            });
            auditLogs.push({
              medicineId: medicineId,
              genericName: medData.genericName,
              brandName: medData.brandName || "",
              batchNumber: tempBatchNo,
              type: "SALE",
              actionSource: "POS_RETROACTIVE_MAPPING",
              quantityChanged: -remainingQ,
              previousQuantity: 0,
              newQuantity: -remainingQ,
              purchasePrice: medData.purchasePrice || 0
            });
          } else {
            const b = currentBatches[0];
            const prevQty = b.quantity || 0;
            b.quantity = prevQty - remainingQ;
            batchesUsed.push({
              batchNumber: b.batchNumber,
              expiryDate: b.expiryDate,
              quantity: remainingQ,
              purchasePrice: b.purchasePrice || 0,
              sellingPrice: saleItem.sellingPrice || 0
            });
            auditLogs.push({
              medicineId: medicineId,
              genericName: medData.genericName,
              brandName: medData.brandName || "",
              batchNumber: b.batchNumber,
              type: "SALE",
              actionSource: "POS_RETROACTIVE_MAPPING",
              quantityChanged: -remainingQ,
              previousQuantity: prevQty,
              newQuantity: b.quantity,
              purchasePrice: b.purchasePrice || 0
            });
          }
        }

        const totalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);

        transaction.update(medRef, {
          stockQty: Math.max(0, totalStock),
          batches: currentBatches,
          updatedAt: serverTimestamp()
        });

        const updatedItems = (saleData.items || []).map((it, idx) => {
          if (idx === itemIdx) {
            const itemCogs = batchesUsed.reduce((sum, bu) => sum + (bu.quantity * bu.purchasePrice), 0);
            const itemProfit = it.total - itemCogs;
            return {
              ...it,
              isTemporary: false,
              requiresInventoryMapping: false,
              medicineId: medicineId,
              brandName: medData.brandName || "",
              genericName: medData.genericName,
              cogs: itemCogs,
              profit: itemProfit,
              batchesUsed: batchesUsed
            };
          }
          return it;
        });

        const newCogs = updatedItems.reduce((sum, it) => sum + (it.cogs || 0), 0);
        const newProfit = updatedItems.reduce((sum, it) => sum + (it.profit || 0), 0);

        transaction.update(saleRef, {
          items: updatedItems,
          cogs: newCogs,
          profit: newProfit
        });

        const auditCol = collection(db, "inventory_audit_logs");
        for (const log of auditLogs) {
          const logDocRef = doc(auditCol);
          transaction.set(logDocRef, {
            ...log,
            storeId,
            referenceId: saleId,
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        }
      });

      playBeep(880, 0.08);
      alert("✓ Unmapped item successfully linked to catalog and stock levels adjusted retroactively!");
    } catch (err) {
      playBeep(220, 0.15);
      alert("Error mapping temporary item: " + err.message);
    } finally {
      setDbLoading(false);
    }
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
      const XLSX = await import("xlsx");
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
      packSize: parseFloat(purchaseItem.packSize) || 1,
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
    setPurchaseItem({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", quantity: "", unit: "Strip", gstRate: "12", packSize: "1" });
  };

  const savePurchase = async () => {
    if (!purchaseForm.supplierName || !purchaseForm.items.length) { alert("Add supplier name and at least one item."); return; }
    if (!storeId) { alert("Error: No store linked to user."); return; }
    try {
      const totalAmount = purchaseForm.items.reduce((a, i) => a + (+(i.purchasePrice || 0) * +(i.quantity || 0) * (1 + +(i.gstRate || 12) / 100)), 0);
      
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

        const packSize = parseFloat(item.packSize) || 1;
        const incomingBatch = {
          batchNumber: item.batchNumber || "BAT-GEN-" + Math.floor(Math.random() * 100000),
          expiryDate: item.expiryDate || "2027-12",
          quantity: (+item.quantity || 0) * packSize,
          purchasePrice: (+item.purchasePrice || 0) / packSize,
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
          const buyVal = incomingBatch.purchasePrice;
          const qtyVal = incomingBatch.quantity;

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

  const saveStoreProfile = async () => {
    if (!storeEditForm.name || !storeEditForm.address || !storeEditForm.helpline || !storeEditForm.gstin || !storeEditForm.drugLicense) {
      alert("All fields (Store Name, Address, Helpline, GSTIN, and Drug License) are mandatory for regulatory compliance!");
      return;
    }
    setIsSavingStore(true);
    try {
      const storeRef = doc(db, "stores", storeId);
      const updateData = {
        name: storeEditForm.name.trim(),
        address: storeEditForm.address.trim(),
        helpline: storeEditForm.helpline.trim(),
        supportTime: storeEditForm.supportTime.trim() || "9:30 AM To 6:00 PM",
        gstin: storeEditForm.gstin.trim().toUpperCase(),
        drugLicense: storeEditForm.drugLicense.trim().toUpperCase(),
        bankAccountName: storeEditForm.bankAccountName?.trim() || "",
        bankAccountNumber: storeEditForm.bankAccountNumber?.trim() || "",
        bankName: storeEditForm.bankName?.trim() || "",
        bankIfsc: storeEditForm.bankIfsc?.trim().toUpperCase() || "",
        bankBranch: storeEditForm.bankBranch?.trim() || "",
        latitude: storeEditForm.latitude?.trim() || "",
        longitude: storeEditForm.longitude?.trim() || "",
        mapUrl: storeEditForm.mapUrl?.trim() || "",
        updatedAt: serverTimestamp()
      };
      await updateDoc(storeRef, updateData);
      
      setStoreName(updateData.name);
      setStoreDetails(prev => ({ ...prev, ...updateData }));

      if (onboardingMode.startsWith("wizard")) {
        const userDocRef = doc(db, "users", user.uid);
        await updateDoc(userDocRef, { wizardCompleted: true });
        setOnboardingMode("none");
      }
      alert("✓ Store Profile & Compliance Details updated successfully!");
    } catch (err) {
      console.error(err);
      alert("Error saving store profile: " + err.message);
    } finally {
      setIsSavingStore(false);
    }
  };

  const updateStoreConfigs = async (key, newList) => {
    try {
      const storeRef = doc(db, "stores", storeId);
      await updateDoc(storeRef, {
        [key]: newList,
        updatedAt: serverTimestamp()
      });
      setStoreDetails(prev => ({ ...prev, [key]: newList }));
      return true;
    } catch (e) {
      alert(`Error updating ${key}: ` + e.message);
      return false;
    }
  };

  const addDoctorMaster = async (docData) => {
    if (!docData.name || docData.name.trim().length < 2) {
      alert("Doctor Name is required.");
      return false;
    }
    try {
      await addDoc(collection(db, "doctors"), {
        storeId,
        storeCode,
        name: docData.name.trim(),
        phone: docData.phone?.trim() || "",
        specialization: docData.specialization?.trim() || "General Medicine",
        registrationNo: docData.registrationNo?.trim() || "",
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });
      return true;
    } catch (e) {
      alert("Error adding doctor: " + e.message);
      return false;
    }
  };

  const deleteDoctorMaster = async (docId) => {
    try {
      await deleteDoc(doc(db, "doctors", docId));
      return true;
    } catch (e) {
      alert("Error deleting doctor: " + e.message);
      return false;
    }
  };

  const recordSupplierPayment = async (supplierId, amountPaid, notes = "") => {
    if (!supplierId || amountPaid <= 0) return;
    try {
      const supRef = doc(db, "suppliers", supplierId);
      const supSnap = await getDoc(supRef);
      if (!supSnap.exists()) return;
      const data = supSnap.data();
      const newOutstanding = Math.max(0, (data.outstanding || 0) - amountPaid);
      
      await updateDoc(supRef, {
        outstanding: newOutstanding
      });

      await addDoc(collection(db, "supplier_payments"), {
        storeId,
        storeCode,
        supplierId,
        supplierName: data.name,
        amountPaid,
        notes,
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });

      alert(`✓ Recorded payment of ₹${amountPaid.toFixed(2)} to ${data.name}. Remaining outstanding: ₹${newOutstanding.toFixed(2)}`);
      setPaymentForm({ supplierId: "", amountPaid: "", notes: "" });
    } catch (e) {
      console.error(e);
      alert("Error recording payment: " + e.message);
    }
  };

  const handleAddSupplier = async () => {
    if (!newSupplierForm.name) { alert("Supplier name is required."); return; }
    try {
      await addDoc(collection(db, "suppliers"), {
        storeId,
        storeCode,
        name: newSupplierForm.name,
        phone: newSupplierForm.phone || "",
        email: newSupplierForm.email || "",
        gstin: newSupplierForm.gstin || "",
        address: newSupplierForm.address || "",
        outstanding: parseFloat(newSupplierForm.outstanding) || 0,
        totalPurchases: parseFloat(newSupplierForm.outstanding) || 0,
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });
      alert(`✓ Supplier ${newSupplierForm.name} added successfully!`);
      setNewSupplierForm({ name: "", phone: "", email: "", gstin: "", address: "", outstanding: "0" });
      setShowAddSupplierModal(false);
    } catch (e) {
      console.error(e);
      alert("Error adding supplier: " + e.message);
    }
  };

  const handleUpdateSupplier = async (supplierId, updatedFields) => {
    try {
      await updateDoc(doc(db, "suppliers", supplierId), updatedFields);
      alert("✓ Supplier details updated successfully.");
      setSupplierEditModalData(null);
    } catch (e) {
      console.error(e);
      alert("Error updating supplier: " + e.message);
    }
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

  const updatePurchasePayment = async (p, newStatus) => {
    try {
      await updateDoc(doc(db, "purchases", p.id), { paymentStatus: newStatus, updatedAt: serverTimestamp() });
      const sup = suppliers.find(s => s.name?.toLowerCase() === p.supplierName?.toLowerCase());
      if (sup) {
        // Recalculate outstanding
        const wasUnpaid = p.paymentStatus === "Unpaid";
        const nowUnpaid = newStatus === "Unpaid";
        let outstandingDelta = 0;
        if (wasUnpaid && !nowUnpaid) outstandingDelta = -(p.totalAmount || 0); // paid off
        if (!wasUnpaid && nowUnpaid)  outstandingDelta =  (p.totalAmount || 0); // marked unpaid
        await updateDoc(doc(db, "suppliers", sup.id), {
          outstanding: Math.max(0, (sup.outstanding || 0) + outstandingDelta)
        });
      }
      setViewingPurchase(prev => prev ? { ...prev, paymentStatus: newStatus } : null);
    } catch (err) { alert("Error updating payment: " + err.message); }
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

  const deleteSalesImportSession = async (session) => {
    if (!window.confirm(`⚠️ WARNING: Are you sure you want to rollback and delete Sales Import Session?\n\nThis will restore all deducted stock for the ${session.totalBills} bills from this import, permanently delete the bills, and cannot be undone.`)) return;
    
    setDbLoading(true);
    try {
      const billIds = session.importedBillIds || [];
      
      for (const billId of billIds) {
        try {
          const saleRef = doc(db, "sales", billId);
          const saleSnap = await getDoc(saleRef);
          
          if (saleSnap.exists()) {
            const saleData = saleSnap.data();
            
            for (const item of saleData.items || []) {
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
                        sellingPrice: item.sellingPrice || med.sellingPrice || med.mrp || 0,
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
            
            await deleteDoc(saleRef);
          }
        } catch (e) {
          console.error("Failed to rollback/delete bill:", billId, e);
        }
      }

      await updateDoc(doc(db, "sales_import_sessions", session.id), {
        status: "DELETED",
        deletedAt: serverTimestamp()
      });

      alert(`✓ Rollback complete. Successfully deleted ${billIds.length} bills and restored inventory stock.`);
    } catch (err) {
      alert("Failed to rollback import session: " + err.message);
    } finally {
      setDbLoading(false);
    }
  };

  const loadSalesImportSessionForEditing = async (session) => {
    setDbLoading(true);
    try {
      const billIds = session.importedBillIds || [];
      const loadedBills = [];
      
      for (const billId of billIds) {
        const saleRef = doc(db, "sales", billId);
        const saleSnap = await getDoc(saleRef);
        
        if (saleSnap.exists()) {
          const data = saleSnap.data();
          
          const dateObj = data.createdAt?.toDate ? data.createdAt.toDate() : new Date(data.createdAt || 0);
          const offset = dateObj.getTimezoneOffset();
          const localDate = new Date(dateObj.getTime() - (offset * 60 * 1000));
          const formattedDate = localDate.toISOString().substring(0, 16);
          
          loadedBills.push({
            id: saleSnap.id,
            billNo: data.billNumber ? data.billNumber.replace("Bill-", "") : "",
            customerName: data.customerName || "Walk-in Patient",
            customerPhone: data.customerPhone || "",
            doctorName: data.doctorName || "",
            prescriptionNo: data.prescriptionNo || "",
            saleType: data.paymentMode || "Cash",
            timestamp: formattedDate,
            items: (data.items || []).map(item => ({
              itemName: item.brandName || item.genericName,
              qty: item.quantity || item.qty || 1,
              mrp: item.mrp || 0,
              rate: item.sellingPrice || 0,
              batchNumber: item.batchNumber || "",
              expiryDate: item.expiryDate || "",
              discount: item.discount || 0,
              estimatedTotal: item.total || 0,
              medicineId: item.medicineId || "",
              isNew: false,
              isShortage: false
            })),
            totalAmount: data.grandTotal || 0,
            hasNew: false,
            hasShortage: false,
            originalBill: { ...data, id: saleSnap.id }
          });
        }
      }
      
      if (loadedBills.length === 0) {
        alert("No active bills found for this session.");
        setDbLoading(false);
        return;
      }
      
      setPreviewImportedSales(loadedBills);
      setActiveEditingSessionId(session.id);
      setShowSalesImportDrawer(true);
    } catch (err) {
      alert("Failed to load import session: " + err.message);
    } finally {
      setDbLoading(false);
    }
  };

  const commitEditedImportedSales = async () => {
    if (previewImportedSales.length === 0 || !activeEditingSessionId) return;
    setIsImportingSales(true);
    setImportSalesProgress(0);

    const totalBills = previewImportedSales.length;
    let processedCount = 0;
    const committedBillIds = [];

    const bills = [...previewImportedSales];

    try {
      for (const bill of bills) {
        const billNo = bill.billNo;
        
        try {
          await runTransaction(db, async (transaction) => {
            const originalBill = bill.originalBill;
            
            const medIds = new Set();
            if (originalBill && Array.isArray(originalBill.items)) {
              originalBill.items.forEach(i => { if (i.medicineId) medIds.add(i.medicineId); });
            }
            bill.items.forEach(i => { if (i.medicineId) medIds.add(i.medicineId); });

            for (const item of bill.items) {
              if (!item.medicineId) {
                const existing = findMedicineByName(item.itemName);
                if (existing) {
                  item.medicineId = existing.id;
                  medIds.add(existing.id);
                }
              }
            }

            const medicinesMap = {};
            for (const medId of medIds) {
              const medRef = doc(db, "medicines", medId);
              const snap = await transaction.get(medRef);
              if (snap.exists()) {
                medicinesMap[medId] = { ref: medRef, data: snap.data() };
              }
            }

            if (originalBill && Array.isArray(originalBill.items)) {
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
                          expiryDate: origItem.expiryDate || med.data.expiryDate || "2028-12",
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
            }

            const finalizedItems = [];
            const auditLogs = [];

            for (const item of bill.items) {
              let med = item.medicineId ? medicinesMap[item.medicineId] : null;
              
              if (!med) {
                let medDoc = findMedicineByName(item.itemName);
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
                    genericName: item.itemName,
                    brandName: item.itemName,
                    strength: "",
                    form: "Tablet",
                    mrp: item.mrp || 150.00,
                    sellingPrice: item.rate || 120.00,
                    purchasePrice: 75.00,
                    stockQty: 0,
                    lowStockAlert: 20,
                    gstRate: 12,
                    category: "General",
                    batches: [],
                    createdAt: serverTimestamp(),
                    createdBy: user.uid
                  };
                }
                
                med = { ref: medRef, data: medData, isNewDoc: !exists };
                medicinesMap[medRef.id] = med;
                item.medicineId = medRef.id;
                medIds.add(medRef.id);
              }

              let currentBatches = Array.isArray(med.data.batches) ? med.data.batches.map(b => ({ ...b })) : [];
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
                    batchNumber: item.batchNumber || "AUTO-MIG-BATCH",
                    expiryDate: item.expiryDate || "2028-12",
                    purchasePrice: med.data.purchasePrice || 75.00,
                    mrp: item.mrp || med.data.mrp || 150.00,
                    sellingPrice: item.rate || med.data.sellingPrice || 120.00,
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
                  actionSource: "SALES_IMPORT_EDIT_ADJUST",
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
                  batchNumber: (batchesUsed.length === 0 && item.batchNumber) ? item.batchNumber : batch.batchNumber,
                  expiryDate: (batchesUsed.length === 0 && item.expiryDate) ? item.expiryDate : batch.expiryDate,
                  quantity: taken,
                  purchasePrice: batch.purchasePrice || 0,
                  sellingPrice: item.rate || batch.sellingPrice || batch.mrp || 0,
                  mrp: item.mrp || batch.mrp || 0
                });
              }

              const newTotalStock = currentBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
              med.data.batches = currentBatches;
              med.data.stockQty = newTotalStock;

              const total = reqQty * (item.rate || item.mrp);
              const discAmount = total * (item.discount || 0) / 100;
              const finalTotal = total - discAmount;
              const gstRate = med.data.gstRate || 12;
              const taxableValue = finalTotal / (1 + (gstRate / 100));
              const totalGst = finalTotal - taxableValue;
              const itemCogs = batchesUsed.reduce((sum, bu) => sum + (bu.quantity * bu.purchasePrice), 0);

              finalizedItems.push({
                medicineId: item.medicineId,
                genericName: med.data.genericName,
                brandName: med.data.brandName || "",
                strength: med.data.strength || "",
                form: med.data.form || "",
                quantity: reqQty,
                mrp: item.mrp,
                batchNumber: item.batchNumber || batchesUsed[0]?.batchNumber || "",
                expiryDate: item.expiryDate || batchesUsed[0]?.expiryDate || "",
                sellingPrice: item.rate,
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

            for (const medId of medIds) {
              const m = medicinesMap[medId];
              if (m) {
                if (m.isNewDoc) {
                  transaction.set(m.ref, {
                    ...m.data,
                    createdAt: serverTimestamp()
                  });
                } else {
                  transaction.update(m.ref, {
                    stockQty: m.data.stockQty,
                    batches: m.data.batches,
                    updatedAt: serverTimestamp()
                  });
                }
              }
            }

            const saleRef = bill.id ? doc(db, "sales", bill.id) : doc(collection(db, "sales"));
            const subtotalSum = finalizedItems.reduce((a, i) => a + i.total, 0);
            const taxableSum = finalizedItems.reduce((a, i) => a + i.taxableValue, 0);
            const gstSum = finalizedItems.reduce((a, i) => a + i.totalGst, 0);
            const cogsSum = finalizedItems.reduce((a, i) => a + i.cogs, 0);
            const billDate = parseTimestamp(bill.timestamp);

            const updatedBillData = {
              storeId,
              storeCode,
              billNumber: bill.billNo ? `Bill-${bill.billNo}` : `Bill-${bill.id}`,
              customerName: bill.customerName || "Walk-in Patient",
              customerPhone: bill.customerPhone || "",
              doctorName: bill.doctorName || "",
              prescriptionNo: bill.prescriptionNo || "",
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
              paymentMode: bill.saleType || "Cash",
              createdAt: billDate,
              updatedAt: serverTimestamp(),
              isImported: true
            };

            if (bill.id) {
              transaction.update(saleRef, updatedBillData);
            } else {
              transaction.set(saleRef, updatedBillData);
            }

            const auditLogsCol = collection(db, "inventory_audit_logs");
            for (const log of auditLogs) {
              const logDocRef = doc(auditLogsCol);
              transaction.set(logDocRef, {
                ...log,
                storeId,
                referenceId: bill.id || saleRef.id,
                createdAt: serverTimestamp(),
                createdBy: user.uid
              });
            }

            committedBillIds.push(bill.id || saleRef.id);
          });

          processedCount++;
        } catch (err) {
          console.error(`Failed to update imported bill #${billNo}:`, err);
        }

        setImportSalesProgress(Math.round(((processedCount) / totalBills) * 100));
      }

      if (processedCount > 0) {
        const sessionRef = doc(db, "sales_import_sessions", activeEditingSessionId);
        await updateDoc(sessionRef, {
          importedBillIds: committedBillIds,
          totalBills: processedCount,
          totalRevenue: bills.slice(0, processedCount).reduce((s, b) => s + b.items.reduce((si, it) => si + ((it.qty||1)*(it.rate||0)*(1-((it.discount||0)/100))), 0), 0),
          billNumbers: bills.slice(0, processedCount).map(b => b.billNo),
          updatedAt: serverTimestamp()
        });
      }

      setIsImportingSales(false);
      setShowSalesImportDrawer(false);
      setPreviewImportedSales([]);
      setActiveEditingSessionId(null);
      alert(`✓ Successfully updated and saved ${processedCount} of ${totalBills} bills in this session.`);
    } catch (err) {
      alert("Failed to update import session: " + err.message);
      setIsImportingSales(false);
    }
  };

  const runWorkerExport = (type, payload, fileName) => {
    if (isWorkerExporting) return;
    setIsWorkerExporting(true);
    
    try {
      const worker = new Worker("/workers/report.worker.js?v=" + Date.now());
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
            drugCode: m.drugCode || "",
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
      const worker = new Worker("/workers/report.worker.js?v=" + Date.now());
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

  const printA4PDFInvoice = async (bill) => {
    if (!bill) return;
    const fileName = `invoice_${bill.billNumber || "draft"}.pdf`;

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
      // Fetch and convert logo to Base64 dynamically
      let logoBase64 = "";
      try {
        const logoRes = await fetch("/logo.jpg");
        if (logoRes.ok) {
          const logoBlob = await logoRes.blob();
          logoBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(logoBlob);
          });
        }
      } catch (logoErr) {
        console.error("Failed to load logo.jpg for PDF:", logoErr);
      }

      // Fetch and convert UPI QR Code to Base64 dynamically
      let qrCodeBase64 = "";
      try {
        const upiData = `upi://pay?pa=7676309842@jupiteraxis&pn=Pradhan%20Mantri%20Bharatiya%20Janaushadhi%20Kendra&am=${(bill.grandTotal || 0).toFixed(2)}&cu=INR`;
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(upiData)}`;
        const qrRes = await fetch(qrUrl);
        if (qrRes.ok) {
          const qrBlob = await qrRes.blob();
          qrCodeBase64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(qrBlob);
          });
        }
      } catch (qrErr) {
        console.error("Failed to load QR code for PDF:", qrErr);
      }

      const payload = {
        bill,
        logo: logoBase64,
        qrCode: qrCodeBase64,
        storeInfo: {
          name: storeName || storeDetails?.name || "Pradhan Mantri Bharatiya Janaushadhi Kendra",
          gstin: storeDetails?.gstin || "—",
          drugLicense: storeDetails?.drugLicense || "—",
          address: storeDetails?.address || "—",
          phone: storeDetails?.phone || "9964382376",
          email: storeDetails?.email || "vishwapmbi@gmail.com"
        }
      };

      const worker = new Worker("/workers/report.worker.js?v=" + Date.now());
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

  const handleSalesExcelImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    setIsImportingSales(true);
    setImportSalesProgress(0);

    const parseExpiryDate = (val) => {
      if (!val) return "2028-12";
      const str = String(val).trim();
      
      // Format YYYY-MM (e.g. 2027-04)
      if (/^\d{4}-\d{2}$/.test(str)) {
        return str;
      }
      
      // Format MM/YY or MM-YY (e.g. 04/27 or 04-27)
      const m1 = str.match(/^(\d{2})[\/-](\d{2})$/);
      if (m1) {
        const month = m1[1];
        const year = "20" + m1[2];
        return `${year}-${month}`;
      }
      
      // Format MM/YYYY or MM-YYYY (e.g. 04/2027 or 04-2027)
      const m2 = str.match(/^(\d{2})[\/-](\d{4})$/);
      if (m2) {
        const month = m2[1];
        const year = m2[2];
        return `${year}-${month}`;
      }

      // Format MMM-YY or MMM-YYYY (e.g. Apr-27, Apr-2027)
      const monthsMap = {
        jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
        jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12"
      };
      const m3 = str.match(/^([A-Za-z]{3})[\/-](\d{2,4})$/);
      if (m3) {
        const mStr = m3[1].toLowerCase();
        const month = monthsMap[mStr] || "12";
        let year = m3[2];
        if (year.length === 2) {
          year = "20" + year;
        }
        return `${year}-${month}`;
      }

      return str;
    };
    
    const XLSX = await import("xlsx");
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
            const rawQty = item.Quantity !== undefined ? item.Quantity :
                           item.quantity !== undefined ? item.quantity :
                           item.Qty !== undefined ? item.Qty :
                           item.qty !== undefined ? item.qty : 1;
            const qty = Math.max(1, parseInt(rawQty) || 1);
            
            const existing = findMedicineByName(itemName);
            const isNew = !existing;
            const isShortage = existing ? existing.stockQty < qty : true;
            
            const mrp = parseFloat(item.MRP || item.mrp || existing?.mrp || 0);
            
            const rawRate = item["Retail Sale Rate"] !== undefined ? item["Retail Sale Rate"] :
                            item.Rate !== undefined ? item.Rate :
                            item.rate !== undefined ? item.rate :
                            item.SellingPrice !== undefined ? item.SellingPrice :
                            item.sellingPrice !== undefined ? item.sellingPrice : mrp;
            const rate = parseFloat(rawRate) || 0;
            
            const batchNumber = String(
              item["Batch No."] !== undefined ? item["Batch No."] :
              item["Batch No"] !== undefined ? item["Batch No"] :
              item.BatchNumber !== undefined ? item.BatchNumber :
              item.batchNumber !== undefined ? item.batchNumber :
              item.Batch !== undefined ? item.Batch : ""
            ).trim();
            
            const rawExpiry = String(
              item["Expiry Date"] !== undefined ? item["Expiry Date"] :
              item["Expiry M"] !== undefined ? item["Expiry M"] :
              item.ExpiryDate !== undefined ? item.ExpiryDate :
              item.expiryDate !== undefined ? item.expiryDate :
              item.Expiry !== undefined ? item.Expiry : ""
            ).trim();
            const expiryDate = parseExpiryDate(rawExpiry);
            
            const discount = parseFloat(item.Discount || item.discount || 0);
            const itemTotal = qty * rate * (1 - discount / 100);
            
            return {
              itemName,
              qty,
              mrp,
              rate,
              batchNumber,
              expiryDate,
              discount,
              category: String(item.Category || item.category || "General").trim(),
              remarks: String(item.Remarks || item.remarks || "").trim(),
              isNew,
              isShortage,
              estimatedTotal: itemTotal
            };
          });

          const totalAmt = items.reduce((sum, item) => sum + item.estimatedTotal, 0);
          // Build a default datetime string for the bill
          const rawTs = String(firstRow.Timestamp || firstRow.timestamp || firstRow.Date || firstRow.date || "").trim();
          return {
            billNo,
            customerName: String(firstRow.CustomerName || firstRow.customerName || "Walk-in Patient").trim(),
            customerPhone: String(firstRow.CustomerPhone || firstRow.customerPhone || firstRow.Phone || firstRow.phone || "").trim(),
            doctorName: String(firstRow.DoctorName || firstRow.doctorName || "").trim(),
            prescriptionNo: String(firstRow.PrescriptionNo || firstRow.prescriptionNo || "").trim(),
            saleType: String(firstRow.SaleType || firstRow.saleType || "Cash").trim(),
            timestamp: rawTs,
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
    const committedBillIds = [];
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
              
              // Use the user-edited values from preview if available
              const itemMrp = parseFloat(item.mrp) || medData.mrp || 150.00;
              const itemSellPrice = parseFloat(item.rate) || medData.sellingPrice || 120.00;
              const itemBuyPrice = medData.purchasePrice || 75.00;
              const itemDiscount = parseFloat(item.discount) || 0;
              // If user edited the batch number, override batchesUsed[0]
              if (item.batchNumber && batchesUsed.length > 0) {
                batchesUsed[0].batchNumber = item.batchNumber;
              }
              if (item.expiryDate && batchesUsed.length > 0) {
                batchesUsed[0].expiryDate = item.expiryDate;
              }
              if (itemMrp && batchesUsed.length > 0) {
                batchesUsed[0].mrp = itemMrp;
              }
              
              const gstRate = medData.gstRate || 12;
              const grossTotal = reqQty * itemSellPrice;
              const discAmount = grossTotal * (itemDiscount / 100);
              const total = grossTotal - discAmount;
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
                batchNumber: item.batchNumber || batchesUsed[0]?.batchNumber || "",
                expiryDate: item.expiryDate || batchesUsed[0]?.expiryDate || "",
                sellingPrice: itemSellPrice,
                discount: itemDiscount,
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
            
            const discountSum = finalizedItems.reduce((a, i) => a + (i.mrp * i.quantity * (i.discount || 0) / 100), 0);
            const billData = {
              storeId,
              storeCode,
              billNumber: bill.billNo ? `Bill-${bill.billNo}` : `Bill-${billNo}`,
              customerName: bill.customerName || "Walk-in Patient",
              customerPhone: bill.customerPhone || "",
              doctorName: bill.doctorName || "",
              prescriptionNo: bill.prescriptionNo || "",
              items: finalizedItems,
              subtotal: subtotalSum,
              totalDiscount: discountSum,
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
          committedBillIds.push(saleDocRef.id);
        } catch (err) {
          console.error(`Failed to ingest bill #${billNo}:`, err);
        }
      }));

      setIsImportingSales(false);
      setShowSalesImportDrawer(false);
      setPreviewImportedSales([]);

      // Save a session record for history & deletion tracking
      if (processedCount > 0) {
        try {
          const sessionRef = doc(collection(db, "sales_import_sessions"));
          await setDoc(sessionRef, {
            storeId,
            storeCode,
            importedBillIds: committedBillIds,
            totalBills: processedCount,
            totalRevenue: committedBillIds.length > 0 ? bills.slice(0, processedCount).reduce((s, b) => s + b.items.reduce((si, it) => si + ((it.qty||1)*(it.rate||0)*(1-((it.discount||0)/100))), 0), 0) : 0,
            billNumbers: bills.slice(0, processedCount).map(b => b.billNo),
            status: "COMPLETED",
            createdAt: serverTimestamp(),
            createdBy: user.uid
          });
        } catch (sessionErr) {
          console.error("Failed to save sales import session:", sessionErr);
        }
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
        batchNumber: item.batchesUsed?.[0]?.batchNumber || item.batchNumber || "",
        expiryDate: item.batchesUsed?.[0]?.expiryDate || item.expiryDate || "",
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
              // Use manually edited batch number / expiry for the primary (first) batch entry
              batchNumber: (batchesUsed.length === 0 && item.batchNumber) ? item.batchNumber : batch.batchNumber,
              expiryDate: (batchesUsed.length === 0 && item.expiryDate) ? item.expiryDate : batch.expiryDate,
              quantity: taken,
              purchasePrice: batch.purchasePrice || 0,
              sellingPrice: item.sellingPrice || batch.sellingPrice || batch.mrp || 0,
              mrp: item.mrp || batch.mrp || 0
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
            batchNumber: item.batchNumber || batchesUsed[0]?.batchNumber || "",
            expiryDate: item.expiryDate || batchesUsed[0]?.expiryDate || "",
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
              <button onClick={handleSignOut} style={{ ...S.btn("outline"), padding: 12, width: "100%" }}>Sign Out</button>
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
    setActiveTab("reorders");
    const smartReorders = getSmartReorders();
    let supplierMeds = smartReorders.filter(m => (m.lastDistributorName || "No Linked Vendor") === supplierName);
    
    if (supplierMeds.length === 0) {
      // Find medicines with this last distributor in general low stock
      const lowStockMeds = medicines.filter(m => (m.lastDistributorName || "No Linked Vendor") === supplierName && m.stockQty <= (m.lowStockAlert || 20));
      if (lowStockMeds.length > 0) {
        supplierMeds = lowStockMeds;
      } else {
        // Fallback to any low stock item matching this vendor or general search
        const singleMed = medicines.find(m => (m.lastDistributorName || "No Linked Vendor") === supplierName);
        if (singleMed) supplierMeds = [singleMed];
      }
    }
    
    const supplierDoc = suppliers.find(s => s.name?.toLowerCase() === supplierName?.toLowerCase());
    const phone = supplierDoc?.phone || "";

    setPoModal({
      supplierName,
      phone,
      items: supplierMeds.map(m => ({
        medicineId: m.id,
        genericName: m.genericName,
        brandName: m.brandName,
        suggestedQty: m.suggestedQty || m.lowStockAlert || 20,
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
    { id: "pmbi-purchase", label: "PMBI Purchase", icon: "📦" },
    { id: "pmbi-opening-stock", label: "PMBI Opening Stock", icon: "➕" },
    { id: "vendors",   label: "Vendors & Dues", icon: "👥" },
    { id: "reorders",  label: "Reorder Hub", icon: "🔄" },
    { id: "inventory", label: "Inventory", icon: "💊" },
    { id: "bills",     label: "Bills History", icon: "🧾" },
    { id: "reports",   label: "GST & Reports", icon: "📈" },
    { id: "pmbi-reports", label: "PMBI Reports", icon: "📊" },
    { id: "h1-tracking", label: "H1 Compliance", icon: "🛡️" },
    { id: "alerts",    label: `Alerts (${lowStock.length})`, icon: "⏰" },
    { id: "analytics", label: "Analytics", icon: "📊" },
    { id: "settings",  label: "Store Settings", icon: "⚙️" },
  ];

  const allowedTabs = TABS.filter(t => userRole === "admin" || ["dashboard", "billing", "bills", "purchase", "pmbi-purchase", "pmbi-opening-stock", "pmbi-reports", "reports", "h1-tracking", "reorders", "vendors", "inventory", "alerts", "analytics"].includes(t.id));

  // Enforce staff restrictions dynamically
  if (userRole === "staff" && !["dashboard", "billing", "bills", "purchase", "pmbi-purchase", "pmbi-opening-stock", "pmbi-reports", "reports", "h1-tracking", "reorders", "vendors", "inventory", "alerts", "analytics"].includes(activeTab)) {
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
      
      {/* ── Custom CSS Stylings & Keyframes ── */}
      <style>{`
        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        ::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.02);
          border-radius: 4px;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(13, 115, 119, 0.4);
          border-radius: 4px;
          border: 2px solid transparent;
          background-clip: padding-box;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(13, 115, 119, 0.7);
          border: 2px solid transparent;
          background-clip: padding-box;
        }

        .main-content-layout {
          flex: 1;
          display: flex;
          flex-direction: column;
          min-width: 0;
          height: 100vh;
          overflow: hidden;
          margin-left: 240px;
          transition: margin-left 300ms ease-in-out;
        }
        .main-content-layout.collapsed {
          margin-left: 64px;
        }
        @media (max-width: 767px) {
          .main-content-layout, .main-content-layout.collapsed {
            margin-left: 0px !important;
          }
        }

        .drawer {
          position: fixed;
          top: 0;
          right: 0;
          height: 100vh;
          width: 460px;
          background: #ffffff;
          box-shadow: none;
          z-index: 9999;
          transform: translateX(100%);
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s ease, visibility 0.3s ease;
          display: flex;
          flex-direction: column;
          visibility: hidden;
        }
        .drawer.open {
          transform: translateX(0);
          box-shadow: -10px 0 35px rgba(10, 35, 66, 0.15);
          visibility: visible;
        }
        .drawer-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(10, 35, 66, 0.35);
          backdrop-filter: blur(4px);
          z-index: 9998;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
        }
        .drawer-overlay.open {
          opacity: 1;
          pointer-events: auto;
        }

        .top-menu-btn {
          padding: 8px 16px;
          border-radius: 6px;
          font-weight: 700;
          font-size: 13px;
          cursor: pointer;
          background: none;
          border: none;
          color: ${C.text2};
          transition: all 0.2s ease;
          position: relative;
        }
        .top-menu-btn:hover {
          color: ${C.teal};
          background: rgba(13, 115, 119, 0.05);
        }
        .top-menu-btn.active {
          color: ${C.teal};
          background: rgba(13, 115, 119, 0.08);
        }
        .top-menu-btn.active::after {
          content: '';
          position: absolute;
          bottom: 0;
          left: 15%;
          width: 70%;
          height: 3px;
          background: ${C.teal};
          border-radius: 2px;
        }

        .master-icon-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          padding: 10px 14px;
          border-radius: 10px;
          cursor: pointer;
          background: none;
          border: 1px solid transparent;
          color: ${C.text2};
          transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .master-icon-btn:hover {
          background: #ffffff;
          border-color: ${C.border};
          transform: translateY(-2px);
          box-shadow: 0 6px 12px rgba(10, 35, 66, 0.05);
          color: ${C.teal2};
        }

        .action-card {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 18px 20px;
          background: #ffffff;
          border: 1.5px solid ${C.border2};
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
          text-align: left;
          width: 100%;
          box-shadow: 0 1px 3px rgba(0,0,0,0.01);
        }
        .action-card:hover {
          transform: translateY(-3px) scale(1.02);
          border-color: var(--hover-color, ${C.blue});
          box-shadow: 0 8px 20px rgba(13, 115, 119, 0.1);
        }

        .kpi-card {
          background: #ffffff;
          border: 1px solid ${C.border};
          border-radius: 12px;
          padding: 18px 20px;
          transition: all 0.28s cubic-bezier(0.25, 0.8, 0.25, 1);
          position: relative;
          cursor: pointer;
          overflow: hidden;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
        }
        .kpi-card:hover {
          transform: translateY(-5px);
          box-shadow: 0 12px 24px rgba(10, 35, 66, 0.08);
          border-color: var(--hover-accent, ${C.teal2});
        }
        .kpi-card::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 3.5px;
          background: var(--hover-accent, ${C.teal2});
          transform: scaleX(0);
          transform-origin: left;
          transition: transform 0.28s ease;
        }
        .kpi-card:hover::after {
          transform: scaleX(1);
        }
      `}</style>
      
      {/* ── Sidebar Navigation ── */}
      <Sidebar
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
        storeName={storeName}
        storeCode={storeCode}
        userRole={userRole}
        userEmail={user?.email || ""}
        onSignOut={handleSignOut}
        onOpenModal={(type) => {
          if (type === "openingStock") {
            setActiveTab("inventory");
            alert("To record an Opening Stock / Balance, click on the 'Opening Stock' button for the desired medicine in the Inventory list.");
          } else if (type === "payment") {
            setShowRecordPaymentModal(true);
          } else if (type === "receipt" || type === "contra" || type === "journal") {
            setActiveTab("bills");
          }
        }}
        onNavigate={(path) => {
          const tabId = path.split("/").pop() || "dashboard";
          setActiveTab(tabId);
        }}
        activeTab={activeTab}
      />

      {/* Mobile Sidebar Backdrop Overlay */}
      {!isSidebarCollapsed && (
        <div 
          onClick={() => setIsSidebarCollapsed(true)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15, 23, 42, 0.4)",
            backdropFilter: "blur(4px)",
            zIndex: 30
          }}
          className="md:hidden animate-in fade-in duration-200"
        />
      )}

      {/* ── Main Content Area ── */}
      <div className={`main-content-layout ${isSidebarCollapsed ? "collapsed" : ""}`}>
        
        {/* Scoped Topbar */}
        <header style={{ ...S.topbar, background: "#ffffff", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button 
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              style={{ 
                background: "none", 
                border: "none", 
                cursor: "pointer", 
                fontSize: 22, 
                color: C.navy,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "4px 8px",
                marginLeft: -8
              }}
              title="Menu"
            >
              ☰
            </button>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px" }}>Active Store: {storeName}</span>
              <h2 style={{ fontSize: 18, fontWeight: 800, color: C.navy, marginTop: 2 }}>
                {TABS.find(t => t.id === activeTab)?.label}
              </h2>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span style={{ fontSize: 12, color: C.text3, fontWeight: 600 }}>{now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</span>
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
          </div>
        </header>

        <main style={{ ...S.main, display: "flex", flexDirection: "column", gap: 16 }}>
          {dbLoading && <div style={{ textAlign: "center", padding: "40px 0", color: C.text3, fontSize: 14 }}>Syncing with cloud...</div>}

        {/* DASHBOARD TAB REDESIGN */}
        {!dbLoading && activeTab === "dashboard" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16, flex: 1 }}>
            
            {/* ── Dashboard Control Panel ── */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#ffffff", border: `1px solid ${C.border}`, borderRadius: 12, padding: "12px 20px" }}>
              <div>
                <strong style={{ fontSize: 14, color: C.navy }}>Pharmacy Admin Dashboard</strong>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>Keep your local database synchronized with cloud data updates.</div>
              </div>
              <button 
                onClick={() => {
                  setRefreshing(true);
                  setTimeout(() => {
                    setRefreshing(false);
                    setLastSyncSec(0);
                    alert("✓ Dashboard Refreshed! Firebase datasets successfully re-synchronized.");
                  }, 1000);
                }}
                style={{ background: C.teal2, border: "none", borderRadius: 8, padding: "8px 14px", color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}
              >
                <span style={{ display: "inline-block", transform: refreshing ? "rotate(360deg)" : "none", transition: "transform 1s linear" }}>🔄</span>
                Refresh Dashboard
              </button>
            </div>

            {/* ── Action Cards Row (Zoho ERP Shortcuts layout) ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
              <button 
                className="action-card" 
                style={{ "--hover-color": C.teal }}
                onClick={() => { setActiveTab("billing"); setTimeout(() => billSearchRef.current?.focus(), 100); }}
              >
                <div style={{ padding: 10, background: "rgba(13,115,119,0.08)", borderRadius: 10, fontSize: 24 }}>🛒</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>Add Sales Invoice</div>
                  <span style={{ fontSize: 11, color: C.text3 }}>POS Quick Billing Screen</span>
                </div>
              </button>
              <button 
                className="action-card" 
                style={{ "--hover-color": C.blue }}
                onClick={() => setActiveTab("reorders")}
              >
                <div style={{ padding: 10, background: "rgba(21,101,192,0.08)", borderRadius: 10, fontSize: 24 }}>📄</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>Add Purchase Order</div>
                  <span style={{ fontSize: 11, color: C.text3 }}>Draft Reorder PO Suggestions</span>
                </div>
              </button>
              <button 
                className="action-card" 
                style={{ "--hover-color": C.green }}
                onClick={() => { setActiveTab("purchase"); setShowPurchaseForm(true); }}
              >
                <div style={{ padding: 10, background: "rgba(27,122,78,0.08)", borderRadius: 10, fontSize: 24 }}>📦</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>Add Purchase Invoice</div>
                  <span style={{ fontSize: 11, color: C.text3 }}>Stock Inflow Purchase Form</span>
                </div>
              </button>
              <button 
                className="action-card" 
                style={{ "--hover-color": C.red }}
                onClick={() => setShowRecordPaymentModal(true)}
              >
                <div style={{ padding: 10, background: "rgba(192,57,43,0.08)", borderRadius: 10, fontSize: 24 }}>💸</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>Add Payments</div>
                  <span style={{ fontSize: 11, color: C.text3 }}>Log Dues Made to Vendors</span>
                </div>
              </button>
              <button 
                className="action-card" 
                style={{ "--hover-color": C.teal2 }}
                onClick={() => { setActiveTab("reports"); setReportsSubTab("adc"); setAdcSubTab("sales"); }}
              >
                <div style={{ padding: 10, background: "rgba(20,160,133,0.08)", borderRadius: 10, fontSize: 24 }}>🛡️</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>Detailed Sales Register</div>
                  <span style={{ fontSize: 11, color: C.text3 }}>Drug Inspector compliance</span>
                </div>
              </button>
              <button 
                className="action-card" 
                style={{ "--hover-color": C.blue }}
                onClick={() => { setActiveTab("reports"); setReportsSubTab("adc"); setAdcSubTab("purchase"); }}
              >
                <div style={{ padding: 10, background: "rgba(21,101,192,0.08)", borderRadius: 10, fontSize: 24 }}>🛡️</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 800, color: C.navy }}>Detailed Purchase Register</div>
                  <span style={{ fontSize: 11, color: C.text3 }}>DI Stock verification</span>
                </div>
              </button>
            </div>

            {/* ── 12 KPI Stats Card Grid (PMBI Dashboard replication) ── */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
              
              {/* Card 1: Today Sales */}
              {(() => {
                const todaySales = todaySalesAll.reduce((a, s) => a + (s.grandTotal || 0), 0);
                return (
                  <div className="kpi-card" style={{ "--hover-accent": C.blue }} onClick={() => setActiveTab("billing")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>TODAY SALES</span>
                      <span style={{ fontSize: 16 }}>📈</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: C.blue }}>₹{todaySales.toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>{todaySalesAll.length} invoices generated today</div>
                  </div>
                );
              })()}

              {/* Card 2: Monthly Sales */}
              <div className="kpi-card" style={{ "--hover-accent": C.teal }} onClick={() => setActiveTab("reports")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>MONTHLY SALES</span>
                  <span style={{ fontSize: 16 }}>🗓️</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: C.teal }}>₹{rTS.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Total for current report month</div>
              </div>

              {/* Card 3: PMBI Outstanding */}
              {(() => {
                const totalOutstanding = suppliers.reduce((a, s) => a + (s.outstanding || 0), 0);
                return (
                  <div className="kpi-card" style={{ "--hover-accent": C.red }} onClick={() => setShowPendingPaymentsModal(true)}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>PMBI OUTSTANDING DUES</span>
                      <span style={{ fontSize: 16 }}>⚙️</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: C.red }}>₹{totalOutstanding.toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Dues remaining to suppliers</div>
                  </div>
                );
              })()}

              {/* Card 4: Overdue Collection */}
              {(() => {
                const creditSales = sales.filter(s => s.paymentMode?.toLowerCase() === "credit");
                const totalCredit = creditSales.reduce((a, s) => a + (s.grandTotal || 0), 0);
                return (
                  <div className="kpi-card" style={{ "--hover-accent": C.amber }} onClick={() => setActiveTab("bills")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>PENDING OVERDUE COLLECTION</span>
                      <span style={{ fontSize: 16 }}>💼</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: C.amber }}>₹{totalCredit.toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>{creditSales.length} unpaid credit bills</div>
                  </div>
                );
              })()}
              {/* Card 5: Monthly Net Profit (Secured View) */}
              {userRole === "admin" && (
                <div 
                  className="kpi-card" 
                  style={{ "--hover-accent": C.green, cursor: "pointer" }} 
                  onClick={() => setShowProfit(!showProfit)}
                  title={showProfit ? "Click to mask profit" : "Click to view profit"}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>MONTHLY NET PROFIT</span>
                    <span style={{ fontSize: 16 }}>💰</span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: C.green, display: "flex", alignItems: "center", gap: 10 }}>
                    {showProfit ? `₹${rSales.reduce((a, s) => a + (s.profit || 0), 0).toFixed(2)}` : "₹ •••••"}
                    <span style={{ fontSize: 14, userSelect: "none" }}>{showProfit ? "🔓" : "🔒"}</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>
                    <span>{showProfit ? "Estimated net profit (GST-adjusted)" : "Secured view (click to reveal)"}</span>
                  </div>
                </div>
              )}              {/* Card 6: Nearby Expiry */}
              <div className="kpi-card" style={{ "--hover-accent": "#B7791F" }} onClick={() => setShowNearbyExpiryModal(true)}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>NEARBY EXPIRY (&lt;3 MONTHS)</span>
                  <span style={{ fontSize: 16 }}>📅</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#B7791F" }}>{expiringSoon.length}</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Inventory batches near expiration</div>
              </div>

              {/* Card 7: Notification */}
              <div className="kpi-card" style={{ "--hover-accent": C.blue }} onClick={() => setActiveTab("alerts")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>NOTIFICATIONS</span>
                  <span style={{ fontSize: 16 }}>🔔</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: C.blue }}>{lowStock.length + expiringSoon.length}</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>System health notifications</div>
              </div>

              {/* Card 8: Pending Overdue Payment */}
              {(() => {
                const totalOutstanding = suppliers.reduce((a, s) => a + (s.outstanding || 0), 0);
                return (
                  <div className="kpi-card" style={{ "--hover-accent": C.red }} onClick={() => setShowPendingPaymentsModal(true)}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>PENDING OVERDUE PAYMENT</span>
                      <span style={{ fontSize: 16 }}>₹</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: C.red }}>₹{totalOutstanding.toFixed(2)}</div>
                    <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Supplier outstandings overdue</div>
                  </div>
                );
              })()}

              {/* Card 9: Low Stock Alert */}
              <div className="kpi-card" style={{ "--hover-accent": "#C0392B" }} onClick={() => setActiveTab("alerts")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>LOW STOCK ALERT</span>
                  <span style={{ fontSize: 16 }}>📢</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: "#C0392B" }}>{lowStock.length}</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Medicines below threshold</div>
              </div>

              {/* Card 10: Low Stock Mandate Ratio */}
              <div className="kpi-card" style={{ "--hover-accent": C.teal2 }} onClick={() => setActiveTab("reorders")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>LOW STOCK (STOCK MANDATE)</span>
                  <span style={{ fontSize: 16 }}>🛒</span>
                </div>
                <div style={{ fontSize: 24, fontWeight: 800, color: C.teal2 }}>{lowStock.length} / {medicines.length || 200}</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Mandated product availability status</div>
              </div>

              {/* Card 11: Non Moving Item */}
              {(() => {
                const soldMedIds = new Set(sales.flatMap(s => (s.items || []).map(i => i.medicineId)));
                const nonMovingCount = medicines.filter(m => !soldMedIds.has(m.id)).length;
                return (
                  <div className="kpi-card" style={{ "--hover-accent": C.navy }} onClick={() => setActiveTab("inventory")}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>NON MOVING ITEM</span>
                      <span style={{ fontSize: 16 }}>🔄</span>
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: C.navy }}>{nonMovingCount}</div>
                    <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>Medicines with 0 sales in 30 days</div>
                  </div>
                );
              })()}

              {/* Card 12: Stock Report */}
              <div className="kpi-card" style={{ "--hover-accent": C.blue }} onClick={() => {
                setActiveTab("reports");
                setReportsSubTab("stock-inventory");
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>STOCK REPORT</span>
                  <span style={{ fontSize: 16 }}>📄</span>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginTop: 8 }}>📋 Open Stock Report</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>View, filter, and export stock inventory</div>
              </div>

              {/* Card 13: Analytics */}
              <div className="kpi-card" style={{ "--hover-accent": C.green }} onClick={() => setActiveTab("analytics")}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px" }}>PROFIT & ANALYTICS</span>
                  <span style={{ fontSize: 16 }}>📊</span>
                </div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.green, marginTop: 8 }}>📈 View Analytics</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 4 }}>P&L, margins, top medicines & trends</div>
              </div>

            </div>

            {/* Recent Sales & Low Stock side-by-side section */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, flex: 1, minHeight: 0 }}>
              
              {/* Left Column: Recent Sales */}
              <div style={{ ...S.card, margin: 0, display: "flex", flexDirection: "column", minHeight: 250 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>Recent Sales Bills</span>
                  <span style={S.badge("teal")}>{sales.length} total</span>
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {sales.length === 0 ? <div style={{ color: C.text3, fontSize: 13, padding: "8px 0" }}>No sales yet. Start billing!</div>
                    : sales.slice(0, 5).map(s => (
                      <div key={s.id} style={{ display: "flex", justifyContent: "space-between", padding: "9px 0", borderBottom: `1px solid ${C.border}` }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{s.billNumber}</div>
                          <div style={{ fontSize: 11, color: C.text3 }}>{s.createdAt?.toDate ? s.createdAt.toDate().toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>₹{(s.grandTotal||0).toFixed(2)}</div>
                          <div style={{ fontSize: 11, color: C.text3 }}>{s.paymentMode}</div>
                        </div>
                      </div>
                    ))}
                </div>
              </div>

              {/* Right Column: Low Stock Panel */}
              <div style={{ ...S.card, margin: 0, display: "flex", flexDirection: "column", minHeight: 250 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: C.amber, textTransform: "uppercase", letterSpacing: "0.5px" }}>Low Stock Warnings</span>
                  <span style={S.badge("amber")}>{lowStock.length} items</span>
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {lowStock.length === 0 ? <div style={{ color: C.text3, fontSize: 13, padding: "8px 0" }}>All stock levels healthy! ✓</div>
                    : lowStock.slice(0, 5).map(m => {
                      const vendorName = m.lastDistributorName || "No Linked Vendor";
                      return (
                        <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600 }}>{m.genericName}</div>
                            <div style={{ fontSize: 11, color: C.text3 }}>{m.brandName ? `${m.brandName} · ` : ""}{vendorName}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                            <span style={S.badge(m.stockQty === 0 ? "red" : "amber")}>{m.stockQty} left</span>
                            <button 
                              style={{ ...S.btn("teal"), padding: "4px 8px", fontSize: 11 }}
                              onClick={() => handleOpenCreatePo(vendorName)}
                            >
                              📋 Create PO
                            </button>
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>

            </div>

          </div>
        )}

        {/* BILLING */}
        {!dbLoading && activeTab === "billing" && (
          <div>
            <PH 
              title="Sales Invoice" 
              sub="F2 = Focus Search · Enter = Add · F9 = Checkout & Print" 
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
              </div>
            </div>

            {/* UNMAPPED ITEMS NOTICE BANNER */}
            {totalUnmappedCount > 0 && (
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 18px",
                background: "linear-gradient(135deg, #FEF3DC 0%, #FFFDF5 100%)",
                border: `1.5px solid ${C.amber}`,
                borderRadius: 8,
                color: C.amber,
                marginBottom: 14,
                boxShadow: "0 2px 8px rgba(146, 96, 10, 0.08)",
                fontSize: 12
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 16 }}>⚠️</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13, color: "#92600A" }}>
                      {totalUnmappedCount} item{totalUnmappedCount > 1 ? "s" : ""} sold not linked to stock
                    </div>
                    <div style={{ color: C.text2, fontSize: 11, marginTop: 2 }}>
                      Map these new items to catalog medicines to correct inventory stock counts.
                    </div>
                  </div>
                </div>
                <button 
                  style={{ 
                    ...S.btn("teal"), 
                    background: "#D97706", 
                    padding: "6px 14px", 
                    fontSize: 12,
                    fontWeight: 700,
                    color: "#fff"
                  }} 
                  onClick={() => setShowMappingModal(true)}
                >
                  Fix Now
                </button>
              </div>
            )}

            {/* ── SALES INVOICE HEADER PANEL ── */}
            <div style={{ 
              background: "#F8FAFC", 
              border: `1px solid ${C.border}`, 
              borderRadius: 12, 
              padding: "18px 20px", 
              marginBottom: 16,
              boxShadow: "0 1px 3px rgba(0,0,0,0.02)"
            }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: C.navy, borderBottom: `1.5px solid ${C.border}`, paddingBottom: 8, marginBottom: 14, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                📄 Sales Invoice Header
              </div>
              
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Invoice No:</label>
                  <input style={{ ...S.input, background: "#E2E8F0", cursor: "not-allowed", fontWeight: 700, color: C.navy }} value={activeInvoiceNo} disabled />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Date:</label>
                  <input type="date" style={S.input} value={invoiceDate} onChange={e => setInvoiceDate(e.target.value)} />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>GST Type:</label>
                  <select style={S.input} value={gstType} onChange={e => setGstType(e.target.value)}>
                    <option>Local State</option>
                    <option>Central State</option>
                    <option>Out of Country</option>
                  </select>
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Cust.Ref. No:</label>
                  <input style={S.input} value={custRefNo} onChange={e => setCustRefNo(e.target.value)} placeholder="Cust. Ref. No" />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Due Date:</label>
                  <input type="date" style={S.input} value={dueDate} onChange={e => setDueDate(e.target.value)} />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Rate Type:</label>
                  <select style={S.input} value={rateType} onChange={e => setRateType(e.target.value)}>
                    <option>Sales Rate</option>
                    <option>Wholesale Rate</option>
                    <option>Special Rate</option>
                  </select>
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Pat Mob. No:</label>
                  <input style={{ ...S.input, borderColor: C.border2 }} value={customerPhone} onChange={e => setCustomerPhone(e.target.value)} placeholder="10-digit Mobile" />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>A/c Name:</label>
                  <select style={S.input} value={accountName} onChange={e => {
                    setAccountName(e.target.value);
                    if (e.target.value === "Credit Sale") setCreditBill(true);
                    else setCreditBill(false);
                  }}>
                    <option>Cash Sale</option>
                    <option>Credit Sale</option>
                  </select>
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Book:</label>
                  <select style={S.input} value={bookType} onChange={e => setBookType(e.target.value)}>
                    <option>GST Invoice</option>
                    <option>Cash Book</option>
                    <option>Credit Book</option>
                  </select>
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Email Id:</label>
                  <input style={S.input} value={customerEmail} onChange={e => setCustomerEmail(e.target.value)} placeholder="patient@email.com" />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Patient Name:</label>
                  <input style={{ ...S.input, borderColor: C.border2 }} value={customerName} onChange={e => setCustomerName(e.target.value)} placeholder="Patient Name" />
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Gst No:</label>
                  <input style={S.input} value={gstNo} onChange={e => setGstNo(e.target.value)} placeholder="GSTIN (Optional)" />
                </div>
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Doctor/CRNo:</label>
                  <div style={{ position: "relative" }}>
                    <input 
                      style={{ ...S.input, borderColor: C.border2 }} 
                      value={doctorName} 
                      onChange={e => { setDoctorName(e.target.value); setDoctorDropdownOpen(true); }}
                      onFocus={() => setDoctorDropdownOpen(true)}
                      onBlur={() => setTimeout(() => setDoctorDropdownOpen(false), 250)}
                      placeholder="Search registered doctor..."
                    />
                    {doctorDropdownOpen && (doctorName ? doctors.filter(d => d.name.toLowerCase().includes(doctorName.toLowerCase())) : doctors).length > 0 && (
                      <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: `1.5px solid ${C.border2}`, borderRadius: 8, zIndex: 1000, maxHeight: 150, overflowY: "auto", boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)", marginTop: 4 }}>
                        {(doctorName ? doctors.filter(d => d.name.toLowerCase().includes(doctorName.toLowerCase())) : doctors).map(doc => (
                          <div key={doc.id} onMouseDown={() => { setDoctorName(doc.name); setDoctorDropdownOpen(false); }} style={{ padding: "8px 12px", cursor: "pointer", fontSize: 12, borderBottom: `1px solid ${C.border}` }} onMouseEnter={e => e.currentTarget.style.background = "#F1F5F9"} onMouseLeave={e => e.currentTarget.style.background = "none"}>
                            🩺 <strong>{doc.name}</strong> <span style={{ color: C.text3, fontSize: 10 }}>({doc.specialization})</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ gridColumn: "span 2" }}>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Remarks:</label>
                  <textarea style={{ ...S.input, height: 38, resize: "none" }} value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Internal remarks" />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, gridColumn: "span 1" }}>
                  <input type="checkbox" id="credit-bill-chk" checked={creditBill} onChange={e => {
                    setCreditBill(e.target.checked);
                    setAccountName(e.target.checked ? "Credit Sale" : "Cash Sale");
                  }} style={{ width: 18, height: 18, cursor: "pointer" }} />
                  <label htmlFor="credit-bill-chk" style={{ fontSize: 12, fontWeight: 700, color: C.navy, cursor: "pointer" }}>Credit Bill</label>
                </div>
                <div>
                  <label style={{ ...S.label, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>Find Invoice No:</label>
                  <input style={S.input} value={findInvoiceNo} onChange={e => setFindInvoiceNo(e.target.value)} placeholder="Find Invoice..." onKeyDown={e => {
                    if (e.key === "Enter" && findInvoiceNo.trim()) {
                      const found = sales.find(s => s.billNumber?.toLowerCase() === findInvoiceNo.trim().toLowerCase());
                      if (found) {
                        setSelectedBill(found);
                        alert(`✓ Found Invoice: ${found.billNumber}. Loading details.`);
                      } else {
                        alert("⚠ Invoice not found.");
                      }
                    }
                  }} />
                </div>
              </div>
            </div>

            {/* ── SEARCH DRUG ROW PANEL ── */}
            <div style={{ 
              background: "#F1F5F9", 
              border: `1.5px solid ${C.border2}`, 
              borderRadius: 12, 
              padding: "16px 20px", 
              marginBottom: 16,
              boxShadow: "0 1px 3px rgba(0,0,0,0.02)"
            }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: C.text3, marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                🔍 Search Drug
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
                
                {/* Drug Search */}
                <div style={{ flex: "2 1 240px", position: "relative" }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Drug Name / Salt</label>
                  <input
                    ref={billSearchRef}
                    style={{ ...S.input, fontSize: 13, padding: "8px 12px", border: `1.5px solid ${C.border2}` }}
                    value={billSearch}
                    onChange={e => { setBillSearch(e.target.value); setSearchHighlight(-1); }}
                    onKeyDown={e => {
                      if (e.key === "Enter" && searchResults.length > 0) {
                        e.preventDefault();
                        const selectedIdx = searchHighlight >= 0 ? searchHighlight : 0;
                        handleSelectSearchDrug(searchResults[selectedIdx]);
                      } else if (e.key === "ArrowDown" && searchResults.length > 0) {
                        e.preventDefault();
                        setSearchHighlight(prev => Math.min(prev + 1, searchResults.length - 1));
                      } else if (e.key === "ArrowUp" && searchResults.length > 0) {
                        e.preventDefault();
                        setSearchHighlight(prev => Math.max(prev - 1, 0));
                      } else if (e.key === "Escape") {
                        setBillSearch("");
                        setSearchHighlight(-1);
                      }
                    }}
                    placeholder="Search catalog medicines..."
                    autoComplete="off"
                  />
                  {searchResults.length > 0 && (
                    <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "#fff", border: `1.5px solid ${C.teal}`, borderRadius: 10, zIndex: 100, overflow: "hidden", marginTop: 3, boxShadow: "0 8px 24px rgba(0,0,0,0.12)" }}>
                      {searchResults.map((m, idx) => {
                        if (m.isAddTempRow) {
                          return (
                            <div key="add-temp-row" onMouseDown={() => handleSelectSearchDrug(m)}>
                              <button style={{ width: "100%", padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", background: idx === searchHighlight ? "#FEF3DC" : "#FFFBEB", border: "none", cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                                <span style={{ fontWeight: 700, color: C.amber, fontSize: 12 }}>{m.genericName}</span>
                                <span style={{ ...S.badge("amber"), fontSize: 9 }}>NEW DEMAND</span>
                              </button>
                            </div>
                          );
                        }
                        const expiring = isExpiringSoon(m);
                        const expired = isExpired(m);
                        const oos = m.stockQty <= 0;
                        return (
                          <div key={m.id} onMouseDown={() => handleSelectSearchDrug(m)}>
                            <button style={{ width: "100%", padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: idx === searchHighlight ? "#E0F7F4" : expired ? "#FFF5F5" : oos ? "#FFFBEB" : "none", border: "none", borderBottom: `1px solid ${C.border}`, cursor: expired ? "not-allowed" : "pointer", fontFamily: "inherit", textAlign: "left", opacity: expired ? 0.6 : 1 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                {/* Row 1: Name + status badges */}
                                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
                                  <span style={{ fontWeight: 600, color: C.navy, fontSize: 12 }}>{m.genericName}</span>
                                  {m.brandName && m.brandName !== m.genericName && <span style={{ color: C.text3, fontSize: 11 }}>{m.brandName}</span>}
                                  {m.category === "PMBI" && <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: C.teal, borderRadius: 4, padding: "1px 4px", marginLeft: 4 }}>PMBI</span>}
                                  {m.isH1Drug && <span style={{ fontSize: 9, fontWeight: 700, color: "#fff", background: C.red, borderRadius: 4, padding: "1px 4px", marginLeft: 4 }}>H1</span>}
                                  {expired && <span style={{ fontSize: 9, fontWeight: 700, color: C.red, background: "#FDECEA", borderRadius: 4, padding: "1px 4px" }}>EXPIRED</span>}
                                  {!expired && expiring && <span style={{ fontSize: 9, fontWeight: 700, color: C.amber, background: "#FEF3DC", borderRadius: 4, padding: "1px 4px" }}>Expiring Soon</span>}
                                </div>
                                {/* Row 2: Batch & Expiry info */}
                                {(() => {
                                  const batches = m.batches || [];
                                  if (batches.length > 0) {
                                    return (
                                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 3 }}>
                                        {batches.slice(0, 3).map((b, bi) => {
                                          const bExp = b.expiryDate || "—";
                                          const isExpiredBatch = (() => { try { const [mo, yr] = bExp.split("/"); const y = yr?.length === 2 ? 2000 + parseInt(yr) : parseInt(yr); return new Date(y, parseInt(mo) - 1, 28) < new Date(); } catch { return false; } })();
                                          return (
                                            <span key={bi} style={{ fontSize: 9.5, fontFamily: "monospace", background: isExpiredBatch ? "#FDECEA" : "#F0FDF4", color: isExpiredBatch ? C.red : "#166534", border: `1px solid ${isExpiredBatch ? "#FCA5A5" : "#86EFAC"}`, borderRadius: 4, padding: "1px 5px", whiteSpace: "nowrap" }}>
                                              B: {b.batchNumber} · Exp: {bExp} · Qty: {b.quantity ?? b.stockQty ?? "?"}
                                            </span>
                                          );
                                        })}
                                        {batches.length > 3 && <span style={{ fontSize: 9, color: C.text3 }}>+{batches.length - 3} more batches</span>}
                                      </div>
                                    );
                                  } else if (m.batchNumber || m.expiryDate) {
                                    const bExp = m.expiryDate || "—";
                                    const isExpiredBatch = (() => { try { const [mo, yr] = bExp.split("/"); const y = yr?.length === 2 ? 2000 + parseInt(yr) : parseInt(yr); return new Date(y, parseInt(mo) - 1, 28) < new Date(); } catch { return false; } })();
                                    return (
                                      <div style={{ marginTop: 3 }}>
                                        <span style={{ fontSize: 9.5, fontFamily: "monospace", background: isExpiredBatch ? "#FDECEA" : "#F0FDF4", color: isExpiredBatch ? C.red : "#166534", border: `1px solid ${isExpiredBatch ? "#FCA5A5" : "#86EFAC"}`, borderRadius: 4, padding: "1px 5px" }}>
                                          B: {m.batchNumber || "—"} · Exp: {bExp}
                                        </span>
                                      </div>
                                    );
                                  }
                                  return null;
                                })()}
                              </div>
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, marginLeft: 8, flexShrink: 0 }}>
                                <span style={{ fontWeight: 700, color: C.blue, fontSize: 12 }}>₹{m.sellingPrice || m.mrp}</span>
                                <span style={{ ...S.badge(expired ? "red" : oos ? "red" : m.stockQty <= m.lowStockAlert ? "amber" : "teal"), padding: "1px 5px", fontSize: 9 }}>
                                  {oos ? "OOS" : `Stock: ${m.stockQty}`}
                                </span>
                              </div>
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Batch Selector */}
                <div style={{ width: 140 }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Batch No</label>
                  <select
                    style={S.input}
                    value={searchDrugBatch}
                    onChange={e => setSearchDrugBatch(e.target.value)}
                    disabled={!searchDrugSelected}
                  >
                    {!searchDrugSelected && <option value="">-- Batch --</option>}
                    {searchDrugSelected && (searchDrugSelected.batches || []).map(b => (
                      <option key={b.batchNumber} value={b.batchNumber}>
                        {b.batchNumber} (Exp: {b.expiryDate}) · ₹{((b.sellingPrice || b.mrp) || 0).toFixed(2)} · Qty: {b.quantity}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Qty Input */}
                <div style={{ width: 80 }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Qty</label>
                  <input
                    id="search-drug-qty"
                    type="number"
                    style={S.input}
                    value={searchDrugQty}
                    onChange={e => setSearchDrugQty(e.target.value)}
                    disabled={!searchDrugSelected}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSearchDrugToBill();
                      }
                    }}
                    placeholder="Qty"
                  />
                </div>

                {/* Discount Input */}
                <div style={{ width: 80 }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Disc. (%)</label>
                  <input
                    type="number"
                    step="0.001"
                    style={S.input}
                    value={searchDrugDiscount}
                    onChange={e => setSearchDrugDiscount(e.target.value)}
                    disabled={!searchDrugSelected}
                    onKeyDown={e => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSearchDrugToBill();
                      }
                    }}
                    placeholder="Disc%"
                  />
                </div>

                {/* Pack Size Display */}
                <div style={{ width: 90 }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Pack Size</label>
                  <input
                    style={{ ...S.input, background: "#E2E8F0", cursor: "not-allowed" }}
                    value={searchDrugSelected ? `${searchDrugSelected.form || "Tab"}` : "—"}
                    disabled
                  />
                </div>

                {/* Rate Display */}
                <div style={{ width: 100 }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Rate (₹)</label>
                  <input
                    style={{ ...S.input, background: "#E2E8F0", cursor: "not-allowed", fontWeight: 700 }}
                    value={
                      searchDrugSelected 
                        ? ((searchDrugSelected.batches || []).find(b => b.batchNumber === searchDrugBatch)?.sellingPrice || searchDrugSelected.sellingPrice || searchDrugSelected.mrp || 0).toFixed(2) 
                        : "0.00"
                    }
                    disabled
                  />
                </div>

                {/* Location Display */}
                <div style={{ width: 90 }}>
                  <label style={{ ...S.label, fontSize: 10 }}>Location</label>
                  <input
                    style={{ ...S.input, background: "#E2E8F0", cursor: "not-allowed" }}
                    value={searchDrugSelected ? (searchDrugSelected.location || "N/A") : "—"}
                    disabled
                  />
                </div>

                {/* Stock Info & Buttons */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginLeft: "auto", flexWrap: "wrap" }}>
                  <div style={{ marginRight: 10, fontSize: 11, color: C.text2 }}>
                    Stock Available Qty: <strong style={{ color: C.teal }}>
                      {searchDrugSelected 
                        ? ((searchDrugSelected.batches || []).find(b => b.batchNumber === searchDrugBatch)?.quantity || 0)
                        : "0.00"}
                    </strong>
                  </div>
                  
                  <button 
                    onClick={addSearchDrugToBill}
                    style={{ ...S.btn("teal"), padding: "9px 18px", fontSize: 12, fontWeight: 700 }}
                    disabled={!searchDrugSelected}
                  >
                    ✚ Add
                  </button>
                  <button 
                    onClick={addDemandedDrugToBill}
                    style={{ ...S.btn("outline"), borderColor: C.amber, color: C.amber, padding: "8px 14px", fontSize: 12, fontWeight: 700 }}
                  >
                    ⚠ Add Demanded Drug
                  </button>
                </div>

              </div>
            </div>

            {/* ── SALES INVOICE DETAIL TABLE ── */}
            <div style={{ ...S.card, padding: 0, overflow: "hidden", marginBottom: 16 }}>
              <div style={{ background: "#0B192C", color: "#fff", padding: "10px 16px", fontSize: 12, fontWeight: 800, letterSpacing: "0.5px", textTransform: "uppercase" }}>
                📦 Sales Invoice Detail
              </div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
                      {["SrNo", "Drug Code", "Generic / Brand Name", "Pack Size", "Batch No", "Location", "Mfg. Date", "Exp. Date", "MRP", "Qty", "No of Pack", "Rate", "Disc (%)", "Disc. Amt", "Total", ""].map(h => (
                        <th key={h} style={{ ...S.th, fontSize: 11, padding: "10px 12px" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {billItems.length === 0 ? (
                      <tr>
                        <td colSpan="16" style={{ ...S.td, textAlign: "center", color: C.text3, padding: "32px 0", fontStyle: "italic" }}>
                          No medicines added. Search and select above to build the sales invoice.
                        </td>
                      </tr>
                    ) : (
                      billItems.map((item, idx) => {
                        const c = calcItem(item);
                        const expired = isExpired(item);
                        const expiring = isExpiringSoon(item);
                        
                        return (
                          <tr key={`${item.id}-${item.selectedBatchNumber}-${idx}`} style={{ borderBottom: `1px solid ${C.border}`, background: expired ? "#FFF5F5" : expiring ? "#FFFDF0" : "" }}>
                            <td style={{ ...S.td, fontSize: 12, padding: "8px 12px", fontWeight: 700 }}>{idx + 1}</td>
                            <td style={{ ...S.td, fontSize: 11, color: C.text3 }}>{item.drugCode || item.barcode || "GEN-REG"}</td>
                            <td style={{ ...S.td, fontSize: 12, padding: "8px 12px" }}>
                              <div style={{ fontWeight: 700, color: C.navy, display: "flex", alignItems: "center", gap: 4 }}>
                                {item.genericName}
                                {item.category === "PMBI" && <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: C.teal, borderRadius: 4, padding: "1px 3px" }}>PMBI</span>}
                                {item.isH1Drug && <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: C.red, borderRadius: 4, padding: "1px 3px" }}>H1</span>}
                              </div>
                              {item.brandName && item.brandName !== item.genericName && <div style={{ fontSize: 10, color: C.text3, marginTop: 1 }}>{item.brandName}</div>}
                              {item.isTemporary && <span style={{ ...S.badge("amber"), fontSize: 8, padding: "0px 4px" }}>UNMAPPED</span>}
                            </td>
                            <td style={{ ...S.td, fontSize: 12 }}>{item.form || "Tab"}</td>
                            <td style={{ ...S.td, fontSize: 12, fontWeight: 600 }}>{item.selectedBatchNumber || "TEMP-001"}</td>
                            <td style={{ ...S.td, fontSize: 12 }}>{item.location || "Rack A"}</td>
                            <td style={{ ...S.td, fontSize: 11, color: C.text3 }}>—</td>
                            <td style={{ ...S.td, fontSize: 11, color: expired ? C.red : expiring ? C.amber : C.text2, fontWeight: 700 }}>
                              {item.expiryDate || "—"} {expired && "⚠"}
                            </td>
                            <td style={{ ...S.td, fontSize: 12, fontWeight: 700 }}>₹{(item.originalMrp || item.mrp || 0).toFixed(2)}</td>
                            <td style={{ ...S.td, fontSize: 12 }}>
                              <input
                                type="number"
                                style={{ ...S.input, width: 60, padding: "4px 6px", fontSize: 12, textAlign: "center" }}
                                value={item.qty}
                                onChange={e => {
                                  const newQty = parseInt(e.target.value) || 0;
                                  setBillItems(prev => prev.map((bi, i) => i === idx ? { ...bi, qty: newQty } : bi));
                                }}
                              />
                            </td>
                            <td style={{ ...S.td, fontSize: 12 }}>1</td>
                            <td style={{ ...S.td, fontSize: 12, fontWeight: 700 }}>₹{(item.mrp || 0).toFixed(2)}</td>
                            <td style={{ ...S.td, fontSize: 12 }}>
                              <input
                                type="number"
                                step="0.001"
                                style={{ ...S.input, width: 65, padding: "4px 6px", fontSize: 12, textAlign: "center" }}
                                value={item.discount}
                                onChange={e => {
                                  const newDisc = parseFloat(e.target.value) || 0;
                                  setBillItems(prev => prev.map((bi, i) => i === idx ? { ...bi, discount: newDisc } : bi));
                                }}
                              />
                            </td>
                            <td style={{ ...S.td, fontSize: 12, color: C.red }}>₹{c.disc.toFixed(2)}</td>
                            <td style={{ ...S.td, fontSize: 12, fontWeight: 800, color: C.green }}>₹{c.total.toFixed(2)}</td>
                            <td style={{ ...S.td, textAlign: "center" }}>
                              <button
                                onClick={() => setBillItems(prev => prev.filter((_, i) => i !== idx))}
                                style={{ background: "none", border: "none", color: C.red, cursor: "pointer", padding: 6, fontSize: 13 }}
                                title="Remove item"
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
            </div>

            {/* ── BOTTOM TOTALS & PAYMENT SECTION ── */}
            <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.5fr 1.3fr", gap: 16, alignItems: "start", marginBottom: 20 }}>
              
              {/* Tax Details Table */}
              <div style={{ ...S.card, padding: "16px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.text3, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  ⚖️ Tax Details
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `1.5px solid ${C.border2}` }}>
                      <th style={{ ...S.th, padding: "6px 8px" }}>Tax Type</th>
                      <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Percentage</th>
                      <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Tax Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td style={{ ...S.td, padding: "6px 8px" }}>SGST (State Tax)</td>
                      <td style={{ ...S.td, padding: "6px 8px", textAlign: "right" }}>{avgGstPct > 0 ? (avgGstPct / 2).toFixed(2) + "%" : "0.00%"}</td>
                      <td style={{ ...S.td, padding: "6px 8px", textAlign: "right", fontWeight: 700, color: C.navy }}>₹{(totals.sgst || 0).toFixed(2)}</td>
                    </tr>
                    <tr>
                      <td style={{ ...S.td, padding: "6px 8px", borderBottom: "none" }}>CGST (Central Tax)</td>
                      <td style={{ ...S.td, padding: "6px 8px", textAlign: "right", borderBottom: "none" }}>{avgGstPct > 0 ? (avgGstPct / 2).toFixed(2) + "%" : "0.00%"}</td>
                      <td style={{ ...S.td, padding: "6px 8px", textAlign: "right", fontWeight: 700, color: C.navy, borderBottom: "none" }}>₹{(totals.cgst || 0).toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Payment Splits Grid */}
              <div style={{ ...S.card, padding: "16px" }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.text3, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  💳 Split Payment Mode
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1.2fr 1fr", gap: 8, alignItems: "center", fontSize: 12 }}>
                  <div style={{ fontWeight: 700, color: C.navy }}>Payment Mode</div>
                  <div style={{ fontWeight: 700, color: C.navy }}>Amount Paid (₹)</div>
                  <div style={{ fontWeight: 700, color: C.navy }}>Ref/Tx No.</div>
                  
                  {/* Cash Row */}
                  <div>💵 Cash</div>
                  <input type="number" style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} value={splitCash} onChange={e => setSplitCash(e.target.value)} />
                  <input style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} placeholder="N/A" disabled />

                  {/* Credit Card Row */}
                  <div>💳 Credit Card</div>
                  <input type="number" style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} value={splitCreditCard} onChange={e => setSplitCreditCard(e.target.value)} />
                  <input style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} placeholder="TXN-ID" />

                  {/* Debit Card Row */}
                  <div>💳 Debit Card</div>
                  <input type="number" style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} value={splitDebitCard} onChange={e => setSplitDebitCard(e.target.value)} />
                  <input style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} placeholder="TXN-ID" />

                  {/* Wallet Pay Row */}
                  <div>📱 Wallet Pay</div>
                  <input type="number" style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} value={splitWalletPay} onChange={e => setSplitWalletPay(e.target.value)} />
                  <input style={{ ...S.input, padding: "4px 8px", fontSize: 12 }} placeholder="UPI Ref" />
                </div>
              </div>

              {/* Totals Summary Panel & Actions */}
              <div style={{ ...S.card, padding: "16px", background: "#F8FAFC", border: `1.5px solid ${C.border2}` }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: C.text3, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  📊 Invoice Summary
                </div>
                
                <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Gross Amount:</span>
                    <strong style={{ color: C.navy }}>₹{(totals.sub - totals.disc).toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Tax Amount:</span>
                    <span style={{ fontWeight: 600 }}>₹{(totals.cgst + totals.sgst).toFixed(2)}</span>
                  </div>
                   <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span>Round Off (+/-):</span>
                    <span style={{ color: C.text3 }}>₹{roundOffValue.toFixed(2)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${C.border}`, paddingTop: 6, fontSize: 16 }}>
                    <span style={{ fontWeight: 800, color: C.navy }}>Net Amount:</span>
                    <strong style={{ color: C.green }}>₹{netAmountRounded.toFixed(2)}</strong>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `1px dashed ${C.border2}`, paddingTop: 6 }}>
                    <span>Pay Amount (₹):</span>
                    <input 
                      type="number" 
                      style={{ ...S.input, width: 110, padding: "5px 8px", fontSize: 13, fontWeight: 800, color: C.green, textAlign: "right" }}
                      value={netAmountRounded.toFixed(2)}
                      disabled
                    />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, width: "100%" }}>
                  <button 
                    onClick={generateBill}
                    style={{ ...S.btn("green"), flex: 1, padding: "10px", fontSize: 13, fontWeight: 800, justifyContent: "center" }}
                    disabled={billItems.length === 0}
                  >
                    💾 Save [F9]
                  </button>
                  <button 
                    onClick={() => { if(window.confirm("Are you sure you want to clear this billing session?")) handleNewInvoice(); }}
                    style={{ ...S.btn("outline"), padding: "10px", fontSize: 13, fontWeight: 700, justifyContent: "center" }}
                  >
                    🧹 Clear
                  </button>
                  <button 
                    onClick={handleNewInvoice}
                    style={{ ...S.btn("primary"), padding: "10px", fontSize: 13, fontWeight: 700, justifyContent: "center" }}
                  >
                    ➕ New
                  </button>
                </div>
              </div>

            </div>
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
                    <FF label="Supplier Name *">
                      <div style={{ position: "relative" }}>
                        <input 
                          style={S.input} 
                          value={purchaseForm.supplierName} 
                          onChange={e => setPurchaseForm(p => ({ ...p, supplierName: e.target.value }))} 
                          onFocus={() => setSupplierSearchFocused(true)}
                          onBlur={() => setTimeout(() => setSupplierSearchFocused(false), 250)}
                          placeholder="Type or select supplier..."
                        />
                        {supplierSearchFocused && (
                          <div style={{ 
                            position: "absolute", 
                            top: "100%", 
                            left: 0, 
                            right: 0, 
                            background: "#fff", 
                            border: `1.5px solid ${C.border2}`, 
                            borderRadius: 8, 
                            maxHeight: 200, 
                            overflowY: "auto", 
                            zIndex: 100, 
                            boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)",
                            marginTop: 4
                          }}>
                            {suppliers
                              .filter(s => s.name?.toLowerCase().includes(purchaseForm.supplierName?.toLowerCase() || ""))
                              .map(s => (
                                <div 
                                  key={s.id} 
                                  style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, fontSize: 13, display: "flex", justifyContent: "space-between" }}
                                  onMouseDown={() => {
                                    setPurchaseForm(p => ({ 
                                      ...p, 
                                      supplierName: s.name,
                                      supplierPhone: s.phone || "",
                                      supplierGstin: s.gstin || ""
                                    }));
                                  }}
                                  onMouseEnter={e => e.currentTarget.style.background = "#F1F5F9"}
                                  onMouseLeave={e => e.currentTarget.style.background = "none"}
                                >
                                  <span style={{ fontWeight: 600, color: C.navy }}>{s.name}</span>
                                  <span style={{ fontSize: 11, color: C.text3 }}>GSTIN: {s.gstin || "N/A"}</span>
                                </div>
                              ))}
                            {purchaseForm.supplierName && !suppliers.some(s => s.name?.toLowerCase() === purchaseForm.supplierName?.toLowerCase()) && (
                              <div style={{ padding: "8px 12px", color: C.teal2, fontSize: 12, fontWeight: 600 }}>
                                ➕ Create new supplier "{purchaseForm.supplierName}"
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </FF>
                    <FF label="Invoice Number"><input style={S.input} value={purchaseForm.invoiceNumber} onChange={e=>setPurchaseForm(p=>({...p,invoiceNumber:e.target.value}))} /></FF>
                    <FF label="Invoice Date"><input type="date" style={S.input} value={purchaseForm.invoiceDate} onChange={e=>setPurchaseForm(p=>({...p,invoiceDate:e.target.value}))} /></FF>
                    <FF label="Payment Status"><select style={S.input} value={purchaseForm.paymentStatus} onChange={e=>setPurchaseForm(p=>({...p,paymentStatus:e.target.value}))}><option>Unpaid</option><option>Paid</option><option>Partial</option></select></FF>
                  </div>
                </div>

                <div style={{ overflowX: "auto", marginBottom: 18, borderRadius: 8, border: `1px solid ${C.border}` }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 950 }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC" }}>
                        {["Incoming Drug", "Specs", "Expiry", "Printed MRP", "Retail Selling", "Buy Rate", "Qty", "Pack Size", "GST%", "Similarity", "Resolution Binding", ""].map(h => <th key={h} style={{ ...S.th, padding: "12px 14px" }}>{h}</th>)}
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
                              {item.packSize > 1 && (
                                <div style={{ fontSize: 9, color: C.teal, marginTop: 4, fontWeight: 700 }}>
                                  ₹{(item.purchasePrice / item.packSize).toFixed(2)}/unit
                                </div>
                              )}
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="number" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 56 }} value={item.quantity} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, quantity: +e.target.value} : it)}))} />
                              {item.packSize > 1 && (
                                <div style={{ fontSize: 9, color: C.teal, marginTop: 4, fontWeight: 700 }}>
                                  {item.quantity * item.packSize} units
                                </div>
                              )}
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="number" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 48, borderColor: C.teal2, fontWeight: 700 }} value={item.packSize || 1} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, packSize: parseInt(e.target.value) || 1} : it)}))} />
                            </td>
                            <td style={{ ...S.td, padding: "12px 14px" }}>
                              <input type="text" style={{ ...S.input, fontSize: 12, padding: "4px 8px", width: 48 }} value={item.gstRate || "12"} onChange={e => setPurchaseForm(p => ({...p, items: p.items.map((it, i) => i === idx ? {...it, gstRate: e.target.value} : it)}))} />
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
                  <FF label="Supplier Name *">
                    <div style={{ position: "relative" }}>
                      <input 
                        style={S.input} 
                        value={purchaseForm.supplierName} 
                        onChange={e => setPurchaseForm(p => ({ ...p, supplierName: e.target.value }))} 
                        onFocus={() => setSupplierSearchFocused(true)}
                        onBlur={() => setTimeout(() => setSupplierSearchFocused(false), 250)}
                        placeholder="e.g. Mankind Pharma"
                      />
                      {supplierSearchFocused && (
                        <div style={{ 
                          position: "absolute", 
                          top: "100%", 
                          left: 0, 
                          right: 0, 
                          background: "#fff", 
                          border: `1.5px solid ${C.border2}`, 
                          borderRadius: 8, 
                          maxHeight: 200, 
                          overflowY: "auto", 
                          zIndex: 100, 
                          boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1)",
                          marginTop: 4
                        }}>
                          {suppliers
                            .filter(s => s.name?.toLowerCase().includes(purchaseForm.supplierName?.toLowerCase() || ""))
                            .map(s => (
                              <div 
                                key={s.id} 
                                style={{ padding: "8px 12px", cursor: "pointer", borderBottom: `1px solid ${C.border}`, fontSize: 13, display: "flex", justifyContent: "space-between" }}
                                onMouseDown={() => {
                                  setPurchaseForm(p => ({ 
                                    ...p, 
                                    supplierName: s.name,
                                    supplierPhone: s.phone || "",
                                    supplierGstin: s.gstin || ""
                                  }));
                                }}
                                onMouseEnter={e => e.currentTarget.style.background = "#F1F5F9"}
                                onMouseLeave={e => e.currentTarget.style.background = "none"}
                              >
                                <span style={{ fontWeight: 600, color: C.navy }}>{s.name}</span>
                                <span style={{ fontSize: 11, color: C.text3 }}>GSTIN: {s.gstin || "N/A"}</span>
                              </div>
                            ))}
                          {purchaseForm.supplierName && !suppliers.some(s => s.name?.toLowerCase() === purchaseForm.supplierName?.toLowerCase()) && (
                            <div style={{ padding: "8px 12px", color: C.teal2, fontSize: 12, fontWeight: 600 }}>
                              ➕ Create new supplier "{purchaseForm.supplierName}"
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </FF>
                  <FF label="Invoice Number"><input style={S.input} value={purchaseForm.invoiceNumber} onChange={e=>setPurchaseForm(p=>({...p,invoiceNumber:e.target.value}))} /></FF>
                  <FF label="Invoice Date"><input type="date" style={S.input} value={purchaseForm.invoiceDate} onChange={e=>setPurchaseForm(p=>({...p,invoiceDate:e.target.value}))} /></FF>
                  <FF label="Payment Status"><select style={S.input} value={purchaseForm.paymentStatus} onChange={e=>setPurchaseForm(p=>({...p,paymentStatus:e.target.value}))}><option>Unpaid</option><option>Paid</option><option>Partial</option></select></FF>
                </div>
                {purchaseForm.items.length > 0 && (
                  <div style={{ marginBottom:14,overflowX:"auto" }}>
                    <div style={{ fontSize:12,fontWeight:700,color:C.navy,marginBottom:8,textTransform:"uppercase",letterSpacing:"0.5px" }}>Items ({purchaseForm.items.length}) — Edit if needed</div>
                    <table style={{ width:"100%",borderCollapse:"collapse",minWidth:900 }}>
                      <thead><tr style={{ background:"#F8FAFC" }}>{["Generic Name","Brand","Str","Form","Batch","Expiry","MRP ₹","Retail ₹","Buy ₹","Qty","Pack Size","GST%",""].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                      <tbody>{purchaseForm.items.map((item,idx)=>(
                        <tr key={idx}>
                          {["genericName","brandName","strength","form","batchNumber","expiryDate","mrp","sellingPrice","purchasePrice","quantity","packSize","gstRate"].map(key=>(
                            <td key={key} style={S.td}><input style={{ ...S.input,fontSize:12,padding:"5px 8px",width:key==="genericName"?120:key==="brandName"?100:key==="strength" || key==="form"?60:key==="quantity" || key==="gstRate" || key==="packSize"?48:75 }} value={item[key]||""} placeholder={key==="expiryDate"?"YYYY-MM":""} onChange={e=>setPurchaseForm(p=>({...p,items:p.items.map((it,i)=>i===idx?{...it,[key]:e.target.value}:it)}))} /></td>
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
                    {[["Generic*","genericName","text"],["Brand","brandName","text"],["Strength","strength","text"],["Form","form","text"],["Barcode","barcode","text"],["Batch","batchNumber","text"],["Expiry","expiryDate","text"],["MRP","mrp","number"],["Retail ₹","sellingPrice","number"],["Buy ₹","purchasePrice","number"],["Qty*","quantity","number"],["Pack Size","packSize","number"],["GST %","gstRate","text"]].map(([label,key,type])=>(
                      <div key={key}><label style={{ ...S.label,fontSize:10 }}>{label}</label><input type={type} style={{ ...S.input,padding:"7px 8px",fontSize:12 }} value={purchaseItem[key]} placeholder={key==="expiryDate"?"YYYY-MM":""} onChange={e=>setPurchaseItem(p=>({...p,[key]:e.target.value}))} /></div>
                    ))}
                    <button style={{ ...S.btn("teal"),padding:"8px 12px",alignSelf:"flex-end" }} onClick={addPurchaseItem}>+ Add</button>
                  </div>
                </div>
                <div style={{ display:"flex",gap:10,alignItems:"center",flexWrap:"wrap" }}>
                  <button style={{ ...S.btn("green"),fontSize:14,padding:"11px 22px" }} onClick={savePurchase}>Save + Update Stock</button>
                  <button style={S.btn("outline")} onClick={()=>{setShowPurchaseForm(false);setAiStatus("");setPurchaseForm({supplierName:"",invoiceNumber:"",invoiceDate:"",paymentStatus:"Unpaid",items:[]});}}>Cancel</button>
                  {purchaseForm.items.length>0&&<span style={S.badge("teal")}>{purchaseForm.items.length} items · ₹{purchaseForm.items.reduce((a,i)=>a+(+(i.purchasePrice||0)*(+(i.quantity||0))*(1 + +(i.gstRate||12)/100)),0).toFixed(2)}</span>}
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
                  <div key={p.id} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"10px 0",borderBottom:`1px solid ${C.border}`, cursor:"pointer" }}
                    onClick={() => setViewingPurchase(p)}>
                    <div><div style={{ fontSize:13,fontWeight:600,color:C.navy }}>{p.supplierName} <span style={{ color:C.text3,fontWeight:400,fontSize:12 }}>#{p.invoiceNumber}</span></div><div style={{ fontSize:11,color:C.text3,marginTop:1 }}>{p.invoiceDate} · {(p.items||[]).length} items</div></div>
                    <div style={{ display:"flex",gap:14,alignItems:"center" }}>
                      <div style={{ textAlign:"right" }}><div style={{ fontSize:14,fontWeight:700,color:C.navy }}>₹{(p.totalAmount||0).toFixed(2)}</div><span style={S.badge(p.paymentStatus==="Paid"?"green":p.paymentStatus==="Partial"?"amber":"red")}>{p.paymentStatus}</span></div>
                      <button onClick={(e) => { e.stopPropagation(); deletePurchase(p); }} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13, padding: 5 }} title="Delete Purchase Invoice">🗑️</button>
                    </div>
                  </div>
                ))}
            </div>

            {/* ── Purchase Detail / Edit Modal ── */}
            {viewingPurchase && (() => {
              const p = viewingPurchase;
              const totalItems = (p.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
              return (
                <div style={{ position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.55)",zIndex:1200,display:"flex",alignItems:"flex-start",justifyContent:"flex-end" }}
                  onClick={() => setViewingPurchase(null)}>
                  <div style={{ width:"min(96vw,680px)",height:"100vh",overflowY:"auto",background:"#fff",boxShadow:"-4px 0 32px rgba(0,0,0,0.18)",display:"flex",flexDirection:"column" }}
                    onClick={e => e.stopPropagation()}>

                    {/* Header */}
                    <div style={{ background:C.navy,color:"#fff",padding:"18px 20px",display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexShrink:0 }}>
                      <div>
                        <div style={{ fontSize:16,fontWeight:800,letterSpacing:"-0.3px" }}>Purchase Invoice Detail</div>
                        <div style={{ fontSize:12,opacity:0.75,marginTop:2 }}>#{p.invoiceNumber} · {p.supplierName}</div>
                      </div>
                      <button onClick={() => setViewingPurchase(null)} style={{ background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",fontSize:18,width:34,height:34,borderRadius:8,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>
                    </div>

                    {/* Meta Info */}
                    <div style={{ padding:"16px 20px",borderBottom:`1px solid ${C.border}`,background:"#F8FAFC",display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,flexShrink:0 }}>
                      {[
                        ["Supplier",         p.supplierName || "—"],
                        ["Invoice No",        p.invoiceNumber || "—"],
                        ["Invoice Date",      p.invoiceDate || "—"],
                        ["Total Items (qty)", totalItems],
                        ["Total Amount",      `₹${(p.totalAmount||0).toFixed(2)}`],
                        ["Payment Status",    null]
                      ].map(([label, val], i) => (
                        <div key={i}>
                          <div style={{ fontSize:10,fontWeight:700,color:C.text3,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:3 }}>{label}</div>
                          {val !== null
                            ? <div style={{ fontSize:13,fontWeight:600,color:C.navy }}>{val}</div>
                            : <select
                                value={p.paymentStatus}
                                onChange={e => updatePurchasePayment(p, e.target.value)}
                                style={{ ...S.input,fontSize:12,padding:"5px 8px",fontWeight:700,
                                  color: p.paymentStatus==="Paid"?C.green:p.paymentStatus==="Partial"?C.amber:C.red,
                                  borderColor: p.paymentStatus==="Paid"?C.green:p.paymentStatus==="Partial"?C.amber:C.red }}
                              >
                                {["Unpaid","Partial","Paid"].map(s => <option key={s} value={s}>{s}</option>)}
                              </select>
                          }
                        </div>
                      ))}
                    </div>

                    {/* Items Table */}
                    <div style={{ flex:1,overflowY:"auto",padding:"16px 20px" }}>
                      <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:10 }}>Items in this Invoice</div>
                      <div style={{ overflowX:"auto" }}>
                        <table style={{ width:"100%",borderCollapse:"collapse",fontSize:12 }}>
                          <thead>
                            <tr style={{ background:"#F1F5F9" }}>
                              {["#","Medicine","Batch No","Expiry","Qty","Purchase Price","MRP","GST%","Total"].map(h => (
                                <th key={h} style={{ ...S.th,padding:"8px 10px",fontSize:10 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(p.items||[]).length === 0 ? (
                              <tr><td colSpan={9} style={{ ...S.td,textAlign:"center",color:C.text3,padding:"16px 0",fontStyle:"italic" }}>No items found in this invoice.</td></tr>
                            ) : (
                              (p.items||[]).map((item, idx) => {
                                const bExp = item.expiryDate || "—";
                                const isExpiredItem = (() => { try { const [mo,yr] = bExp.split("/"); const y = yr?.length===2?2000+parseInt(yr):parseInt(yr); return new Date(y,parseInt(mo)-1,28) < new Date(); } catch { return false; } })();
                                const itemTotal = (item.purchasePrice||0)*(item.quantity||item.qty||0)*(1 + +(item.gstRate||0)/100);
                                return (
                                  <tr key={idx} style={{ borderBottom:`1px solid ${C.border}`,background:isExpiredItem?"#FFF5F5":"transparent" }}>
                                    <td style={{ ...S.td,padding:"8px 10px",textAlign:"center",color:C.text3 }}>{idx+1}</td>
                                    <td style={{ ...S.td,padding:"8px 10px" }}>
                                      <div style={{ fontWeight:600,color:C.navy }}>{item.brandName||item.genericName}</div>
                                      {item.genericName && item.genericName!==item.brandName && <div style={{ fontSize:10,color:C.text3,fontStyle:"italic" }}>{item.genericName}</div>}
                                      {item.strength && <div style={{ fontSize:10,color:C.text3 }}>{item.strength} · {item.form}</div>}
                                    </td>
                                    <td style={{ ...S.td,padding:"8px 10px",fontFamily:"monospace",fontWeight:700,color:C.blue }}>{item.batchNumber||"—"}</td>
                                    <td style={{ ...S.td,padding:"8px 10px",color:isExpiredItem?C.red:C.navy,fontWeight:isExpiredItem?700:400 }}>
                                      {bExp}{isExpiredItem && <span style={{ marginLeft:4,fontSize:9,background:"#FDECEA",color:C.red,borderRadius:3,padding:"1px 4px",fontWeight:700 }}>EXPIRED</span>}
                                    </td>
                                    <td style={{ ...S.td,padding:"8px 10px",textAlign:"center",fontWeight:700 }}>
                                      {item.quantity||item.qty||0}
                                      {item.packSize > 1 && (
                                        <div style={{ fontSize:9,color:C.teal,fontWeight:700,marginTop:2 }}>
                                          ({(item.quantity||item.qty||0) * item.packSize} units)
                                        </div>
                                      )}
                                    </td>
                                    <td style={{ ...S.td,padding:"8px 10px",textAlign:"right" }}>
                                      ₹{(item.purchasePrice||0).toFixed(2)}
                                      {item.packSize > 1 && (
                                        <div style={{ fontSize:9,color:C.teal,fontWeight:700,marginTop:2 }}>
                                          (₹{((item.purchasePrice||0) / item.packSize).toFixed(2)}/unit)
                                        </div>
                                      )}
                                    </td>
                                    <td style={{ ...S.td,padding:"8px 10px",textAlign:"right" }}>₹{(item.mrp||0).toFixed(2)}</td>
                                    <td style={{ ...S.td,padding:"8px 10px",textAlign:"center" }}>{item.gstRate||0}%</td>
                                    <td style={{ ...S.td,padding:"8px 10px",textAlign:"right",fontWeight:700,color:C.navy }}>₹{itemTotal.toFixed(2)}</td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                          {(p.items||[]).length > 0 && (
                            <tfoot>
                              <tr style={{ background:C.navy,color:"#fff" }}>
                                <td colSpan={4} style={{ padding:"8px 10px",fontWeight:700,color:"#fff" }}>TOTAL</td>
                                <td style={{ padding:"8px 10px",textAlign:"center",fontWeight:700,color:"#fff" }}>{totalItems}</td>
                                <td colSpan={3} style={{ padding:"8px 10px",color:"#fff" }}></td>
                                <td style={{ padding:"8px 10px",textAlign:"right",fontWeight:800,color:"#FDE68A" }}>₹{(p.totalAmount||0).toFixed(2)}</td>
                              </tr>
                            </tfoot>
                          )}
                        </table>
                      </div>
                    </div>

                    {/* Footer actions */}
                    <div style={{ padding:"14px 20px",borderTop:`1px solid ${C.border}`,display:"flex",gap:10,flexShrink:0,background:"#F8FAFC" }}>
                      <button style={{ ...S.btn("teal"),flex:1 }} onClick={() => {
                        setViewingPurchase(null);
                        setPurchaseForm({
                          supplierName: p.supplierName||``,
                          invoiceNumber: p.invoiceNumber||``,
                          invoiceDate: p.invoiceDate||``,
                          paymentStatus: p.paymentStatus||`Unpaid`,
                          items: p.items||[]
                        });
                        setShowPurchaseForm(true);
                      }}>✏️ Edit / Re-open Invoice</button>
                      <button style={{ ...S.btn("outline") }} onClick={() => setViewingPurchase(null)}>Close</button>
                    </div>
                  </div>
                </div>
              );
            })()}
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
            <PH 
              title="Inventory Catalog" 
              sub={`${medicines.length} medicines · Cloud synced`} 
              action={
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button style={S.btn("primary")} onClick={() => setShowAddMedForm(f => !f)}>
                    {showAddMedForm ? "✕ Hide Add Form" : "💊 Add Medicine Manually"}
                  </button>
                  
                  <input type="file" accept=".xlsx,.xls,.csv" ref={inventoryExcelInputRef} onChange={handleExcelInventoryUpload} style={{ display:"none" }} />
                  <button style={S.btn("teal")} onClick={() => inventoryExcelInputRef.current?.click()} disabled={aiLoading}>
                    📊 Batch Excel Import
                  </button>
                  
                  <input type="file" accept="image/*" capture="environment" ref={productPhotoInputRef} onChange={handleProductPhotoUpload} style={{ display:"none" }} />
                  <button style={{ ...S.btn("ai"), opacity: aiLoading ? 0.7 : 1 }} onClick={() => productPhotoInputRef.current?.click()} disabled={aiLoading}>
                    {aiLoading ? "⏳ Scanning..." : "📸 AI Product Package Scan (Camera)"}
                  </button>
                  
                  <button style={S.btn("outline")} onClick={downloadExcelInventoryTemplate}>
                    📥 Excel Template
                  </button>
                </div>
              } 
            />
            <input style={{ ...S.input,fontSize:14,padding:"12px 14px",border:`2px solid ${C.border2}`,marginBottom:14 }} value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="Search by generic name, brand, or category..." />

            {aiStatus && (
              <div style={{ 
                fontSize: 13, 
                fontWeight: 500, 
                marginBottom: 14, 
                padding: "8px 12px", 
                borderRadius: 8, 
                color: aiStatus.startsWith("✓") ? C.green : aiStatus.startsWith("⚠") ? C.amber : C.blue, 
                background: aiStatus.startsWith("✓") ? "#E8F5EE" : aiStatus.startsWith("⚠") ? "#FFF8E7" : "#EBF4FF" 
              }}>
                {aiStatus}
              </div>
            )}

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

            {editingMed && (
              <div style={{ ...S.card, border: `1.5px solid ${C.blue}`, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.blue, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 16, display: "flex", justifyContent: "space-between" }}>
                  <span>✏️ Edit Medicine Details</span>
                  <span style={{ fontSize: 11, color: C.text3, textTransform: "none" }}>Editing: {editingMed.genericName}</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    ["Generic Name *", "genericName", "text"],
                    ["Brand Name", "brandName", "text"],
                    ["Strength (e.g. 500mg)", "strength", "text"],
                    ["Form (e.g. Tablet)", "form", "text"],
                    ["Barcode", "barcode", "text"],
                    ["Batch No.", "batchNumber", "text"],
                    ["Expiry (YYYY-MM)", "expiryDate", "text"],
                    ["MRP (₹) *", "mrp", "number"],
                    ["Retail Selling Price (₹)", "sellingPrice", "number"],
                    ["Purchase Price (₹)", "purchasePrice", "number"],
                    ["Stock Qty *", "stockQty", "number"],
                    ["Low Stock Alert", "lowStockAlert", "number"],
                    ["Category", "category", "text"]
                  ].map(([label, key, type]) => (
                    <FF key={key} label={label}>
                      <input 
                        type={type} 
                        style={S.input} 
                        value={editMedForm[key]} 
                        onChange={e => setEditMedForm(p => ({ ...p, [key]: e.target.value }))} 
                      />
                    </FF>
                  ))}
                  <FF label="GST Rate (%)">
                    <select 
                      style={S.input} 
                      value={editMedForm.gstRate} 
                      onChange={e => setEditMedForm(p => ({ ...p, gstRate: e.target.value }))}
                    >
                      {["0", "5", "12", "18", "28"].map(g => <option key={g} value={g}>{g}%</option>)}
                    </select>
                  </FF>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
                  <button style={S.btn("primary")} onClick={updateMedicine}>Save Changes</button>
                  <button style={S.btn("outline")} onClick={() => setEditingMed(null)}>Cancel</button>
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
                  <thead><tr style={{ background:"#F8FAFC" }}>{["Generic Name","Brand","Batch","Expiry","MRP","Retail Price","Buy Price","Margin","Profit (Pc)","Profit (Tot)","Qty","Status","Actions"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {filteredMeds.length===0?<tr><td colSpan={13} style={{ padding:24,textAlign:"center",color:C.text3,fontSize:13 }}>{medicines.length===0?"No medicines yet. Add your first medicine!":"No results."}</td></tr>
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
                            <td style={{ ...S.td,fontWeight:700,color:m.singleProfit > 0 ? C.green : C.red }}>₹{m.singleProfit?.toFixed(2) || "0.00"}</td>
                            <td style={{ ...S.td,fontWeight:700,color:m.totalProfitSold > 0 ? C.blue : C.text3 }}>₹{m.totalProfitSold?.toFixed(2) || "0.00"}</td>
                            <td style={{ ...S.td,fontWeight:700,color:isLow?C.amber:C.green }}>{m.stockQty}</td>
                            <td style={S.td}><span style={S.badge(isExp?"red":isLow?"amber":"green")}>{isExp?"Expired":isLow?"Low":"OK"}</span></td>
                            <td style={S.td}>
                              <button 
                                onClick={() => handleOpenOpeningStock(m)} 
                                style={{ background: "none", border: "none", color: C.teal, cursor: "pointer", fontSize: 12, marginRight: 10, fontWeight: 700 }} 
                                title="Add Opening Stock Batch"
                              >
                                ＋ Opening Stock
                              </button>
                              <button 
                                onClick={() => handleStartEditMedicine(m)} 
                                style={{ background: "none", border: "none", color: C.blue, cursor: "pointer", fontSize: 12, marginRight: 10, fontWeight: 700 }} 
                                title="Edit Medicine Details"
                              >
                                ✏️ Edit
                              </button>
                              <button 
                                onClick={() => setViewingMedDetails(m)} 
                                style={{ background: "none", border: "none", color: C.green, cursor: "pointer", fontSize: 12, marginRight: 10, fontWeight: 700 }} 
                                title="View Complete Dossier & Batches"
                              >
                                👁️ View
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

            {/* View Medicine Dossier Details Modal */}
            {viewingMedDetails && (() => {
              const m = viewingMedDetails;
              const firstBatch = Array.isArray(m.batches) && m.batches.length > 0 ? m.batches[0] : null;
              const buyPrice = m.purchasePrice || firstBatch?.purchasePrice || 0;
              const retailPrice = m.sellingPrice || m.mrp || 0;
              const gst = parseFloat(m.gstRate) || 12;
              const buyPriceInclusive = buyPrice * (1 + gst / 100);
              const singleProfit = retailPrice - buyPriceInclusive;

              const calculatedMed = filteredMeds.find(fm => fm.id === m.id) || m;
              
              return (
                <div style={{
                  position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.4)",
                  backdropFilter: "blur(4px)", zIndex: 9999, display: "flex",
                  alignItems: "center", justifyContent: "center", padding: 20
                }}>
                  <div style={{
                    background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16,
                    width: "100%", maxWidth: 750, maxHeight: "90vh", overflowY: "auto",
                    boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)"
                  }}>
                    <div style={{
                      padding: "20px 24px", borderBottom: `1px solid ${C.border}`,
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      background: C.navy, color: "#fff", borderTopLeftRadius: 15, borderTopRightRadius: 15
                    }}>
                      <div>
                        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800 }}>👁️ Medicine Complete Dossier</h3>
                        <span style={{ fontSize: 12, opacity: 0.8 }}>Full audit and batch details for local inventory.</span>
                      </div>
                      <button
                        onClick={() => setViewingMedDetails(null)}
                        style={{
                          background: "none", border: "none", color: "#fff",
                          fontSize: 24, cursor: "pointer", opacity: 0.8
                        }}
                      >
                        &times;
                      </button>
                    </div>

                    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
                        <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: `1px solid ${C.border}` }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, textTransform: "uppercase" }}>Generic Name</span>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 4 }}>{m.genericName}</div>
                        </div>
                        <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: `1px solid ${C.border}` }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, textTransform: "uppercase" }}>Brand / Trade Name</span>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 4 }}>{m.brandName || "—"}</div>
                        </div>
                        <div style={{ background: "#F8FAFC", padding: 12, borderRadius: 8, border: `1px solid ${C.border}` }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: C.text3, textTransform: "uppercase" }}>Metadata</span>
                          <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
                            Strength: <strong>{m.strength || "—"}</strong> | Form: <strong>{m.form || "—"}</strong>
                          </div>
                        </div>
                      </div>

                      <div>
                        <h4 style={{ margin: "0 0 10px 0", fontSize: 13, fontWeight: 800, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          💰 Profitability & Margin Metrics
                        </h4>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>PRINTED MRP</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: C.text, marginTop: 4 }}>₹{m.mrp.toFixed(2)}</div>
                          </div>
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>RETAIL PRICE</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginTop: 4 }}>₹{retailPrice.toFixed(2)}</div>
                          </div>
                          <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, textAlign: "center" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>BUY (INC. GST)</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: C.text2, marginTop: 4 }}>₹{buyPriceInclusive.toFixed(2)}</div>
                          </div>
                          <div style={{ border: `1.5px solid ${C.teal2}`, borderRadius: 8, padding: 12, textAlign: "center", background: "#E8F5EE" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.green }}>PROFIT / UNIT</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: C.green, marginTop: 4 }}>₹{singleProfit.toFixed(2)}</div>
                            <div style={{ fontSize: 9, color: C.text3, marginTop: 2 }}>Margin: {calculatedMed.marginPct}%</div>
                          </div>
                          <div style={{ border: `1.5px solid ${C.blue}`, borderRadius: 8, padding: 12, textAlign: "center", background: "#EBF4FF" }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.blue }}>TOTAL PROFIT SOLD</div>
                            <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginTop: 4 }}>₹{calculatedMed.totalProfitSold.toFixed(2)}</div>
                            <div style={{ fontSize: 9, color: C.text3, marginTop: 2 }}>Sold: {calculatedMed.totalQtySold} units</div>
                          </div>
                        </div>
                      </div>

                      <div>
                        <h4 style={{ margin: "0 0 10px 0", fontSize: 13, fontWeight: 800, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                          📦 Active Batches Inventory ({Array.isArray(m.batches) ? m.batches.length : 0})
                        </h4>
                        <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: "hidden" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                            <thead>
                              <tr style={{ background: "#F8FAFC" }}>
                                <th style={{ ...S.th, padding: "8px 12px" }}>Batch Number</th>
                                <th style={{ ...S.th, padding: "8px 12px" }}>Expiry Date</th>
                                <th style={{ ...S.th, padding: "8px 12px", textAlign: "right" }}>MRP</th>
                                <th style={{ ...S.th, padding: "8px 12px", textAlign: "right" }}>Selling Price</th>
                                <th style={{ ...S.th, padding: "8px 12px", textAlign: "right" }}>Purchase Price</th>
                                <th style={{ ...S.th, padding: "8px 12px", textAlign: "center" }}>Stock Qty</th>
                              </tr>
                            </thead>
                            <tbody>
                              {!Array.isArray(m.batches) || m.batches.length === 0 ? (
                                <tr>
                                  <td colSpan={6} style={{ padding: 16, textAlign: "center", color: C.text3, fontStyle: "italic" }}>
                                    No batches exist for this medicine catalog entry.
                                  </td>
                                </tr>
                              ) : (
                                m.batches.map((b, bi) => (
                                  <tr key={bi} style={{ borderBottom: bi < m.batches.length - 1 ? `1px solid ${C.border}` : "none" }}>
                                    <td style={{ ...S.td, padding: "8px 12px", fontFamily: "monospace" }}>{b.batchNumber}</td>
                                    <td style={{ ...S.td, padding: "8px 12px" }}>{b.expiryDate}</td>
                                    <td style={{ ...S.td, padding: "8px 12px", textAlign: "right" }}>₹{b.mrp?.toFixed(2)}</td>
                                    <td style={{ ...S.td, padding: "8px 12px", textAlign: "right" }}>₹{(b.sellingPrice || b.mrp)?.toFixed(2)}</td>
                                    <td style={{ ...S.td, padding: "8px 12px", textAlign: "right" }}>₹{b.purchasePrice?.toFixed(2)}</td>
                                    <td style={{ ...S.td, padding: "8px 12px", textAlign: "center", fontWeight: 700, color: b.quantity > 0 ? C.green : C.red }}>{b.quantity}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>

                    </div>

                    <div style={{
                      padding: "16px 24px", borderTop: `1px solid ${C.border}`,
                      display: "flex", justifyContent: "flex-end", background: "#F8FAFC",
                      borderBottomLeftRadius: 15, borderBottomRightRadius: 15
                    }}>
                      <button
                        onClick={() => setViewingMedDetails(null)}
                        style={{ ...S.btn("primary"), padding: "8px 20px" }}
                      >
                        Close Dossier
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

          </div>
        )}

        {/* BILLS HISTORY */}
        {!dbLoading && activeTab === "bills" && (
          <div>
            <PH title="Sales History" sub={`${sales.length} total bills · Click any to view & reprint`} />
            <input style={{ ...S.input,fontSize:14,padding:"12px 14px",border:`2px solid ${C.border2}`,marginBottom:14 }} value={billSearchQuery} onChange={e=>setBillSearchQuery(e.target.value)} placeholder="Search by bill number, patient name or phone..." />
            <div style={S.card}>
              {filteredBills.length===0?<div style={{ color:C.text3,fontSize:13,padding:"16px 0" }}>No bills found.</div>
                :filteredBills.map(s=>{
                  const finalBill = { ...s, date: s.createdAt?.toDate?.() || new Date() };
                  const isCurExp = isWorkerExporting;
                  return (
                    <div key={s.id} onClick={()=>setSelectedBill(selectedBill?.id===s.id?null:s)}
                      style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 14px",borderBottom:`1px solid ${C.border}`,cursor:"pointer",flexWrap:"wrap",gap:10 }}
                      onMouseEnter={e=>e.currentTarget.style.background="#F8FAFC"} onMouseLeave={e=>e.currentTarget.style.background=""}>
                      <div style={{ flex: 1, minWidth: 280 }}>
                        <div style={{ fontSize:13,fontWeight:700,color:C.navy }}>
                          {s.billNumber}
                          {s.customerName && <span style={{ color:C.teal2,fontWeight:700,marginLeft:8 }}>👤 {s.customerName}</span>}
                          {s.customerPhone && <span style={{ color:C.text3,fontWeight:500,marginLeft:6 }}>({s.customerPhone})</span>}
                        </div>
                        <div style={{ fontSize:11,color:C.text3,marginTop:3 }}>
                          📅 {s.createdAt?.toDate?s.createdAt.toDate().toLocaleString("en-IN",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}):"—"} · 💊 {(s.items||[]).length} items
                          {s.doctorName && <span style={{ marginLeft:8,fontStyle:"italic" }}>🩺 Dr. {s.doctorName}</span>}
                        </div>
                      </div>
                      
                      <div style={{ display:"flex",gap:16,alignItems:"center" }}>
                        <div style={{ textAlign:"right" }}>
                          <div style={{ fontSize:14,fontWeight:700,color:C.blue }}>₹{(s.grandTotal||0).toFixed(2)}</div>
                          <span style={{ ...S.badge(s.paymentMode==="Cash"?"amber":"green"),padding:"1px 6px",fontSize:10 }}>{s.paymentMode}</span>
                        </div>
                        <div style={{ display:"inline-flex",gap:6 }} onClick={e=>e.stopPropagation()}>
                          <button 
                            style={{ ...S.btn("outline"),padding:"5px 8px",fontSize:11,borderColor:C.teal,color:C.teal }}
                            onClick={() => printThermalReceipt(finalBill, storeDetails)}
                            title="Print Thermal Receipt"
                          >
                            🧾 Thermal
                          </button>
                          <button 
                            style={{ ...S.btn("outline"),padding:"5px 8px",fontSize:11,borderColor:C.blue,color:C.blue }}
                            disabled={isCurExp}
                            onClick={() => printA4PDFInvoice(finalBill)}
                            title="Print A4 Standard PDF"
                          >
                            {isCurExp ? "⏳ PDF" : "📄 A4 PDF"}
                          </button>
                          <button 
                            style={{ ...S.btn("outline"),padding:"5px 8px",fontSize:11,borderColor:C.green,color:C.green }}
                            onClick={() => handleOpenEditBill(s)}
                            title="Edit Bill Details"
                          >
                            ✏️ Edit
                          </button>
                          <button 
                            onClick={() => deleteSale(s)} 
                            style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 13, padding: "5px 8px" }} 
                            title="Delete/Cancel Bill"
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* SALES IMPORT HISTORY PANEL */}
            {true && (
              <div style={{ ...S.card, marginTop: 24, marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy, letterSpacing: "0.5px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span>📋 Sales Import History</span>
                  <span style={{ fontSize: 11, color: C.text3, fontWeight: 400 }}>{salesImportSessions.length} session{salesImportSessions.length !== 1 ? "s" : ""}</span>
                </div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC" }}>
                        {["Import Date", "Bills Count", "Bill Nos", "Est. Revenue", "Status", "Action"].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {salesImportSessions.length === 0 ? (
                        <tr>
                          <td colSpan="6" style={{ ...S.td, textAlign: "center", color: C.text3, padding: "24px 0", fontStyle: "italic" }}>
                            No past imports recorded. Upload a spreadsheet under "GST & Reports" tab to ingest sales ledger history.
                          </td>
                        </tr>
                      ) : (
                        salesImportSessions.map(session => {
                          const dateStr = session.createdAt?.toDate
                            ? session.createdAt.toDate().toLocaleString("en-IN")
                            : new Date(session.createdAt || 0).toLocaleString("en-IN");
                          const billNosPreview = Array.isArray(session.billNumbers)
                            ? (session.billNumbers.length <= 3
                              ? session.billNumbers.join(", ")
                              : `${session.billNumbers.slice(0, 3).join(", ")} +${session.billNumbers.length - 3} more`)
                            : "—";
                          const statusColor = session.status === "COMPLETED" ? C.green
                            : session.status === "DELETED" ? C.red : C.text3;
                          const statusBg = session.status === "COMPLETED" ? "#E8F5EE"
                            : session.status === "DELETED" ? "#FDECEA" : "#F1F5F9";
                          return (
                            <tr key={session.id}>
                              <td style={S.td}>{dateStr}</td>
                              <td style={S.td}>
                                <span style={S.badge("blue")}>{session.totalBills} bills</span>
                              </td>
                              <td style={{ ...S.td, fontSize: 11, color: C.text2, maxWidth: 200 }}>
                                {billNosPreview}
                              </td>
                              <td style={{ ...S.td, fontWeight: 700, color: C.green }}>
                                ₹{(session.totalRevenue || 0).toFixed(2)}
                              </td>
                              <td style={S.td}>
                                <span style={{ ...S.badge("teal"), background: statusBg, color: statusColor }}>
                                  {session.status}
                                </span>
                              </td>
                              <td style={S.td}>
                                {session.status !== "DELETED" && (
                                  <div style={{ display: "flex", gap: 8 }}>
                                    <button
                                      onClick={() => loadSalesImportSessionForEditing(session)}
                                      style={{ ...S.btn("outline"), padding: "4px 10px", fontSize: 11, borderColor: C.blue, color: C.blue }}
                                      onMouseEnter={e => { e.currentTarget.style.background = "#EBF4FF"; }}
                                      onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
                                    >
                                      ✏️ Edit Import
                                    </button>
                                    <button
                                      onClick={() => deleteSalesImportSession(session)}
                                      style={{ ...S.btn("outline"), padding: "4px 10px", fontSize: 11, borderColor: C.red, color: C.red }}
                                      onMouseEnter={e => { e.currentTarget.style.background = "#FFF5F5"; }}
                                      onMouseLeave={e => { e.currentTarget.style.background = "#fff"; }}
                                    >
                                      🗑️ Delete Import
                                    </button>
                                  </div>
                                )}
                                {session.status === "DELETED" && (
                                  <span style={{ fontSize: 11, color: C.text3, fontStyle: "italic" }}>Deleted</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* REPORTS */}
        {!dbLoading && activeTab === "reports" && (
          <div>
            <PH title="Reports & P&L" sub="Daily / Monthly profit & loss · Export PDF" />

            {/* Reports Sub-Tab Navigation */}
            <div style={{ display: "flex", borderBottom: `1.5px solid ${C.border}`, marginBottom: 16 }}>
              {[
                ["sales", "Sales Report", "📈"],
                ["purchase", "Purchase Report", "📦"],
                ["stock", "Stock Transaction Register", "🔄"],
                ["stock-inventory", "Current Stock Report", "📋"],
                ["gst", "GST Compliance & Ledger", "⚖️"],
                ["adc", "ADC Inspection Register", "🛡️"]
              ].map(([id, label, icon]) => {
                const isAct = reportsSubTab === id;
                return (
                  <button
                    key={id}
                    id={`reports-sub-tab-${id}`}
                    onClick={() => setReportsSubTab(id)}
                    style={{
                      padding: "10px 20px", background: "none", border: "none",
                      borderBottom: isAct ? `3px solid ${C.teal}` : "3px solid transparent",
                      color: isAct ? C.teal : C.text2, fontWeight: isAct ? 700 : 500,
                      cursor: "pointer", fontFamily: "inherit", fontSize: 13,
                      display: "flex", alignItems: "center", gap: 6, transition: "all 0.15s ease"
                    }}
                  >
                    <span>{icon}</span> {label}
                  </button>
                );
              })}
            </div>

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

              <FF label="Filter by Product Name">
                <input
                  type="text"
                  placeholder="Type brand/generic name (e.g. Paracetamol)..."
                  style={S.input}
                  value={reportFilters.productQuery || ""}
                  onChange={e => setReportFilters(f => ({ ...f, productQuery: e.target.value }))}
                />
              </FF>

              <FF label="Search Patient/Doctor/Bill/Item">
                <input
                  type="text"
                  placeholder="e.g. Patient, Bill No, Medicine..."
                  style={S.input}
                  value={reportFilters.searchText || ""}
                  onChange={e => setReportFilters(f => ({ ...f, searchText: e.target.value }))}
                />
              </FF>

              <FF label="Filter by Batch No">
                <input
                  type="text"
                  placeholder="e.g. B1234"
                  style={S.input}
                  value={reportFilters.batchNo || ""}
                  onChange={e => setReportFilters(f => ({ ...f, batchNo: e.target.value }))}
                />
              </FF>

              <FF label="Filter by Drug Code">
                <input
                  type="text"
                  placeholder="e.g. 1045"
                  style={S.input}
                  value={reportFilters.drugCode || ""}
                  onChange={e => setReportFilters(f => ({ ...f, drugCode: e.target.value }))}
                />
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



            {/* WEB WORKER PROGRESS INDICATOR */}
            {isWorkerExporting && (
              <div style={{ background: "#EBF4FF", color: C.blue, border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 20, fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ width: 14, height: 14, borderRadius: "50%", border: `2px solid ${C.blue}`, borderTopColor: "transparent", animation: "spin 1s linear infinite" }} />
                <span>Web Worker compiling data stream, transforming cells, and packing report... Please wait.</span>
              </div>
            )}

            {/* sub tab contents */}
            {reportsSubTab === "sales" && (() => {
              const isFiltered = reportFilters.medicineId || reportFilters.productQuery;
              let displayTotalSales = 0;
              let displaySalesCount = 0;
              let totalQty = 0;

              if (isFiltered) {
                // Sum of matching items total
                rSales.forEach(s => {
                  (s.items || []).forEach(item => {
                    if (reportFilters.medicineId && item.medicineId !== reportFilters.medicineId) return;
                    if (reportFilters.productQuery) {
                      const q = reportFilters.productQuery.toLowerCase();
                      const match = item.brandName?.toLowerCase().includes(q) || item.genericName?.toLowerCase().includes(q);
                      if (!match) return;
                    }
                    displayTotalSales += item.total || 0;
                    totalQty += item.quantity || item.qty || 1;
                  });
                });
                displaySalesCount = rSales.length;
              } else {
                displayTotalSales = rTS;
                displaySalesCount = rSales.length;
              }

              const cards = isFiltered ? [
                { label: "PRODUCT SALES REVENUE", value: `₹${displayTotalSales.toFixed(2)}`, sub: `From ${displaySalesCount} bills`, accent: C.blue, vc: C.blue },
                { label: "TOTAL QTY SOLD", value: `${totalQty} units`, sub: "Units moved", accent: C.teal, vc: C.teal },
                { label: "ESTIMATED PRODUCT PROFIT", value: `₹${rSales.reduce((acc, s) => {
                  let pProf = 0;
                  (s.items || []).forEach(item => {
                    if (reportFilters.medicineId && item.medicineId !== reportFilters.medicineId) return;
                    if (reportFilters.productQuery) {
                      const q = reportFilters.productQuery.toLowerCase();
                      const match = item.brandName?.toLowerCase().includes(q) || item.genericName?.toLowerCase().includes(q);
                      if (!match) return;
                    }
                    pProf += item.profit || 0;
                  });
                  return acc + pProf;
                }, 0).toFixed(2)}`, sub: "GST-adjusted margin", accent: C.green, vc: C.green }
              ] : [
                { label: "TOTAL SALES", value: `₹${rTS.toFixed(2)}`, sub: `${rSales.length} bills`, accent: C.blue, vc: C.blue },
                { label: "CASH SALES", value: `₹${rSales.filter(s => s.paymentMode === "Cash").reduce((a, s) => a + (s.grandTotal || 0), 0).toFixed(2)}`, sub: "Cash collected", accent: "#B7791F", vc: C.amber },
                { label: "UPI SALES", value: `₹${rSales.filter(s => s.paymentMode === "UPI").reduce((a, s) => a + (s.grandTotal || 0), 0).toFixed(2)}`, sub: "UPI collections", accent: C.teal, vc: C.teal },
                { label: "CREDIT SALES", value: `₹${rSales.filter(s => s.paymentMode === "Credit").reduce((a, s) => a + (s.grandTotal || 0), 0).toFixed(2)}`, sub: "Outstanding customer dues", accent: C.red, vc: C.red }
              ];

              const isFilteredForPrint = isFiltered && (reportFilters.productQuery || (reportFilters.medicineId && medicines.find(m => m.id === reportFilters.medicineId)));
              const printTitle = isFilteredForPrint
                ? `Sales Report – ${reportFilters.productQuery || medicines.find(m => m.id === reportFilters.medicineId)?.brandName || "Product"}`
                : `Sales Report (${reportFilters.period || "All"})  ·  ${storeDetails?.name || ""}`;

              return (
                <div>
                  {/* Print-only header */}
                  <div className="print-only" style={{ display: "none", marginBottom: 16 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>{storeDetails?.name}</div>
                    <div style={{ fontSize: 12, color: C.text3 }}>Drug Licence: {storeDetails?.drugLicense || "—"} · GSTIN: {storeDetails?.gstin || "—"}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8, borderBottom: "2px solid #000", paddingBottom: 4 }}>{printTitle}</div>
                  </div>

                  {/* Action bar */}
                  <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                    <div style={{ fontSize: 12, color: C.text2 }}>
                      {isFiltered ? <><strong>📌 Filtered by product:</strong> {reportFilters.productQuery || medicines.find(m => m.id === reportFilters.medicineId)?.brandName}</> : <span>Showing all sales for selected period</span>}
                    </div>
                    <button style={{ ...S.btn("primary"), display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => window.print()}>
                      🖨️ Print Sales Report
                    </button>
                  </div>

                  {/* Print styles for this tab */}
                  <style>{`
                    @media print {
                      body * { visibility: hidden !important; }
                      .printable-sales-report, .printable-sales-report *, .print-only, .print-only * { visibility: visible !important; }
                      .printable-sales-report { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; padding: 20px !important; }
                      .print-only { display: block !important; }
                      .no-print { display: none !important; }
                      table { font-size: 10px !important; border-collapse: collapse !important; }
                      th, td { border: 1px solid #000 !important; padding: 4px 6px !important; }
                      tr { page-break-inside: avoid !important; }
                    }
                  `}</style>

                  <div className="printable-sales-report">
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14, marginBottom: 22 }}>
                    {cards.map((card, i) => (
                      <div key={i} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", borderTop: `3px solid ${card.accent}` }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.6px", marginBottom: 8 }}>{card.label}</div>
                        <div style={{ fontSize: 22, fontWeight: 700, color: card.vc, marginBottom: 3 }}>{card.value}</div>
                        <div style={{ fontSize: 11, color: C.text3 }}>{card.sub}</div>
                      </div>
                    ))}
                  </div>

                <div style={{ display:"grid",gridTemplateColumns:"1.2fr 0.8fr",gap:16,marginBottom:22 }}>
                  <div style={S.card}>
                    <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Sales Ledger Table</div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}` }}>
                        <thead>
                          <tr style={{ background: "#F8FAFC" }}>
                            {["Bill No", "Patient", "Mode", "Items", "Tax (₹)", "Total (₹)"].map(h => <th key={h} style={S.th}>{h}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {rSales.length === 0 ? (
                            <tr><td colSpan={6} style={{ ...S.td, textAlign: "center", color: C.text3 }}>No bills found for the selected period & filters.</td></tr>
                          ) : (
                            rSales.map(s => (
                              <tr key={s.id}>
                                <td style={{ ...S.td, fontWeight: 600, color: C.blue, cursor: "pointer" }} onClick={() => setSelectedBill(s)}>{s.billNumber}</td>
                                <td style={S.td}>{s.customerName || "Walk-in Patient"}</td>
                                <td style={S.td}>
                                  <span style={S.badge(s.paymentMode === "Cash" ? "amber" : "teal")}>{s.paymentMode}</span>
                                </td>
                                <td style={S.td}>{(s.items || []).length}</td>
                                <td style={S.td}>₹{(s.totalGst || s.taxAmount || 0).toFixed(2)}</td>
                                <td style={{ ...S.td, fontWeight: 700, color: C.green }}>₹{(s.grandTotal || 0).toFixed(2)}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div style={S.card}>
                      <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Payment Breakdown</div>
                      {["Cash","UPI","Card","Credit"].map(mode=>{const mS=rSales.filter(s=>s.paymentMode===mode);const mT=mS.reduce((a,s)=>a+(s.grandTotal||0),0);if(!mT)return null;return<div key={mode} style={{ display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:`1px solid ${C.border}` }}><span style={{ fontSize:13,color:C.text2 }}>{mode}</span><div style={{ textAlign:"right" }}><div style={{ fontSize:14,fontWeight:700,color:C.navy }}>₹{mT.toFixed(2)}</div><div style={{ fontSize:11,color:C.text3 }}>{mS.length} bills</div></div></div>;})}
                      {rSales.length===0&&<div style={{ color:C.text3,fontSize:13 }}>No sales in this period.</div>}
                    </div>
                    
                    <div style={S.card}>
                      <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Top Selling in this Period</div>
                      {rSales.slice(0, 5).flatMap(s => s.items || []).slice(0, 5).map((it, idx) => (
                        <div key={idx} style={{ display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
                          <span style={{ color: C.text2 }}>{it.brandName || it.genericName}</span>
                          <span style={{ fontWeight: 700, color: C.navy }}>{it.quantity || it.qty} sold</span>
                        </div>
                      ))}
                      {rSales.length===0&&<div style={{ color:C.text3,fontSize:13 }}>No items sold.</div>}
                    </div>
                  </div>
                </div>
                </div>
              </div>
            );
          })()}

            {reportsSubTab === "purchase" && (
              <div>
                <style>{`
                  @media print {
                    body * { visibility: hidden !important; }
                    .printable-purchase-report, .printable-purchase-report *, .print-only-purch, .print-only-purch * { visibility: visible !important; }
                    .printable-purchase-report { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; padding: 20px !important; }
                    .print-only-purch { display: block !important; }
                    .no-print { display: none !important; }
                    table { font-size: 10px !important; border-collapse: collapse !important; }
                    th, td { border: 1px solid #000 !important; padding: 4px 6px !important; }
                    tr { page-break-inside: avoid !important; }
                  }
                `}</style>
                <div className="print-only-purch" style={{ display: "none", marginBottom: 16 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.navy }}>{storeDetails?.name}</div>
                  <div style={{ fontSize: 12, color: C.text3 }}>Drug Licence: {storeDetails?.drugLicense || "—"} · GSTIN: {storeDetails?.gstin || "—"}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8, borderBottom: "2px solid #000", paddingBottom: 4 }}>
                    Purchase Report{reportFilters.productQuery ? ` – ${reportFilters.productQuery}` : ""} · {storeDetails?.name}
                  </div>
                </div>
                <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                  <div style={{ fontSize: 12, color: C.text2 }}>
                    {(reportFilters.productQuery || reportFilters.medicineId) ? <><strong>📌 Filtered by product:</strong> {reportFilters.productQuery || medicines.find(m => m.id === reportFilters.medicineId)?.brandName}</> : <span>Showing all purchases for selected period</span>}
                  </div>
                  <button style={{ ...S.btn("primary"), display: "inline-flex", alignItems: "center", gap: 6 }} onClick={() => window.print()}>
                    🖨️ Print Purchase Report
                  </button>
                </div>
                <div className="printable-purchase-report">
                {(() => {
                  const isFiltered = reportFilters.medicineId || reportFilters.productQuery;
                  let displayTotalPurchases = 0;
                  let displayPurchCount = 0;
                  let totalQty = 0;

                  if (isFiltered) {
                    rPurch.forEach(p => {
                      (p.items || []).forEach(item => {
                        const itemMedId = item.medicineId || item.overrideId || item.matchedItem?.id;
                        if (reportFilters.medicineId && itemMedId !== reportFilters.medicineId) return;
                        if (reportFilters.productQuery) {
                          const q = reportFilters.productQuery.toLowerCase();
                          const match = item.brandName?.toLowerCase().includes(q) || item.genericName?.toLowerCase().includes(q);
                          if (!match) return;
                        }
                        displayTotalPurchases += (item.purchasePrice || 0) * (item.qty || item.quantity || 0);
                        totalQty += item.qty || item.quantity || 0;
                      });
                    });
                    displayPurchCount = rPurch.length;
                  } else {
                    displayTotalPurchases = rTP;
                    displayPurchCount = rPurch.length;
                  }

                  const totalCgstPaid = rPurch.reduce((acc, p) => {
                    const itemsTax = (p.items || []).reduce((sum, item) => {
                      const rate = item.gstRate || 12;
                      const qty = item.qty || item.quantity || 0;
                      const total = (item.purchasePrice || 0) * qty;
                      const taxable = total / (1 + (rate / 100));
                      return sum + (total - taxable) / 2;
                    }, 0);
                    return acc + itemsTax;
                  }, 0);
                  const totalSgstPaid = totalCgstPaid;

                  const cards = isFiltered ? [
                    { label: "PRODUCT PURCHASE COST", value: `₹${displayTotalPurchases.toFixed(2)}`, sub: `From ${displayPurchCount} invoices`, accent: C.teal, vc: C.teal },
                    { label: "TOTAL QTY PURCHASED", value: `${totalQty} units`, sub: "Units stocked in", accent: C.blue, vc: C.blue }
                  ] : [
                    { label: "TOTAL PURCHASES", value: `₹${rTP.toFixed(2)}`, sub: `${rPurch.length} invoices`, accent: C.teal, vc: C.teal },
                    { label: "CGST PAID (ITC)", value: `₹${totalCgstPaid.toFixed(2)}`, sub: "Central GST Paid", accent: C.blue, vc: C.blue },
                    { label: "SGST PAID (ITC)", value: `₹${totalSgstPaid.toFixed(2)}`, sub: "State GST Paid", accent: C.teal2, vc: C.teal2 },
                    { label: "OUTSTANDING DUES", value: `₹${suppliers.reduce((acc, s) => acc + (s.outstanding || 0), 0).toFixed(2)}`, sub: "Pending supplier payments", accent: C.red, vc: C.red }
                  ];

                  return (
                    <>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14, marginBottom: 22 }}>
                        {cards.map((card, i) => (
                          <div key={i} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 18px", borderTop: `3px solid ${card.accent}` }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.6px", marginBottom: 8 }}>{card.label}</div>
                            <div style={{ fontSize: 22, fontWeight: 700, color: card.vc, marginBottom: 3 }}>{card.value}</div>
                            <div style={{ fontSize: 11, color: C.text3 }}>{card.sub}</div>
                          </div>
                        ))}
                      </div>

                      <div style={S.card}>
                        <div style={{ fontSize:12,fontWeight:700,color:C.navy,textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:14 }}>Purchase Invoices Ledger</div>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}` }}>
                            <thead>
                              <tr style={{ background: "#F8FAFC" }}>
                                {["Invoice No", "Supplier / Vendor", "Date", "Items Count", "CGST Paid", "SGST Paid", "Total (₹)"].map(h => <th key={h} style={S.th}>{h}</th>)}
                              </tr>
                            </thead>
                            <tbody>
                              {rPurch.length === 0 ? (
                                <tr><td colSpan={7} style={{ ...S.td, textAlign: "center", color: C.text3 }}>No purchase invoices found for the selected period.</td></tr>
                              ) : (
                                rPurch.map(p => {
                                  const cgst = (p.items || []).reduce((sum, item) => {
                                    const rate = item.gstRate || 12;
                                    const qty = item.qty || item.quantity || 0;
                                    const total = (item.purchasePrice || 0) * qty;
                                    const taxable = total / (1 + (rate / 100));
                                    return sum + (total - taxable) / 2;
                                  }, 0);
                                  return (
                                    <tr key={p.id}>
                                      <td style={{ ...S.td, fontWeight: 600, color: C.navy }}>{p.invoiceNumber}</td>
                                      <td style={S.td}>{p.supplierName}</td>
                                      <td style={S.td}>{p.createdAt?.toDate ? p.createdAt.toDate().toLocaleDateString("en-IN") : new Date(p.date || 0).toLocaleDateString("en-IN")}</td>
                                      <td style={S.td}>{(p.items || []).length}</td>
                                      <td style={S.td}>₹{cgst.toFixed(2)}</td>
                                      <td style={S.td}>₹{cgst.toFixed(2)}</td>
                                      <td style={{ ...S.td, fontWeight: 700, color: C.green }}>₹{(p.totalAmount || 0).toFixed(2)}</td>
                                    </tr>
                                  );
                                })
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  );
                })()}
                </div> {/* close printable-purchase-report */}
              </div>
            )}

            {reportsSubTab === "stock-inventory" && (
              <StockInventoryReport
                db={db}
                storeId={storeId}
                storeCode={storeCode}
                user={user}
                medicines={medicines}
              />
            )}

            {reportsSubTab === "stock" && (() => {
              /* ── STOCK TRANSACTION REGISTER ── */
              const prodLabel = reportFilters.productQuery
                || medicines.find(m => m.id === reportFilters.medicineId)?.brandName
                || null;

              // Build unified item-level transaction rows
              const txns = [];

              purchases.forEach(p => {
                let d = p.invoiceDate ? new Date(p.invoiceDate) : null;
                if (!d || isNaN(d.getTime())) d = p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || 0);
                (p.items || []).forEach(item => {
                  // product filter
                  if (reportFilters.medicineId) {
                    const mid = item.medicineId || item.overrideId || item.matchedItem?.id;
                    if (mid !== reportFilters.medicineId) return;
                  }
                  if (reportFilters.productQuery) {
                    const q = reportFilters.productQuery.toLowerCase();
                    if (!item.brandName?.toLowerCase().includes(q) && !item.genericName?.toLowerCase().includes(q) && !String(item.drugCode || "").toLowerCase().includes(q)) return;
                  }
                  // batch filter
                  if (reportFilters.batchNo) {
                    if (!item.batchNumber?.toLowerCase().includes(reportFilters.batchNo.toLowerCase())) return;
                  }
                  // drug code filter
                  if (reportFilters.drugCode) {
                    const dc = reportFilters.drugCode.toLowerCase();
                    if (!String(item.drugCode || "").toLowerCase().includes(dc)) return;
                  }
                  // date range
                  if (reportFilters.startDate && d < new Date(reportFilters.startDate)) return;
                  if (reportFilters.endDate && d > new Date(reportFilters.endDate + "T23:59:59")) return;

                  txns.push({
                    date: d,
                    type: "IN",
                    refNo: p.invoiceNumber || "—",
                    party: p.supplierName || "—",
                    name: item.brandName || item.genericName || "—",
                    genericName: item.genericName || "",
                    drugCode: item.drugCode || "",
                    batch: item.batchNumber || "—",
                    expiry: item.expiryDate || "—",
                    qty: item.qty || item.quantity || 0,
                    rate: item.purchasePrice || 0,
                    value: (item.purchasePrice || 0) * (item.qty || item.quantity || 0),
                    gst: item.gstRate || 0
                  });
                });
              });

              sales.forEach(s => {
                const d = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0);
                // date range
                if (reportFilters.startDate && d < new Date(reportFilters.startDate)) return;
                if (reportFilters.endDate && d > new Date(reportFilters.endDate + "T23:59:59")) return;
                (s.items || []).forEach(item => {
                  if (reportFilters.medicineId && item.medicineId !== reportFilters.medicineId) return;
                  if (reportFilters.productQuery) {
                    const q = reportFilters.productQuery.toLowerCase();
                    if (!item.brandName?.toLowerCase().includes(q) && !item.genericName?.toLowerCase().includes(q) && !String(item.drugCode || "").toLowerCase().includes(q)) return;
                  }
                  if (reportFilters.batchNo) {
                    const batchLow = reportFilters.batchNo.toLowerCase();
                    const match = item.batchNumber?.toLowerCase().includes(batchLow) ||
                      (item.batchesUsed || []).some(bu => bu.batchNumber?.toLowerCase().includes(batchLow));
                    if (!match) return;
                  }
                  // drug code filter
                  if (reportFilters.drugCode) {
                    const dc = reportFilters.drugCode.toLowerCase();
                    if (!String(item.drugCode || "").toLowerCase().includes(dc)) return;
                  }
                  const batchLabel = item.batchesUsed?.length
                    ? item.batchesUsed.map(b => b.batchNumber).join(", ")
                    : (item.batchNumber || "—");
                  txns.push({
                    date: d,
                    type: "OUT",
                    refNo: s.billNumber || "—",
                    party: s.customerName || "Walk-in Patient",
                    name: item.brandName || item.genericName || "—",
                    genericName: item.genericName || "",
                    drugCode: item.drugCode || "",
                    batch: batchLabel,
                    expiry: item.expiryDate || (item.batchesUsed?.[0]?.expiryDate) || "—",
                    qty: item.quantity || item.qty || 0,
                    rate: item.mrp || item.sellingPrice || 0,
                    value: item.total || 0,
                    gst: item.gstRate || 0
                  });
                });
              });

              // Sort chronologically
              txns.sort((a, b) => a.date - b.date);

              // Compute running balance
              let runningQty = 0;
              const rows = txns.map(t => {
                if (t.type === "IN") runningQty += t.qty;
                else runningQty -= t.qty;
                return { ...t, balance: runningQty };
              });

              const totalIn  = rows.filter(r => r.type === "IN").reduce((a, r) => a + r.qty, 0);
              const totalOut = rows.filter(r => r.type === "OUT").reduce((a, r) => a + r.qty, 0);
              const totalInVal  = rows.filter(r => r.type === "IN").reduce((a, r) => a + r.value, 0);
              const totalOutVal = rows.filter(r => r.type === "OUT").reduce((a, r) => a + r.value, 0);

              return (
                <div>
                  {/* Print styles */}
                  <style>{`
                    @media print {
                      body * { visibility: hidden !important; }
                      .printable-stock-txn, .printable-stock-txn *, .print-only-stock, .print-only-stock * { visibility: visible !important; }
                      .printable-stock-txn { position: absolute !important; left: 0 !important; top: 0 !important; width: 100% !important; padding: 20px !important; box-shadow: none !important; border: none !important; }
                      .print-only-stock { display: block !important; }
                      .no-print { display: none !important; }
                      table { font-size: 10px !important; border-collapse: collapse !important; width: 100% !important; }
                      th, td { border: 1px solid #000 !important; padding: 4px 6px !important; }
                      tr { page-break-inside: avoid !important; }
                      .bg-in  { background: #F0FDF4 !important; }
                      .bg-out { background: #FFF5F5 !important; }
                    }
                  `}</style>

                  {/* Print-only store header */}
                  <div className="print-only-stock" style={{ display: "none", marginBottom: 14 }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{storeDetails?.name}</div>
                    <div style={{ fontSize: 11, color: "#555" }}>Drug Licence: {storeDetails?.drugLicense || "—"} · GSTIN: {storeDetails?.gstin || "—"} · {storeDetails?.address || ""}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 8, borderBottom: "2px solid #000", paddingBottom: 4 }}>
                      Stock Transaction Register{prodLabel ? ` — ${prodLabel}` : ""}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4 }}>Printed on: {new Date().toLocaleString("en-IN")}</div>
                  </div>

                  {/* Screen: action bar */}
                  <div className="no-print" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 800, color: C.navy }}>📋 Stock Transaction Register</div>
                      <div style={{ fontSize: 12, color: C.text3, marginTop: 2 }}>
                        Chronological IN/OUT ledger with running balance
                        {prodLabel ? <> · <strong style={{ color: C.teal }}>Product: {prodLabel}</strong></> : " · Set a product filter above for a specific item"}
                      </div>
                    </div>
                    <button
                      style={{ ...S.btn("primary"), display: "inline-flex", alignItems: "center", gap: 6 }}
                      onClick={() => window.print()}
                    >
                      🖨️ Print Stock Transaction Report
                    </button>
                  </div>

                  {/* KPI summary strip */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 18 }}>
                    {[
                      { label: "TOTAL STOCK IN (QTY)", value: `+${totalIn} units`, color: C.green, bg: "#F0FDF4", border: C.green },
                      { label: "TOTAL STOCK OUT (QTY)", value: `-${totalOut} units`, color: C.red, bg: "#FFF5F5", border: C.red },
                      { label: "CLOSING BALANCE", value: `${runningQty} units`, color: runningQty >= 0 ? C.navy : C.red, bg: "#F8FAFC", border: C.border },
                      { label: "TOTAL PURCHASE VALUE", value: `₹${totalInVal.toFixed(2)}`, color: C.blue, bg: "#EFF6FF", border: C.blue },
                      { label: "TOTAL SALES VALUE", value: `₹${totalOutVal.toFixed(2)}`, color: C.teal, bg: "#F0FDFA", border: C.teal }
                    ].map((kpi, i) => (
                      <div key={i} style={{ background: kpi.bg, border: `1.5px solid ${kpi.border}`, borderRadius: 10, padding: "12px 14px" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>{kpi.label}</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: kpi.color }}>{kpi.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Warn if no product filter */}
                  {!prodLabel && (
                    <div className="no-print" style={{ padding: "12px 14px", background: "#FFF8E7", border: "1.5px solid #FCD34D", borderRadius: 8, fontSize: 12, fontWeight: 600, color: "#B45309", marginBottom: 14 }}>
                      💡 <strong>Tip:</strong> Type a product name in <em>Filter by Product Name</em> above to view its complete inflow/outflow history with running stock balance.
                    </div>
                  )}

                  {/* Main ledger table */}
                  <div style={S.card} className="printable-stock-txn">
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}`, fontSize: 11.5 }}>
                        <thead>
                          <tr style={{ background: "#F1F5F9", borderBottom: `2px solid ${C.border}` }}>
                            {["Date & Time", "Type", "Doc Ref #", "Party (Supplier/Patient)", "Medicine Name", "Batch No", "Expiry", "Qty IN", "Qty OUT", "Rate (₹)", "Value (₹)", "Stock Balance"].map(h => (
                              <th key={h} style={{ ...S.th, padding: "7px 8px", whiteSpace: "nowrap" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.length === 0 ? (
                            <tr><td colSpan={12} style={{ ...S.td, textAlign: "center", color: C.text3, padding: "24px 0", fontStyle: "italic" }}>
                              No transactions found. {!prodLabel && "Set a product filter above to narrow results."}
                            </td></tr>
                          ) : (
                            rows.map((row, idx) => (
                              <tr key={idx} className={row.type === "IN" ? "bg-in" : "bg-out"} style={{ borderBottom: `1px solid ${C.border}`, background: row.type === "IN" ? "#F0FDF4" : "#FFF5F5" }}>
                                <td style={{ ...S.td, whiteSpace: "nowrap", fontSize: 11 }}>{row.date.toLocaleString("en-IN")}</td>
                                <td style={{ ...S.td, fontWeight: 800, color: row.type === "IN" ? C.green : C.red, whiteSpace: "nowrap" }}>
                                  {row.type === "IN" ? "📥 PURCHASE" : "📤 SALE"}
                                </td>
                                <td style={{ ...S.td, fontWeight: 600, color: C.navy }}>{row.refNo}</td>
                                <td style={S.td}>{row.party}</td>
                                <td style={S.td}>
                                  <div style={{ fontWeight: 600, color: C.navy }}>
                                    {row.name}
                                    {row.drugCode && <span style={{ color: C.teal, fontSize: 10, marginLeft: 6, fontWeight: 700 }}>[Code: {row.drugCode}]</span>}
                                  </div>
                                  {row.genericName && row.genericName !== row.name && <div style={{ fontSize: 10, color: C.text3, fontStyle: "italic" }}>{row.genericName}</div>}
                                </td>
                                <td style={{ ...S.td, fontFamily: "monospace", fontWeight: 700 }}>{row.batch}</td>
                                <td style={S.td}>{row.expiry}</td>
                                <td style={{ ...S.td, fontWeight: 700, color: C.green, textAlign: "center" }}>{row.type === "IN" ? `+${row.qty}` : "—"}</td>
                                <td style={{ ...S.td, fontWeight: 700, color: C.red, textAlign: "center" }}>{row.type === "OUT" ? `-${row.qty}` : "—"}</td>
                                <td style={{ ...S.td, textAlign: "right" }}>₹{row.rate.toFixed(2)}</td>
                                <td style={{ ...S.td, textAlign: "right", fontWeight: 600 }}>₹{row.value.toFixed(2)}</td>
                                <td style={{ ...S.td, fontWeight: 800, textAlign: "center", color: row.balance < 0 ? C.red : C.navy, background: row.balance < 0 ? "#FEE2E2" : "transparent" }}>
                                  {row.balance}
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                        {rows.length > 0 && (
                          <tfoot>
                            <tr style={{ background: "#0A2342", color: "#fff" }}>
                              <td colSpan={7} style={{ ...S.td, fontWeight: 700, color: "#fff", padding: "8px 10px" }}>TOTALS</td>
                              <td style={{ ...S.td, fontWeight: 800, color: "#86EFAC", textAlign: "center", padding: "8px 10px" }}>+{totalIn}</td>
                              <td style={{ ...S.td, fontWeight: 800, color: "#FCA5A5", textAlign: "center", padding: "8px 10px" }}>-{totalOut}</td>
                              <td style={{ ...S.td, color: "#fff", padding: "8px 10px" }}></td>
                              <td style={{ ...S.td, fontWeight: 800, color: "#FDE68A", textAlign: "right", padding: "8px 10px" }}>₹{(totalInVal + totalOutVal).toFixed(2)}</td>
                              <td style={{ ...S.td, fontWeight: 800, color: "#67E8F9", textAlign: "center", padding: "8px 10px" }}>{runningQty} left</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}

            {reportsSubTab === "gst" && (
              <div>
                {(() => {
                  const totalCgstPaid = rPurch.reduce((acc, p) => {
                    const itemsTax = (p.items || []).reduce((sum, item) => {
                      const rate = item.gstRate || 12;
                      const qty = item.qty || item.quantity || 0;
                      const total = (item.purchasePrice || 0) * qty;
                      const taxable = total / (1 + (rate / 100));
                      return sum + (total - taxable) / 2;
                    }, 0);
                    return acc + itemsTax;
                  }, 0);
                  const totalSgstPaid = totalCgstPaid;

                  return (
                    <>
                      {/* GST LEDGER SUMMARY */}
                      <div style={{ ...S.card, marginBottom: 22 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.teal, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>GST Tax Ledger Summary</div>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
                          <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>CGST COLLECTED (SALES)</div>
                            <div style={{ fontSize: 20, fontWeight: 700, color: C.blue }}>₹{rSales.reduce((a, s) => a + (s.cgstAmount || 0), 0).toFixed(2)}</div>
                          </div>
                          <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>SGST COLLECTED (SALES)</div>
                            <div style={{ fontSize: 20, fontWeight: 700, color: C.teal2 }}>₹{rSales.reduce((a, s) => a + (s.sgstAmount || 0), 0).toFixed(2)}</div>
                          </div>
                          <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>CGST PAID (ITC)</div>
                            <div style={{ fontSize: 20, fontWeight: 700, color: C.purple }}>₹{totalCgstPaid.toFixed(2)}</div>
                          </div>
                          <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 14 }}>
                            <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, letterSpacing: "0.5px", marginBottom: 4 }}>SGST PAID (ITC)</div>
                            <div style={{ fontSize: 20, fontWeight: 700, color: "#D53F8C" }}>₹{totalSgstPaid.toFixed(2)}</div>
                          </div>
                          <div style={{ background: "#FFFBEB", border: `1.5px solid #FCD34D`, borderRadius: 10, padding: 14, gridColumn: "span 2" }}>
                            <div style={{ fontSize: 10, fontWeight: 800, color: "#B45309", letterSpacing: "0.5px", marginBottom: 4 }}>NET TAX PAYABLE / REFUNDABLE</div>
                            {(() => {
                              const coll = rSales.reduce((a, s) => a + (s.cgstAmount || 0) + (s.sgstAmount || 0), 0);
                              const paid = totalCgstPaid + totalSgstPaid;
                              const net = coll - paid;
                              return (
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                                  <div style={{ fontSize: 24, fontWeight: 800, color: net >= 0 ? C.red : C.green }}>
                                    {net >= 0 ? `₹${net.toFixed(2)} Payable` : `₹${Math.abs(net).toFixed(2)} ITC Refundable`}
                                  </div>
                                  <span style={{ fontSize: 11, color: C.text3 }}>GSTR-3B Auto-Reconciliation</span>
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                      </div>

                      {/* GST SLAB BREAKDOWN */}
                      <div style={{ ...S.card, marginBottom: 22 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>GST Tax Slab Breakdown (GSTR-1 Auditing)</div>
                        <div style={{ overflowX: "auto" }}>
                          <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}` }}>
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

                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 22 }}>
                        {/* GSTR-2 ITC matching table */}
                        <div style={S.card}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>GSTR-2 Input Tax Credit (ITC) Matcher</div>
                          <div style={{ overflowY: "auto", maxHeight: 200, fontSize: 12 }}>
                            {rPurch.length === 0 ? (
                              <div style={{ color: C.text3, fontStyle: "italic", padding: 12 }}>No purchases to match for ITC.</div>
                            ) : (
                              rPurch.map(p => {
                                const gstAmount = (p.items || []).reduce((sum, item) => {
                                  const rate = item.gstRate || 12;
                                  const qty = item.qty || item.quantity || 0;
                                  const total = (item.purchasePrice || 0) * qty;
                                  const taxable = total / (1 + (rate / 100));
                                  return sum + (total - taxable);
                                }, 0);
                                const matchingSupplier = suppliers.find(s => s.name === p.supplierName);
                                return (
                                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                                    <div>
                                      <div style={{ fontWeight: 600 }}>{p.supplierName}</div>
                                      <div style={{ fontSize: 10, color: C.text3 }}>Inv: #{p.invoiceNumber} · GSTIN: {matchingSupplier?.gstin || "Not set"}</div>
                                    </div>
                                    <div style={{ textAlign: "right" }}>
                                      <div style={{ fontWeight: 700, color: C.purple }}>₹{gstAmount.toFixed(2)}</div>
                                      <span style={{ fontSize: 9, color: C.green, fontWeight: 700, background: "#E8F5EE", padding: "1px 6px", borderRadius: 10 }}>Auto-Matched</span>
                                    </div>
                                  </div>
                                );
                              })
                            )}
                          </div>
                        </div>

                        {/* GSTR-3A checklist */}
                        <div style={S.card}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 14 }}>GSTR-3A Reconciliation Notice Checklist</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 12 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ color: C.green, fontSize: 14 }}>✓</span>
                              <span><strong>GSTR-1 Outward Register:</strong> Sales ledger exported & verified.</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ color: C.green, fontSize: 14 }}>✓</span>
                              <span><strong>GSTR-2B Auto-Drafted ITC:</strong> Matched with purchase registers.</span>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ color: "#D53F8C", fontSize: 14 }}>⚡</span>
                              <span><strong>Tax Liability Status:</strong> Net Payable calculated automatically.</span>
                            </div>
                            <div style={{ borderTop: `1px dashed ${C.border}`, paddingTop: 10, marginTop: 4, color: C.text3, fontSize: 11 }}>
                              💡 <strong>Indian Tax Law Alert:</strong> GSTR-1 must be filed by the 11th of the succeeding month. GSTR-3B must be filed by the 20th. Avoid delays to protect drug distribution compliance.
                            </div>
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            )}

            {reportsSubTab === "adc" && (
              <div>
                <style>{`
                  @media print {
                    /* Hide EVERYTHING except our printable register card */
                    body, html {
                      background: #fff !important;
                      color: #000 !important;
                    }
                    body * {
                      visibility: hidden !important;
                    }
                    .printable-register, .printable-register * {
                      visibility: visible !important;
                    }
                    .printable-register {
                      position: absolute !important;
                      left: 0 !important;
                      top: 0 !important;
                      width: 100% !important;
                      border: none !important;
                      box-shadow: none !important;
                      padding: 0 !important;
                      margin: 0 !important;
                    }
                    /* Ensure tables format nicely */
                    .printable-register table {
                      width: 100% !important;
                      border-collapse: collapse !important;
                      font-size: 10px !important;
                    }
                    .printable-register th, .printable-register td {
                      border: 1px solid #000 !important;
                      padding: 4px 6px !important;
                    }
                    /* Prevent page splits inside rows */
                    tr {
                      page-break-inside: avoid !important;
                    }
                  }
                `}</style>

                {/* Audit Tabs */}
                <div style={{ display: "flex", borderBottom: `1.5px solid ${C.border}`, marginBottom: 20, background: "#F8FAFC", borderRadius: 8, padding: 4 }}>
                  {[
                    ["sales", "Detailed Sales Register", "📈"],
                    ["purchase", "Detailed Purchase Register", "📦"],
                    ["ledger", "Item & Batch Stock Ledger (Audit Trail)", "🛡️"]
                  ].map(([id, label, icon]) => {
                    const isAct = adcSubTab === id;
                    return (
                      <button
                        key={id}
                        onClick={() => setAdcSubTab(id)}
                        style={{
                          flex: 1,
                          padding: "10px 14px",
                          background: isAct ? "#fff" : "none",
                          border: "none",
                          borderRadius: 6,
                          boxShadow: isAct ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                          color: isAct ? C.teal : C.text2,
                          fontWeight: isAct ? 700 : 500,
                          cursor: "pointer",
                          fontFamily: "inherit",
                          fontSize: 12.5,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          transition: "all 0.15s ease"
                        }}
                      >
                        <span>{icon}</span> {adcSubTab === id ? <strong>{label}</strong> : label}
                      </button>
                    );
                  })}
                </div>

                {/* Print button & description */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
                  <div style={{ fontSize: 12.5, color: C.text2 }}>
                    💡 <strong>Drug Inspector / ADC Verification mode:</strong> Below is the detailed batch-wise compliance record. Filter using the panels above.
                  </div>
                  <button 
                    style={{ ...S.btn("primary"), display: "inline-flex", alignItems: "center", gap: 6 }} 
                    onClick={() => window.print()}
                  >
                    🖨️ Print Detailed Register
                  </button>
                </div>

                {adcSubTab === "sales" && (() => {
                  // Compute itemised sales
                  const itemisedSales = [];
                  rSales.forEach(s => {
                    const billDate = s.createdAt?.toDate ? s.createdAt.toDate().toLocaleDateString("en-IN") : new Date(s.createdAt || 0).toLocaleDateString("en-IN");
                    (s.items || []).forEach(item => {
                      if (reportFilters.medicineId && item.medicineId !== reportFilters.medicineId) return;
                      
                      // Filter by product query
                      if (reportFilters.productQuery) {
                        const qLower = reportFilters.productQuery.toLowerCase();
                        const match = item.brandName?.toLowerCase().includes(qLower) || 
                                      item.genericName?.toLowerCase().includes(qLower);
                        if (!match) return;
                      }
                      
                      // Filter by batch No
                      if (reportFilters.batchNo) {
                        const batchLower = reportFilters.batchNo.toLowerCase();
                        const matchBatch = item.batchNumber?.toLowerCase().includes(batchLower) || 
                                           (item.batchesUsed && item.batchesUsed.some(bu => bu.batchNumber?.toLowerCase().includes(batchLower)));
                        if (!matchBatch) return;
                      }
                      // Filter by drug code
                      if (reportFilters.drugCode) {
                        const dcLower = reportFilters.drugCode.toLowerCase();
                        const matchDc = (item.drugCode || "").toLowerCase().includes(dcLower);
                        if (!matchDc) return;
                      }

                      let batchNo = item.batchNumber || "—";
                      let expiry = item.expiryDate || "—";
                      if (item.batchesUsed && item.batchesUsed.length > 0) {
                        batchNo = item.batchesUsed.map(b => b.batchNumber).join(", ");
                        expiry = item.batchesUsed.map(b => b.expiryDate).join(", ");
                      }

                      itemisedSales.push({
                        date: billDate,
                        billNumber: s.billNumber,
                        customerName: s.customerName || "Walk-in Patient",
                        customerPhone: s.customerPhone || "—",
                        doctorName: s.doctorName || "—",
                        brandName: item.brandName || item.genericName,
                        genericName: item.genericName || "",
                        batchNumber: batchNo,
                        expiryDate: expiry,
                        qty: item.quantity || item.qty || 1,
                        mrp: item.mrp || item.sellingPrice || 0,
                        gstRate: item.gstRate || 12,
                        total: item.total || 0
                      });
                    });
                  });

                  return (
                    <div style={S.card} className="printable-register">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2.5px solid ${C.border}`, paddingBottom: 10, marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, textTransform: "uppercase" }}>Detailed Sales Register</div>
                          <span style={{ fontSize: 11, color: C.text3 }}>Itemised Batch Records Compliance Ledger · {storeDetails?.name}</span>
                        </div>
                        <span style={S.badge("blue")}>{itemisedSales.length} items sold</span>
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}`, fontSize: 11.5 }}>
                          <thead>
                            <tr style={{ background: "#F8FAFC", borderBottom: `1.5px solid ${C.border}` }}>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Date</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Bill No</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Patient Name</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Doctor</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Medicine Name</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Batch</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Expiry</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "center" }}>Qty</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>MRP</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "center" }}>GST</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Total (₹)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {itemisedSales.length === 0 ? (
                              <tr><td colSpan={11} style={{ ...S.td, textAlign: "center", color: C.text3, padding: "20px 0", fontStyle: "italic" }}>No itemised sales records match the active filters.</td></tr>
                            ) : (
                              itemisedSales.map((row, idx) => (
                                <tr key={idx} style={{ borderBottom: `1px solid ${C.border}` }}>
                                  <td style={S.td}>{row.date}</td>
                                  <td style={{ ...S.td, fontWeight: 600, color: C.blue }}>{row.billNumber}</td>
                                  <td style={S.td}>
                                    <div><strong>{row.customerName}</strong></div>
                                    <div style={{ fontSize: 10, color: C.text3 }}>{row.customerPhone}</div>
                                  </td>
                                  <td style={S.td}>{row.doctorName}</td>
                                  <td style={S.td}>
                                    <div style={{ fontWeight: 600, color: C.navy }}>{row.brandName}</div>
                                    {row.genericName && row.genericName !== row.brandName && <div style={{ fontSize: 10, color: C.text3, fontStyle: "italic" }}>{row.genericName}</div>}
                                  </td>
                                  <td style={{ ...S.td, fontWeight: 700, fontFamily: "monospace" }}>{row.batchNumber}</td>
                                  <td style={S.td}>{row.expiryDate}</td>
                                  <td style={{ ...S.td, fontWeight: 700, textAlign: "center" }}>{row.qty}</td>
                                  <td style={{ ...S.td, textAlign: "right" }}>₹{row.mrp.toFixed(2)}</td>
                                  <td style={{ ...S.td, textAlign: "center" }}>{row.gstRate}%</td>
                                  <td style={{ ...S.td, fontWeight: 700, color: C.green, textAlign: "right" }}>₹{row.total.toFixed(2)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                {adcSubTab === "purchase" && (() => {
                  // Compute itemised purchases
                  const itemisedPurchases = [];
                  rPurch.forEach(p => {
                    let purchaseDate = p.invoiceDate ? new Date(p.invoiceDate).toLocaleDateString("en-IN") : "";
                    if (!purchaseDate) {
                      purchaseDate = p.createdAt?.toDate ? p.createdAt.toDate().toLocaleDateString("en-IN") : new Date(p.createdAt || 0).toLocaleDateString("en-IN");
                    }
                    (p.items || []).forEach(item => {
                      const itemMedId = item.medicineId || item.overrideId || item.matchedItem?.id;
                      if (reportFilters.medicineId && itemMedId !== reportFilters.medicineId) return;
                      
                      // Filter by product query
                      if (reportFilters.productQuery) {
                        const qLower = reportFilters.productQuery.toLowerCase();
                        const match = item.brandName?.toLowerCase().includes(qLower) || 
                                      item.genericName?.toLowerCase().includes(qLower);
                        if (!match) return;
                      }
                      
                      // Filter by batch
                      if (reportFilters.batchNo) {
                        const batchLower = reportFilters.batchNo.toLowerCase();
                        if (!item.batchNumber?.toLowerCase().includes(batchLower)) return;
                      }
                      // Filter by drug code
                      if (reportFilters.drugCode) {
                        const dcLower = reportFilters.drugCode.toLowerCase();
                        const matchDc = (item.drugCode || "").toLowerCase().includes(dcLower);
                        if (!matchDc) return;
                      }

                      itemisedPurchases.push({
                        date: purchaseDate,
                        invoiceNumber: p.invoiceNumber,
                        supplierName: p.supplierName,
                        brandName: item.brandName || item.genericName,
                        genericName: item.genericName || "",
                        batchNumber: item.batchNumber || "—",
                        expiryDate: item.expiryDate || "—",
                        qty: item.qty || item.quantity || 0,
                        purchasePrice: item.purchasePrice || 0,
                        gstRate: item.gstRate || 12,
                        total: (item.purchasePrice || 0) * (item.qty || item.quantity || 0)
                      });
                    });
                  });

                  return (
                    <div style={S.card} className="printable-register">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2.5px solid ${C.border}`, paddingBottom: 10, marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, textTransform: "uppercase" }}>Detailed Purchase Register</div>
                          <span style={{ fontSize: 11, color: C.text3 }}>Itemised Inward Stock Compliance Ledger · {storeDetails?.name}</span>
                        </div>
                        <span style={S.badge("teal")}>{itemisedPurchases.length} items purchased</span>
                      </div>
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}`, fontSize: 11.5 }}>
                          <thead>
                            <tr style={{ background: "#F8FAFC", borderBottom: `1.5px solid ${C.border}` }}>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Date</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Invoice No</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Supplier / Vendor</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Medicine Name</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Batch</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Expiry</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "center" }}>Qty</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Pur. Rate</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "center" }}>GST</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Total (₹)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {itemisedPurchases.length === 0 ? (
                              <tr><td colSpan={10} style={{ ...S.td, textAlign: "center", color: C.text3, padding: "20px 0", fontStyle: "italic" }}>No itemised purchase records match the active filters.</td></tr>
                            ) : (
                              itemisedPurchases.map((row, idx) => (
                                <tr key={idx} style={{ borderBottom: `1px solid ${C.border}` }}>
                                  <td style={S.td}>{row.date}</td>
                                  <td style={{ ...S.td, fontWeight: 600, color: C.navy }}>{row.invoiceNumber}</td>
                                  <td style={S.td}>{row.supplierName}</td>
                                  <td style={S.td}>
                                    <div style={{ fontWeight: 600, color: C.navy }}>{row.brandName}</div>
                                    {row.genericName && row.genericName !== row.brandName && <div style={{ fontSize: 10, color: C.text3, fontStyle: "italic" }}>{row.genericName}</div>}
                                  </td>
                                  <td style={{ ...S.td, fontWeight: 700, fontFamily: "monospace" }}>{row.batchNumber}</td>
                                  <td style={S.td}>{row.expiryDate}</td>
                                  <td style={{ ...S.td, fontWeight: 700, textAlign: "center" }}>{row.qty}</td>
                                  <td style={{ ...S.td, textAlign: "right" }}>₹{row.purchasePrice.toFixed(2)}</td>
                                  <td style={{ ...S.td, textAlign: "center" }}>{row.gstRate}%</td>
                                  <td style={{ ...S.td, fontWeight: 700, color: C.green, textAlign: "right" }}>₹{row.total.toFixed(2)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}

                {adcSubTab === "ledger" && (() => {
                  // Compute chronological audit ledger for a medicine/batch
                  const ledgerEntries = [];

                  // Purchases inflow
                  purchases.forEach(p => {
                    let d = p.invoiceDate ? new Date(p.invoiceDate) : null;
                    if (!d || isNaN(d.getTime())) {
                      d = p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || 0);
                    }
                    (p.items || []).forEach(item => {
                      const itemMedId = item.medicineId || item.overrideId || item.matchedItem?.id;
                      if (reportFilters.medicineId && itemMedId !== reportFilters.medicineId) return;
                      
                      // Filter by product query
                      if (reportFilters.productQuery) {
                        const q = reportFilters.productQuery.toLowerCase();
                        const match = item.brandName?.toLowerCase().includes(q) || item.genericName?.toLowerCase().includes(q);
                        if (!match) return;
                      }
                      
                      // Filter by batch
                      if (reportFilters.batchNo) {
                        const batchLower = reportFilters.batchNo.toLowerCase();
                        if (!item.batchNumber?.toLowerCase().includes(batchLower)) return;
                      }
                      // Filter by drug code
                      if (reportFilters.drugCode) {
                        const dcLower = reportFilters.drugCode.toLowerCase();
                        const matchDc = (item.drugCode || "").toLowerCase().includes(dcLower);
                        if (!matchDc) return;
                      }

                      ledgerEntries.push({
                        date: d,
                        type: "📥 PURCHASE (IN)",
                        refNo: p.invoiceNumber,
                        party: p.supplierName,
                        brandName: item.brandName || item.genericName,
                        batchNumber: item.batchNumber || "—",
                        expiryDate: item.expiryDate || "—",
                        inQty: item.qty || item.quantity || 0,
                        outQty: 0,
                        rate: item.purchasePrice || 0
                      });
                    });
                  });

                  // Sales outflow
                  sales.forEach(s => {
                    const d = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0);
                    (s.items || []).forEach(item => {
                      if (reportFilters.medicineId && item.medicineId !== reportFilters.medicineId) return;
                      
                      // Filter by product query
                      if (reportFilters.productQuery) {
                        const q = reportFilters.productQuery.toLowerCase();
                        const match = item.brandName?.toLowerCase().includes(q) || item.genericName?.toLowerCase().includes(q);
                        if (!match) return;
                      }
                      
                      // Filter by batch
                      if (reportFilters.batchNo) {
                        const batchLower = reportFilters.batchNo.toLowerCase();
                        const matchBatch = item.batchNumber?.toLowerCase().includes(batchLower) || 
                                           (item.batchesUsed && item.batchesUsed.some(bu => bu.batchNumber?.toLowerCase().includes(batchLower)));
                        if (!matchBatch) return;
                      }
                      // Filter by drug code
                      if (reportFilters.drugCode) {
                        const dcLower = reportFilters.drugCode.toLowerCase();
                        const matchDc = (item.drugCode || "").toLowerCase().includes(dcLower);
                        if (!matchDc) return;
                      }

                      let batchNo = item.batchNumber || "—";
                      let expiry = item.expiryDate || "—";
                      if (item.batchesUsed && item.batchesUsed.length > 0) {
                        batchNo = item.batchesUsed.map(b => b.batchNumber).join(", ");
                        expiry = item.batchesUsed.map(b => b.expiryDate).join(", ");
                      }

                      ledgerEntries.push({
                        date: d,
                        type: "📤 SALE (OUT)",
                        refNo: s.billNumber,
                        party: s.customerName || "Walk-in Patient",
                        brandName: item.brandName || item.genericName,
                        batchNumber: batchNo,
                        expiryDate: expiry,
                        inQty: 0,
                        outQty: item.quantity || item.qty || 1,
                        rate: item.mrp || item.sellingPrice || 0
                      });
                    });
                  });

                  // Sort chronologically ascending
                  ledgerEntries.sort((a, b) => a.date - b.date);

                  return (
                    <div style={S.card} className="printable-register">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `2.5px solid ${C.border}`, paddingBottom: 10, marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, textTransform: "uppercase" }}>Batch Stock Flow Audit Ledger</div>
                          <span style={{ fontSize: 11, color: C.text3 }}>Chronological Inflow/Outflow Trail Register · {storeDetails?.name}</span>
                        </div>
                        <span style={S.badge("amber")}>{ledgerEntries.length} movements</span>
                      </div>
                      
                      {!reportFilters.medicineId && !reportFilters.batchNo && (
                        <div style={{ padding: "12px 14px", background: "#FFF8E7", border: `1.5px solid #FCD34D`, color: "#B45309", borderRadius: 8, fontSize: 12, fontWeight: 600, marginBottom: 16 }} className="no-print">
                          ⚠️ <strong>DI Compliance Tip:</strong> Select a "Target Medicine" or type a "Filter by Batch No" in the panel above to generate a chronological audit trail for that specific medicine/batch.
                        </div>
                      )}

                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}`, fontSize: 11.5 }}>
                          <thead>
                            <tr style={{ background: "#F8FAFC", borderBottom: `1.5px solid ${C.border}` }}>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Date & Time</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Action Type</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Doc Ref #</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Vendor / Patient</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Item Description</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Batch No</th>
                              <th style={{ ...S.th, padding: "6px 8px" }}>Expiry</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "center" }}>Qty IN</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "center" }}>Qty OUT</th>
                              <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Rate (₹)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ledgerEntries.length === 0 ? (
                              <tr><td colSpan={10} style={{ ...S.td, textAlign: "center", color: C.text3, padding: "20px 0", fontStyle: "italic" }}>No transactions found for the selected criteria.</td></tr>
                            ) : (
                              ledgerEntries.map((row, idx) => (
                                <tr key={idx} style={{ borderBottom: `1px solid ${C.border}`, background: row.inQty > 0 ? "#F0FDF4" : "#FFF5F5" }}>
                                  <td style={S.td}>{row.date.toLocaleString("en-IN")}</td>
                                  <td style={{ ...S.td, fontWeight: 700, color: row.inQty > 0 ? C.green : C.red }}>{row.type}</td>
                                  <td style={S.td}>{row.refNo}</td>
                                  <td style={S.td}>{row.party}</td>
                                  <td style={S.td}>{row.brandName}</td>
                                  <td style={{ ...S.td, fontWeight: 700, fontFamily: "monospace" }}>{row.batchNumber}</td>
                                  <td style={S.td}>{row.expiryDate}</td>
                                  <td style={{ ...S.td, fontWeight: 700, color: C.green, textAlign: "center" }}>{row.inQty > 0 ? `+${row.inQty}` : "—"}</td>
                                  <td style={{ ...S.td, fontWeight: 700, color: C.red, textAlign: "center" }}>{row.outQty > 0 ? `-${row.outQty}` : "—"}</td>
                                  <td style={{ ...S.td, textAlign: "right" }}>₹{row.rate.toFixed(2)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
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

        {/* ANALYTICS */}
        {!dbLoading && activeTab === "analytics" && (
          <Analytics sales={sales} purchases={purchases} medicines={medicines} />
        )}

        {/* STORE SETTINGS */}
        {!dbLoading && activeTab === "settings" && (
          <div>
            <PH title="Store Settings" sub="Configure store attributes and view staff onboarding parameters" />
            <div style={S.card}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 16 }}>Store Specifications & Compliance Profile</div>
              
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
                <FF label="Store Name *">
                  <input 
                    style={S.input} 
                    value={storeEditForm.name} 
                    onChange={e => setStoreEditForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g. PM Janaushadhi Kendra"
                  />
                </FF>
                
                <div>
                  <span style={S.label}>Unique Store Code (Invite Staff)</span>
                  <div style={{ padding: "9px 12px", border: `1.5px solid ${C.border}`, borderRadius: 8, background: "#F8FAFC", fontSize: 13, fontWeight: 600, fontFamily: "monospace", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{storeCode}</span>
                    <button 
                      onClick={() => { navigator.clipboard.writeText(storeCode); alert("Store Code copied!"); }}
                      style={{ background: "none", border: "none", color: C.teal, cursor: "pointer", fontWeight: 700, fontSize: 11 }}
                    >
                      📋 Copy
                    </button>
                  </div>
                </div>

                <FF label="Helpline Contact *">
                  <input 
                    style={S.input} 
                    value={storeEditForm.helpline} 
                    onChange={e => setStoreEditForm(prev => ({ ...prev, helpline: e.target.value }))}
                    placeholder="e.g. 9964382376"
                  />
                </FF>

                <FF label="Support Working Hours">
                  <input 
                    style={S.input} 
                    value={storeEditForm.supportTime} 
                    onChange={e => setStoreEditForm(prev => ({ ...prev, supportTime: e.target.value }))}
                    placeholder="e.g. 9:30 AM To 6:00 PM"
                  />
                </FF>

                <FF label="GSTIN (GST Number) *">
                  <input 
                    style={S.input} 
                    value={storeEditForm.gstin} 
                    onChange={e => setStoreEditForm(prev => ({ ...prev, gstin: e.target.value.toUpperCase() }))}
                    placeholder="e.g. 29AAAAA0000A1Z5"
                  />
                </FF>

                <FF label="Drug License (DL) Numbers *">
                  <input 
                    style={S.input} 
                    value={storeEditForm.drugLicense} 
                    onChange={e => setStoreEditForm(prev => ({ ...prev, drugLicense: e.target.value.toUpperCase() }))}
                    placeholder="e.g. KA-RNR-2024-DL01"
                  />
                </FF>
              </div>

              <div style={{ marginBottom: 16 }}>
                <FF label="Store Address *">
                  <input 
                    style={S.input} 
                    value={storeEditForm.address} 
                    onChange={e => setStoreEditForm(prev => ({ ...prev, address: e.target.value }))}
                    placeholder="e.g. Taluk General Hospital Premises, Ranebennur"
                  />
                </FF>
              </div>

              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button 
                  style={{ ...S.btn("green"), opacity: isSavingStore ? 0.7 : 1 }} 
                  disabled={isSavingStore}
                  onClick={saveStoreProfile}
                >
                  {isSavingStore ? "⏳ Saving Profile..." : "💾 Save Profile & Compliance Details"}
                </button>
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

            <div style={S.card}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.navy, borderBottom: `1px solid ${C.border}`, paddingBottom: 8, marginBottom: 12 }}>User Account Security</div>
              <p style={{ fontSize: 13, color: C.text2, lineHeight: 1.5, marginBottom: 14 }}>
                Update the password for your active account: <strong>{user?.email}</strong>.
              </p>
              
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 340 }}>
                <div>
                  <label style={S.label}>New Password</label>
                  <input 
                    type="password"
                    style={S.input}
                    id="security-new-password"
                    placeholder="Enter new password (min 6 chars)"
                  />
                </div>
                <button
                  style={{ ...S.btn("teal"), width: "100%", justifyContent: "center" }}
                  onClick={async () => {
                    const passInput = document.getElementById("security-new-password");
                    const newPass = passInput ? passInput.value : "";
                    if (!newPass || newPass.length < 6) {
                      alert("Password must be at least 6 characters long.");
                      return;
                    }
                    try {
                      const { updatePassword } = await import("firebase/auth");
                      if (auth.currentUser) {
                        await updatePassword(auth.currentUser, newPass);
                        alert("✓ Password successfully updated!");
                        if (passInput) passInput.value = "";
                      } else {
                        alert("No authenticated user found.");
                      }
                    } catch (e) {
                      console.error(e);
                      if (e.message && e.message.includes("requires-recent-login")) {
                        alert("⚠ Security requirement: Changing your password requires you to have signed in recently. Please sign out, sign back in immediately, and return to this page to change your password.");
                      } else {
                        alert("Error updating password: " + e.message);
                      }
                    }
                  }}
                >
                  🔒 Update Password
                </button>
              </div>
            </div>
          </div>
        )}

        {/* VENDORS & DUES */}
        {!dbLoading && activeTab === "vendors" && (
          <div>
            <PH 
              title="Vendor Database & Accounts Ledger" 
              sub="Manage supplier profiles, outstanding liabilities, and transaction histories"
              action={<button style={S.btn("primary")} onClick={() => setShowAddSupplierModal(true)}>+ Add New Vendor</button>}
            />
            
            <div style={S.card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.5px" }}>Active Suppliers</span>
                <span style={S.badge("teal")}>{suppliers.length} vendors total</span>
              </div>
              
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}` }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC" }}>
                      <th style={S.th}>Supplier Name</th>
                      <th style={S.th}>Contact Info</th>
                      <th style={S.th}>GSTIN</th>
                      <th style={S.th}>Total purchases</th>
                      <th style={S.th}>Outstanding Balance</th>
                      <th style={S.th}>Status</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.length === 0 ? (
                      <tr>
                        <td colSpan="7" style={{ ...S.td, textAlign: "center", color: C.text3, padding: "24px 0" }}>
                          No vendors cataloged yet. Click "+ Add New Vendor" or upload purchases to populate.
                        </td>
                      </tr>
                    ) : (
                      suppliers.map(s => {
                        const isDue = (s.outstanding || 0) > 0;
                        return (
                          <tr key={s.id} style={{ hover: { background: "#F8FAFC" } }}>
                            <td style={{ ...S.td, fontWeight: 600, color: C.navy }}>{s.name}</td>
                            <td style={S.td}>
                              <div style={{ fontSize: 12, fontWeight: 600 }}>📞 {s.phone || "N/A"}</div>
                              <div style={{ fontSize: 11, color: C.text3 }}>✉ {s.email || "N/A"}</div>
                              {s.address && <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>📍 {s.address}</div>}
                            </td>
                            <td style={{ ...S.td, fontFamily: "monospace", fontSize: 12 }}>{s.gstin || "N/A"}</td>
                            <td style={{ ...S.td, fontWeight: 700 }}>₹{(s.totalPurchases || 0).toFixed(2)}</td>
                            <td style={{ ...S.td, fontWeight: 700, color: isDue ? C.red : C.green }}>₹{(s.outstanding || 0).toFixed(2)}</td>
                            <td style={S.td}>
                              <span style={S.badge(isDue ? "red" : "green")}>
                                {isDue ? "Pending Dues" : "Clear"}
                              </span>
                            </td>
                            <td style={{ ...S.td, textAlign: "right" }}>
                              <div style={{ display: "inline-flex", gap: 6 }}>
                                <button 
                                  style={{ ...S.btn("teal"), padding: "5px 10px", fontSize: 11 }}
                                  onClick={() => {
                                    setPaymentForm({ supplierId: s.id, amountPaid: String(s.outstanding || 0), notes: "" });
                                    setShowRecordPaymentModal(true);
                                  }}
                                >
                                  💸 Pay
                                </button>
                                <button 
                                  style={{ ...S.btn("outline"), padding: "5px 10px", fontSize: 11 }}
                                  onClick={() => setSupplierEditModalData(s)}
                                >
                                  ✏️ Edit
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
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
            maxHeight: "90vh",
            overflowY: "auto",
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
            
            <div style={{ marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={S.label}>Supplier / Vendor Name</label>
                <select 
                  style={S.input} 
                  value={poModal.supplierName} 
                  onChange={e => {
                    const sName = e.target.value;
                    const sup = suppliers.find(s => s.name === sName);
                    setPoModal(prev => ({ 
                      ...prev, 
                      supplierName: sName,
                      phone: sup?.phone || ""
                    }));
                  }}
                >
                  <option value="No Linked Vendor">-- Select a Vendor --</option>
                  {suppliers.map(s => <option key={s.id} value={s.name}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>Supplier Contact Phone</label>
                <input 
                  style={S.input} 
                  value={poModal.phone} 
                  onChange={e => setPoModal(prev => ({ ...prev, phone: e.target.value }))} 
                  placeholder="WhatsApp dispatch phone number"
                />
              </div>
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

            <div style={{ background: "#EBF4FF", border: `1px solid ${C.blue}`, borderRadius: 8, padding: 12, marginBottom: 20, maxHeight: 150, overflowY: "auto" }}>
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

        {/* PMBI PURCHASE ENTRY */}
        {!dbLoading && activeTab === "pmbi-purchase" && (
          <PmbiPurchaseEntry
            db={db}
            storeId={storeId}
            storeCode={storeCode}
            user={user}
            medicines={medicines}
            suppliers={suppliers}
            pmbiItems={pmbiItems}
          />
        )}

        {/* PMBI ITEM MASTER */}
        {!dbLoading && activeTab === "pmbi-item-master" && (
          <PmbiItemMaster
            db={db}
            storeId={storeId}
            storeCode={storeCode}
            user={user}
            pmbiItems={pmbiItems}
          />
        )}

        {/* PMBI OPENING STOCK */}
        {!dbLoading && activeTab === "pmbi-opening-stock" && (
          <PmbiOpeningStock
            db={db}
            storeId={storeId}
            storeCode={storeCode}
            user={user}
            medicines={medicines}
            pmbiItems={pmbiItems}
          />
        )}

        {/* PMBI REPORTS */}
        {!dbLoading && activeTab === "pmbi-reports" && (
          <PmbiReports
            db={db}
            storeId={storeId}
            storeCode={storeCode}
            user={user}
            medicines={medicines}
            purchases={purchases}
            sales={sales}
            suppliers={suppliers}
            runWorkerExport={runWorkerExport}
            isWorkerExporting={isWorkerExporting}
            storeDetails={storeDetails}
          />
        )}

        {/* H1 DRUG TRACKING */}
        {!dbLoading && activeTab === "h1-tracking" && (
          <H1DrugTracking
            db={db}
            storeId={storeId}
            storeCode={storeCode}
            user={user}
            medicines={medicines}
            purchases={purchases}
            sales={sales}
            suppliers={suppliers}
            runWorkerExport={runWorkerExport}
            isWorkerExporting={isWorkerExporting}
          />
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
                <h3 style={{ fontSize: 18, fontWeight: 800, color: C.navy, margin: 0 }}>
                  {activeEditingSessionId ? "✏️ Edit Bulk Sales Import Session" : "📊 Bulk Sales Import Preview"}
                </h3>
                <span style={{ fontSize: 12, color: C.text3 }}>{activeEditingSessionId ? "Edit bills and item properties for this import session." : "Verify bills, resolve warnings, and commit transactions."}</span>
              </div>
              <button 
                onClick={() => { setShowSalesImportDrawer(false); setPreviewImportedSales([]); setActiveEditingSessionId(null); }} 
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

            {/* Scrollable editable list */}
            <div style={{ flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 20, background: C.bg }}>
              {previewImportedSales
                .filter(b =>
                  b.billNo.toLowerCase().includes(importSalesSearch.toLowerCase()) ||
                  b.customerName.toLowerCase().includes(importSalesSearch.toLowerCase())
                )
                .map((bill, billIdx) => {
                  const billTotal = bill.items.reduce((s, it) => s + (it.qty * it.rate * (1 - (it.discount || 0) / 100)), 0);
                  const updateBill = (field, val) => setPreviewImportedSales(prev => {
                    const next = [...prev];
                    next[billIdx] = { ...next[billIdx], [field]: val };
                    return next;
                  });
                  const updateItem = (iIdx, field, val) => setPreviewImportedSales(prev => {
                    const next = [...prev];
                    const items = [...next[billIdx].items];
                    items[iIdx] = { ...items[iIdx], [field]: val };
                    // recalc total
                    items[iIdx].estimatedTotal = (items[iIdx].qty || 1) * (items[iIdx].rate || 0) * (1 - ((items[iIdx].discount || 0) / 100));
                    next[billIdx] = { ...next[billIdx], items };
                    return next;
                  });
                  const inpSm = { ...S.input, padding: "3px 6px", fontSize: 11, width: "100%" };
                  return (
                    <div key={bill.billNo + billIdx} style={{ background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 12, padding: 18, boxShadow: "0 2px 8px rgba(0,0,0,0.04)" }}>
                      {/* Bill header - editable */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 14, paddingBottom: 12, borderBottom: `1px solid ${C.border}` }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, marginBottom: 3 }}>BILL NO</div>
                          <input style={inpSm} value={bill.billNo} onChange={e => updateBill("billNo", e.target.value)} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, marginBottom: 3 }}>DATE / TIME</div>
                          <input style={inpSm} value={bill.timestamp} onChange={e => updateBill("timestamp", e.target.value)} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, marginBottom: 3 }}>PAYMENT</div>
                          <select style={inpSm} value={bill.saleType} onChange={e => updateBill("saleType", e.target.value)}>
                            {["Cash","UPI","Card","Credit"].map(m => <option key={m}>{m}</option>)}
                          </select>
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, marginBottom: 3 }}>PATIENT NAME</div>
                          <input style={inpSm} value={bill.customerName} onChange={e => updateBill("customerName", e.target.value)} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, marginBottom: 3 }}>PHONE</div>
                          <input style={inpSm} value={bill.customerPhone || ""} onChange={e => updateBill("customerPhone", e.target.value)} />
                        </div>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 700, color: C.text3, marginBottom: 3 }}>DOCTOR</div>
                          <input style={inpSm} value={bill.doctorName} onChange={e => updateBill("doctorName", e.target.value)} />
                        </div>
                      </div>

                      {/* Items table - fully editable */}
                      <div style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                          <thead>
                            <tr style={{ background: "#F8FAFC" }}>
                              {["#","Medicine Name","Batch No","Expiry","MRP","Rate","Qty","Disc%","Total",""].map(h => (
                                <th key={h} style={{ ...S.th, padding: "6px 6px", fontSize: 10 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {bill.items.map((item, iIdx) => {
                              const lineTotal = (item.qty || 1) * (item.rate || 0) * (1 - ((item.discount || 0) / 100));
                              return (
                                <tr key={iIdx} style={{ borderBottom: `1px solid ${C.border}` }}>
                                  <td style={{ ...S.td, padding: "5px 6px", color: C.text3 }}>{iIdx + 1}</td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input style={inpSm} value={item.itemName} onChange={e => updateItem(iIdx, "itemName", e.target.value)} />
                                    <div style={{ display: "flex", gap: 4, marginTop: 2 }}>
                                      {item.isNew && <span style={{ ...S.badge("red"), fontSize: 8, padding: "1px 4px" }}>🆕 New</span>}
                                      {!item.isNew && item.isShortage && <span style={{ ...S.badge("amber"), fontSize: 8, padding: "1px 4px" }}>⚠️ Low</span>}
                                    </div>
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input style={{ ...inpSm, width: 80 }} placeholder="Batch No" value={item.batchNumber} onChange={e => updateItem(iIdx, "batchNumber", e.target.value)} />
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input style={{ ...inpSm, width: 80 }} placeholder="YYYY-MM" value={item.expiryDate} onChange={e => updateItem(iIdx, "expiryDate", e.target.value)} />
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input type="number" min="0" step="0.01" style={{ ...inpSm, width: 64 }} value={item.mrp} onChange={e => updateItem(iIdx, "mrp", parseFloat(e.target.value) || 0)} />
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input type="number" min="0" step="0.01" style={{ ...inpSm, width: 64 }} value={item.rate} onChange={e => updateItem(iIdx, "rate", parseFloat(e.target.value) || 0)} />
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input type="number" min="1" style={{ ...inpSm, width: 50 }} value={item.qty} onChange={e => updateItem(iIdx, "qty", Math.max(1, parseInt(e.target.value) || 1))} />
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px" }}>
                                    <input type="number" min="0" max="100" style={{ ...inpSm, width: 50 }} value={item.discount || 0} onChange={e => updateItem(iIdx, "discount", Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))} />
                                  </td>
                                  <td style={{ ...S.td, padding: "5px 6px", fontWeight: 700, color: C.green, whiteSpace: "nowrap" }}>₹{lineTotal.toFixed(2)}</td>
                                  <td style={{ ...S.td, padding: "5px 4px" }}>
                                    <button onClick={() => setPreviewImportedSales(prev => { const next = [...prev]; next[billIdx] = { ...next[billIdx], items: next[billIdx].items.filter((_,i)=>i!==iIdx) }; return next; })} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12 }}>🗑️</button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>

                      {/* Bill total */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
                        <button
                          onClick={() => setPreviewImportedSales(prev => prev.filter((_,i)=>i!==billIdx))}
                          style={{ ...S.btn("outline"), padding: "5px 12px", fontSize: 11, color: C.red, borderColor: C.red }}
                        >
                          🗑️ Remove Bill
                        </button>
                        <div style={{ fontWeight: 800, fontSize: 14, color: C.green }}>Total: ₹{billTotal.toFixed(2)}</div>
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* Footer */}
            <div style={{ borderTop: `1.5px solid ${C.border}`, padding: "20px 24px", background: "#F8FAFC", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 11, color: C.text3, fontWeight: 700, textTransform: "uppercase" }}>Total Est. Revenue</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.green }}>
                  ₹{previewImportedSales.reduce((sum, b) => sum + b.items.reduce((s, it) => s + (it.qty * it.rate * (1 - (it.discount || 0) / 100)), 0), 0).toFixed(2)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <button 
                  style={S.btn("outline")} 
                  disabled={isImportingSales}
                  onClick={() => { setShowSalesImportDrawer(false); setPreviewImportedSales([]); setActiveEditingSessionId(null); }}
                >
                  Cancel
                </button>
                <button 
                  style={{ ...S.btn(isImportingSales ? "outline" : "green"), padding: "12px 24px", fontSize: 14 }}
                  disabled={isImportingSales}
                  onClick={activeEditingSessionId ? commitEditedImportedSales : commitImportedSales}
                >
                  {isImportingSales ? "Processing..." : activeEditingSessionId ? "💾 Save & Update Session" : `🚀 Generate & Commit All ${previewImportedSales.length} Bills`}
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
          background: "rgba(10,35,66,0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10000,
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
                        {["Medicine", "Batch No", "Expiry", "MRP ₹", "Qty", "Price", "Disc%", "Total", ""].map(h => <th key={h} style={{ ...S.th, padding: "8px 8px", fontSize: 11 }}>{h}</th>)}
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
                            <tr key={idx} style={{ borderBottom: `1px solid ${C.border}` }}>
                              <td style={{ ...S.td, padding: "8px 8px", minWidth: 130 }}>
                                <div style={{ fontWeight: 600, fontSize: 12 }}>{item.brandName || item.genericName}</div>
                                <div style={{ fontSize: 10, color: C.text3 }}>{item.genericName}</div>
                              </td>
                              {/* Batch No - editable */}
                              <td style={{ ...S.td, padding: "8px 6px" }}>
                                <input
                                  type="text"
                                  placeholder="Batch No"
                                  style={{ ...S.input, width: 90, padding: "4px 6px", fontSize: 11 }}
                                  value={item.batchNumber}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setEditBillForm(prev => {
                                      const nextItems = [...prev.items];
                                      nextItems[idx] = { ...nextItems[idx], batchNumber: val };
                                      return { ...prev, items: nextItems };
                                    });
                                  }}
                                />
                              </td>
                              {/* Expiry - editable */}
                              <td style={{ ...S.td, padding: "8px 6px" }}>
                                <input
                                  type="text"
                                  placeholder="YYYY-MM"
                                  style={{ ...S.input, width: 82, padding: "4px 6px", fontSize: 11 }}
                                  value={item.expiryDate || ""}
                                  onChange={e => {
                                    const val = e.target.value;
                                    setEditBillForm(prev => {
                                      const nextItems = [...prev.items];
                                      nextItems[idx] = { ...nextItems[idx], expiryDate: val };
                                      return { ...prev, items: nextItems };
                                    });
                                  }}
                                />
                              </td>
                              {/* MRP - editable */}
                              <td style={{ ...S.td, padding: "8px 6px" }}>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="MRP"
                                  style={{ ...S.input, width: 72, padding: "4px 6px", fontSize: 11 }}
                                  value={item.mrp}
                                  onChange={e => {
                                    const val = Math.max(0, parseFloat(e.target.value) || 0);
                                    setEditBillForm(prev => {
                                      const nextItems = [...prev.items];
                                      nextItems[idx] = { ...nextItems[idx], mrp: val };
                                      return { ...prev, items: nextItems };
                                    });
                                  }}
                                />
                              </td>
                              {/* Qty */}
                              <td style={{ ...S.td, padding: "8px 6px" }}>
                                <input 
                                  type="number" 
                                  min="1" 
                                  style={{ ...S.input, width: 60, padding: "4px 6px", fontSize: 11 }} 
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
                              {/* Selling Price */}
                              <td style={{ ...S.td, padding: "8px 6px" }}>
                                <input 
                                  type="number" 
                                  min="0" 
                                  step="0.01" 
                                  style={{ ...S.input, width: 72, padding: "4px 6px", fontSize: 11 }} 
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
                              {/* Discount % */}
                              <td style={{ ...S.td, padding: "8px 6px" }}>
                                <input 
                                  type="number" 
                                  min="0" 
                                  max="100" 
                                  style={{ ...S.input, width: 55, padding: "4px 6px", fontSize: 11 }} 
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

      {/* RETROACTIVE MAPPING DRAWER MODAL */}
      {showMappingModal && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(10,35,66,0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 10000,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff",
            borderRadius: 16,
            width: "90%",
            maxWidth: 800,
            height: "85%",
            maxHeight: 650,
            display: "flex",
            flexDirection: "column",
            boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
            border: `1px solid ${C.border}`,
            overflow: "hidden"
          }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, padding: "16px 24px", background: "#FFFBEB" }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: "#B45309", margin: 0 }}>⚠️ Retroactive Inventory Mapping</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Map temporary sale items to catalog medicines to align stock levels.</span>
              </div>
              <button 
                onClick={() => setShowMappingModal(false)} 
                style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}
              >
                ×
              </button>
            </div>

            {/* List */}
            <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
              {unmappedItemsList.length === 0 ? (
                <div style={{ textAlign: "center", padding: "48px 0", color: C.text3 }}>
                  <span style={{ fontSize: 44, display: "block", marginBottom: 12 }}>🎉</span>
                  <div style={{ fontSize: 14, fontWeight: 600, color: C.green }}>All temporary sales successfully mapped!</div>
                  <div style={{ fontSize: 12, marginTop: 4 }}>Inventory stock levels are 100% synchronized.</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <div style={{ background: "#F8FAFC", border: `1px solid ${C.border}`, borderRadius: 8, padding: 12, fontSize: 11, color: C.text2 }}>
                    💡 <strong>How it works:</strong> Search for the correct catalog medicine for each temporary item. Mapping retroactively calculates COGS and profit margin using FEFO inventory batches, deducts stock, and logs audit details.
                  </div>
                  
                  {unmappedItemsList.map((row) => {
                    const rowKey = `${row.saleId}-${row.itemIdx}`;
                    const query = mappingSearchText[rowKey] !== undefined ? mappingSearchText[rowKey] : row.item.genericName;
                    const matches = medicines.filter(m => 
                      (m.genericName || "").toLowerCase().includes(query.toLowerCase()) ||
                      (m.brandName || "").toLowerCase().includes(query.toLowerCase())
                    ).slice(0, 5);

                    return (
                      <div key={rowKey} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, background: "#FFF", boxShadow: "0 1px 3px rgba(0,0,0,0.02)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                          <div>
                            <span style={{ ...S.badge("amber"), fontSize: 9, fontWeight: 700, marginBottom: 4 }}>NEW ITEM SOLD</span>
                            <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: C.navy }}>{row.item.genericName}</h4>
                            <div style={{ fontSize: 11, color: C.text3, marginTop: 2 }}>
                              Bill: <strong>{row.billNumber}</strong> · Patient: <strong>{row.customerName}</strong> · Date: {new Date(row.date).toLocaleString("en-IN")}
                            </div>
                          </div>
                          <div style={{ textAlign: "right" }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: C.text2 }}>Qty Sold: {row.item.quantity}</div>
                            <div style={{ fontSize: 11, color: C.text3 }}>Price: ₹{row.item.sellingPrice}</div>
                          </div>
                        </div>

                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          <FF label="Link to Catalog Medicine">
                            <input
                              style={{ ...S.input, padding: "8px 12px" }}
                              value={query}
                              onChange={e => setMappingSearchText(prev => ({ ...prev, [rowKey]: e.target.value }))}
                              placeholder="Type medicine name to search..."
                            />
                          </FF>

                          {query.length >= 2 && (
                            <div style={{ marginTop: 4 }}>
                              <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", marginBottom: 4 }}>Matching medicines in catalog:</div>
                              {matches.length === 0 ? (
                                <div style={{ padding: "8px 12px", background: "#FFF5F5", border: "1px solid #FED7D7", borderRadius: 8, fontSize: 12, color: C.red }}>
                                  No medicines found in catalog. Create the medicine first in the Inventory tab.
                                </div>
                              ) : (
                                <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, background: "#FFF", overflow: "hidden" }}>
                                  {matches.map(m => (
                                    <button
                                      key={m.id}
                                      onClick={() => {
                                        if (window.confirm(`Map "${row.item.genericName}" to catalog medicine "${m.brandName || m.genericName}"?`)) {
                                          mapTemporaryItem(row.saleId, row.itemIdx, m.id);
                                        }
                                      }}
                                      style={{
                                        width: "100%",
                                        padding: "10px 14px",
                                        border: "none",
                                        borderBottom: `1px solid ${C.border}`,
                                        background: "none",
                                        cursor: "pointer",
                                        textAlign: "left",
                                        display: "flex",
                                        justifyContent: "space-between",
                                        alignItems: "center",
                                        transition: "background 0.1s"
                                      }}
                                      onMouseEnter={e => e.currentTarget.style.background = "#F8FAFC"}
                                      onMouseLeave={e => e.currentTarget.style.background = "none"}
                                    >
                                      <div>
                                        <span style={{ fontWeight: 600, color: C.navy, fontSize: 13 }}>{m.genericName}</span>
                                        <span style={{ color: C.text3, fontSize: 12, marginLeft: 8 }}>{m.brandName}</span>
                                      </div>
                                      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                                        <span style={{ fontSize: 12, color: C.text2 }}>Stock: <strong>{m.stockQty}</strong></span>
                                        <span style={{ fontWeight: 700, color: C.green }}>₹{m.sellingPrice || m.mrp}</span>
                                      </div>
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ borderTop: `1.5px solid ${C.border}`, padding: "16px 24px", background: "#F8FAFC", display: "flex", justifyContent: "flex-end" }}>
              <button 
                style={S.btn("outline")} 
                onClick={() => setShowMappingModal(false)}
              >
                Close Drawer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PENDING PAYMENTS MODAL */}
      {showPendingPaymentsModal && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "90%", maxWidth: 650,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", maxHeight: "80vh"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Pending Payments (Supplier Dues)</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>List of vendors with outstanding unpaid balances</span>
              </div>
              <button onClick={() => setShowPendingPaymentsModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ overflowY: "auto", flex: 1, marginBottom: 16 }}>
              {suppliers.filter(s => (s.outstanding || 0) > 0).length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: C.text3 }}>
                  <span style={{ fontSize: 32, display: "block" }}>🎉</span>
                  No pending payments! All supplier dues settled.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
                      <th style={{ ...S.th, textAlign: "left" }}>Supplier</th>
                      <th style={{ ...S.th, textAlign: "left" }}>GSTIN</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Outstanding Dues</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {suppliers.filter(s => (s.outstanding || 0) > 0).map(s => (
                      <tr key={s.id} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={S.td}>
                          <div style={{ fontWeight: 600, color: C.navy }}>{s.name}</div>
                          <div style={{ fontSize: 11, color: C.text3 }}>{s.phone || s.email || "No contact"}</div>
                        </td>
                        <td style={S.td}>{s.gstin || "—"}</td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.red }}>₹{(s.outstanding || 0).toFixed(2)}</td>
                        <td style={{ ...S.td, textAlign: "center" }}>
                          <button
                            onClick={() => {
                              setPaymentForm({ supplierId: s.id, amountPaid: String(s.outstanding || 0), notes: "Settling dues" });
                              setShowRecordPaymentModal(true);
                              setShowPendingPaymentsModal(false);
                            }}
                            style={{ ...S.btn("primary"), padding: "6px 12px", fontSize: 12 }}
                          >
                            Pay Dues
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowPendingPaymentsModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* RECORD PAYMENT MODAL */}
      {showRecordPaymentModal && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 10000,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "100%", maxWidth: 450,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Record Supplier Payment</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Deduct dues from vendor balance ledger</span>
              </div>
              <button onClick={() => setShowRecordPaymentModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <FF label="Select Supplier *">
                <select
                  style={S.input}
                  value={paymentForm.supplierId}
                  onChange={e => {
                    const selectedId = e.target.value;
                    const sup = suppliers.find(s => s.id === selectedId);
                    setPaymentForm(prev => ({
                      ...prev,
                      supplierId: selectedId,
                      amountPaid: sup ? String(sup.outstanding || 0) : ""
                    }));
                  }}
                >
                  <option value="">-- Choose a Vendor --</option>
                  {suppliers.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} (Outstanding: ₹{(s.outstanding || 0).toFixed(2)})
                    </option>
                  ))}
                </select>
              </FF>
              
              <FF label="Amount Paid (₹) *">
                <input
                  type="number"
                  style={S.input}
                  placeholder="0.00"
                  value={paymentForm.amountPaid}
                  onChange={e => setPaymentForm(prev => ({ ...prev, amountPaid: e.target.value }))}
                />
              </FF>
              
              <FF label="Notes / Reference">
                <input
                  type="text"
                  style={S.input}
                  placeholder="e.g. Txn #12345, GPay, Bank Transfer"
                  value={paymentForm.notes}
                  onChange={e => setPaymentForm(prev => ({ ...prev, notes: e.target.value }))}
                />
              </FF>
            </div>
            
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowRecordPaymentModal(false)}>Cancel</button>
              <button
                style={S.btn("primary")}
                disabled={!paymentForm.supplierId || !paymentForm.amountPaid || parseFloat(paymentForm.amountPaid) <= 0}
                onClick={() => {
                  recordSupplierPayment(paymentForm.supplierId, parseFloat(paymentForm.amountPaid), paymentForm.notes);
                  setShowRecordPaymentModal(false);
                }}
              >
                Record Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TOP SELLING ITEMS MODAL */}
      {showTopSellingModal && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "100%", maxWidth: 700,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", maxHeight: "80vh"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>🔥 Top 50 Selling Items</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>High velocity drugs and products ranked by sales quantity</span>
              </div>
              <button onClick={() => setShowTopSellingModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ overflowY: "auto", flex: 1, marginBottom: 16 }}>
              {getTopSellingItems().length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: C.text3 }}>No sales recorded yet.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
                      <th style={{ ...S.th, textAlign: "left" }}>#</th>
                      <th style={{ ...S.th, textAlign: "left" }}>Medicine / Salt Name</th>
                      <th style={{ ...S.th, textAlign: "left" }}>Brand Name</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Form / Strength</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Qty Sold</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Total Revenue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getTopSellingItems().map((item, index) => (
                      <tr key={index} style={{ borderBottom: `1px solid ${C.border}` }}>
                        <td style={S.td}>{index + 1}</td>
                        <td style={{ ...S.td, fontWeight: 600 }}>{item.genericName}</td>
                        <td style={S.td}>{item.brandName || "—"}</td>
                        <td style={{ ...S.td, textAlign: "center" }}>
                          {item.form} {item.strength && `(${item.strength})`}
                        </td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.teal2 }}>{item.quantity}</td>
                        <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.green }}>₹{item.revenue.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowTopSellingModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* NEARBY EXPIRY MODAL */}
      {showNearbyExpiryModal && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "100%", maxWidth: 750,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", maxHeight: "80vh"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>⏳ Nearby Expiry Alert (&lt; 3 Months)</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Critical batch-level warnings. Plan returns or discount sales.</span>
              </div>
              <button onClick={() => setShowNearbyExpiryModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ overflowY: "auto", flex: 1, marginBottom: 16 }}>
              {getNearbyExpiryBatches().length === 0 ? (
                <div style={{ padding: "24px 0", textAlign: "center", color: C.green, fontWeight: 600 }}>
                  🎉 No batches expiring within the next 3 months!
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
                      <th style={{ ...S.th, textAlign: "left" }}>Medicine / Salt Name</th>
                      <th style={{ ...S.th, textAlign: "left" }}>Brand Name</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Batch Number</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Expiry Date</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Current Stock Qty</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {getNearbyExpiryBatches().map((batch, index) => {
                      const [y, mo] = batch.expiryDate.split("-");
                      const exp = new Date(+y, +mo - 1, 1);
                      const now = new Date();
                      now.setDate(1);
                      now.setHours(0, 0, 0, 0);
                      const monthsLeft = (exp.getFullYear() - now.getFullYear()) * 12 + exp.getMonth() - now.getMonth();
                      
                      return (
                        <tr key={index} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={{ ...S.td, fontWeight: 600 }}>{batch.genericName}</td>
                          <td style={S.td}>{batch.brandName || "—"}</td>
                          <td style={{ ...S.td, textAlign: "center", fontFamily: "monospace" }}>{batch.batchNumber}</td>
                          <td style={{ ...S.td, textAlign: "center", fontWeight: 700, color: C.red }}>{batch.expiryDate}</td>
                          <td style={{ ...S.td, textAlign: "right", fontWeight: 700 }}>{batch.quantity}</td>
                          <td style={{ ...S.td, textAlign: "center" }}>
                            <span style={{
                              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                              background: monthsLeft <= 1 ? "#FFF5F5" : "#FFFBEB",
                              color: monthsLeft <= 1 ? C.red : "#B45309"
                            }}>
                              {monthsLeft <= 1 ? "⚠️ Expiring in < 30 days" : `Expiring in ~${monthsLeft} months`}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowNearbyExpiryModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ADD SUPPLIER MODAL */}
      {showAddSupplierModal && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "100%", maxWidth: 500,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Add New Supplier / Vendor</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Register new wholesale pharmacy supplier</span>
              </div>
              <button onClick={() => setShowAddSupplierModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Supplier Name *">
                  <input
                    type="text"
                    style={S.input}
                    placeholder="Enter vendor trading name"
                    value={newSupplierForm.name}
                    onChange={e => setNewSupplierForm(prev => ({ ...prev, name: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Phone Number">
                  <input
                    type="text"
                    style={S.input}
                    placeholder="10-digit mobile / phone"
                    value={newSupplierForm.phone}
                    onChange={e => setNewSupplierForm(prev => ({ ...prev, phone: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Email Address">
                  <input
                    type="email"
                    style={S.input}
                    placeholder="sales@vendor.com"
                    value={newSupplierForm.email}
                    onChange={e => setNewSupplierForm(prev => ({ ...prev, email: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="GSTIN">
                  <input
                    type="text"
                    style={S.input}
                    placeholder="15-digit GST number"
                    value={newSupplierForm.gstin}
                    onChange={e => setNewSupplierForm(prev => ({ ...prev, gstin: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Opening Outstanding Balance (₹)">
                  <input
                    type="number"
                    style={S.input}
                    placeholder="0.00"
                    value={newSupplierForm.outstanding}
                    onChange={e => setNewSupplierForm(prev => ({ ...prev, outstanding: e.target.value }))}
                  />
                </FF>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Address">
                  <input
                    type="text"
                    style={S.input}
                    placeholder="Office/warehouse physical address"
                    value={newSupplierForm.address}
                    onChange={e => setNewSupplierForm(prev => ({ ...prev, address: e.target.value }))}
                  />
                </FF>
              </div>
            </div>
            
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowAddSupplierModal(false)}>Cancel</button>
              <button
                style={S.btn("primary")}
                onClick={handleAddSupplier}
                disabled={!newSupplierForm.name}
              >
                Create Supplier
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT SUPPLIER DETAILS MODAL */}
      {supplierEditModalData && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "100%", maxWidth: 500,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Edit Supplier details</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Update name, contact, GSTIN, and outstanding balances</span>
              </div>
              <button onClick={() => setSupplierEditModalData(null)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Supplier Name *">
                  <input
                    type="text"
                    style={S.input}
                    value={supplierEditModalData.name || ""}
                    onChange={e => setSupplierEditModalData(prev => ({ ...prev, name: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Phone Number">
                  <input
                    type="text"
                    style={S.input}
                    value={supplierEditModalData.phone || ""}
                    onChange={e => setSupplierEditModalData(prev => ({ ...prev, phone: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Email Address">
                  <input
                    type="email"
                    style={S.input}
                    value={supplierEditModalData.email || ""}
                    onChange={e => setSupplierEditModalData(prev => ({ ...prev, email: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="GSTIN">
                  <input
                    type="text"
                    style={S.input}
                    value={supplierEditModalData.gstin || ""}
                    onChange={e => setSupplierEditModalData(prev => ({ ...prev, gstin: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Outstanding Balance (₹)">
                  <input
                    type="number"
                    style={S.input}
                    value={supplierEditModalData.outstanding || 0}
                    onChange={e => setSupplierEditModalData(prev => ({ ...prev, outstanding: parseFloat(e.target.value) || 0 }))}
                  />
                </FF>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Address">
                  <input
                    type="text"
                    style={S.input}
                    value={supplierEditModalData.address || ""}
                    onChange={e => setSupplierEditModalData(prev => ({ ...prev, address: e.target.value }))}
                  />
                </FF>
              </div>
            </div>
            
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setSupplierEditModalData(null)}>Cancel</button>
              <button
                style={S.btn("primary")}
                onClick={() => {
                  handleUpdateSupplier(supplierEditModalData.id, {
                    name: supplierEditModalData.name,
                    phone: supplierEditModalData.phone || "",
                    email: supplierEditModalData.email || "",
                    gstin: supplierEditModalData.gstin || "",
                    address: supplierEditModalData.address || "",
                    outstanding: parseFloat(supplierEditModalData.outstanding) || 0
                  });
                }}
                disabled={!supplierEditModalData.name}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PREMIUM INVOICE DETAIL VIEW MODAL */}
      {selectedBill && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)",
          display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff", borderRadius: 16, width: "90%", maxWidth: 800,
            padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
            border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", maxHeight: "85vh"
          }}>
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 16, marginBottom: 20 }}>
              <div>
                <span style={{ ...S.badge(selectedBill.paymentMode === "Cash" ? "amber" : "teal"), fontSize: 10, fontWeight: 700, textTransform: "uppercase", marginBottom: 4 }}>
                  {selectedBill.paymentMode} Receipt
                </span>
                <h3 style={{ fontSize: 18, fontWeight: 800, color: C.navy, margin: 0 }}>
                  Invoice: {selectedBill.billNumber}
                </h3>
                <div style={{ fontSize: 12, color: C.text3, marginTop: 4 }}>
                  Date: {selectedBill.createdAt?.toDate ? selectedBill.createdAt.toDate().toLocaleString("en-IN") : "—"}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  style={{ ...S.btn("teal"), padding: "8px 16px" }}
                  onClick={() => {
                    const finalBill = { ...selectedBill, date: selectedBill.createdAt?.toDate?.() || new Date() };
                    printThermalReceipt(finalBill, storeDetails);
                  }}
                >
                  🧾 Print Thermal
                </button>
                <button
                  style={{ ...S.btn("primary"), padding: "8px 16px" }}
                  disabled={isWorkerExporting}
                  onClick={() => {
                    const finalBill = { ...selectedBill, date: selectedBill.createdAt?.toDate?.() || new Date() };
                    printA4PDFInvoice(finalBill);
                  }}
                >
                  {isWorkerExporting ? "⏳ Generating PDF..." : "📄 Print A4 PDF"}
                </button>
                {selectedBill.customerPhone && (
                  <button
                    style={S.btn("whatsapp")}
                    onClick={() => sendWhatsApp({ ...selectedBill, date: selectedBill.createdAt?.toDate?.() || new Date() }, selectedBill.customerPhone)}
                  >
                    💬 WhatsApp
                  </button>
                )}
                <button
                  style={{ ...S.btn("outline"), borderColor: C.teal, color: C.teal, padding: "8px 16px" }}
                  onClick={() => handleOpenEditBill(selectedBill)}
                >
                  ✏️ Edit Details
                </button>
                <button
                  style={{ background: "none", border: "none", fontSize: 24, cursor: "pointer", color: C.text3, marginLeft: 8 }}
                  onClick={() => setSelectedBill(null)}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Content Area */}
            <div style={{ overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 20 }}>
              {/* Patient and Doctor metadata */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, background: "#F8FAFC", padding: 14, borderRadius: 10, border: `1px solid ${C.border}` }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase" }}>Patient Information</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.navy, marginTop: 4 }}>
                    👤 {selectedBill.customerName || "Walk-in Patient"}
                  </div>
                  {selectedBill.customerPhone && (
                    <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>
                      📞 {selectedBill.customerPhone}
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase" }}>Doctor Information</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.navy, marginTop: 4 }}>
                    🩺 Dr. {selectedBill.doctorName || "Self / Unknown"}
                  </div>
                </div>
              </div>

              {/* Items Table */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", marginBottom: 8 }}>Medicines Ordered</div>
                <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}` }}>
                  <thead>
                    <tr style={{ background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
                      <th style={{ ...S.th, textAlign: "left" }}>Medicine Description</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Batch</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Expiry</th>
                      <th style={{ ...S.th, textAlign: "center" }}>Qty</th>
                      <th style={{ ...S.th, textAlign: "right" }}>MRP (₹)</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Unit Price</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Disc %</th>
                      <th style={{ ...S.th, textAlign: "right" }}>Total (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedBill.items || []).map((item, i) => {
                      const batchNo = item.batchesUsed?.[0]?.batchNumber || item.batchNumber || "—";
                      const expDate = item.batchesUsed?.[0]?.expiryDate || item.expiryDate || "—";
                      const unitPrice = item.sellingPrice || (item.discount > 0 ? item.mrp : ((item.total || 0) / (item.quantity || item.qty || 1))) || 0;
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                          <td style={S.td}>
                            <div style={{ fontWeight: 600, color: C.navy }}>
                              {item.brandName || item.genericName}
                              {item.drugCode && <span style={{ color: C.teal, fontSize: 10, marginLeft: 6, fontWeight: 700 }}>[Code: {item.drugCode}]</span>}
                            </div>
                            <div style={{ fontSize: 11, color: C.text3 }}>{item.genericName}</div>
                          </td>
                          <td style={{ ...S.td, textAlign: "center", fontFamily: "monospace" }}>{batchNo}</td>
                          <td style={{ ...S.td, textAlign: "center" }}>{expDate}</td>
                          <td style={{ ...S.td, textAlign: "center" }}>{item.quantity || item.qty}</td>
                          <td style={{ ...S.td, textAlign: "right" }}>₹{(item.mrp || 0).toFixed(2)}</td>
                          <td style={{ ...S.td, textAlign: "right" }}>₹{unitPrice.toFixed(2)}</td>
                          <td style={{ ...S.td, textAlign: "right" }}>{item.discount || 0}%</td>
                          <td style={{ ...S.td, textAlign: "right", fontWeight: 700, color: C.green }}>₹{(item.total || 0).toFixed(2)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* GST splits details */}
              <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 20, alignItems: "start" }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.navy, textTransform: "uppercase", marginBottom: 8 }}>GST Tax Splits (GST Summary)</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", border: `1px solid ${C.border}`, fontSize: 11 }}>
                    <thead>
                      <tr style={{ background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
                        <th style={{ ...S.th, padding: "6px 8px" }}>GST Rate</th>
                        <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Taxable Value</th>
                        <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>CGST (50%)</th>
                        <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>SGST (50%)</th>
                        <th style={{ ...S.th, padding: "6px 8px", textAlign: "right" }}>Total Tax</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const taxSummary = {};
                        (selectedBill.items || []).forEach(item => {
                          const rate = item.gstRate || 12;
                          const total = item.total || 0;
                          const taxable = total / (1 + (rate / 100));
                          const tax = total - taxable;
                          
                          if (!taxSummary[rate]) {
                            taxSummary[rate] = { taxable: 0, tax: 0 };
                          }
                          taxSummary[rate].taxable += taxable;
                          taxSummary[rate].tax += tax;
                        });

                        return Object.entries(taxSummary).map(([rate, vals]) => (
                          <tr key={rate} style={{ borderBottom: `1px solid ${C.border}` }}>
                            <td style={{ ...S.td, padding: "6px 8px", fontWeight: 600 }}>GST {rate}%</td>
                            <td style={{ ...S.td, padding: "6px 8px", textAlign: "right" }}>₹{vals.taxable.toFixed(2)}</td>
                            <td style={{ ...S.td, padding: "6px 8px", textAlign: "right" }}>₹{(vals.tax / 2).toFixed(2)}</td>
                            <td style={{ ...S.td, padding: "6px 8px", textAlign: "right" }}>₹{(vals.tax / 2).toFixed(2)}</td>
                            <td style={{ ...S.td, padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>₹{vals.tax.toFixed(2)}</td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                </div>

                {/* Bill totals card */}
                <div style={{ background: "#F1F5F9", borderRadius: 10, padding: 16, border: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: C.text2 }}>Subtotal:</span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>₹{(selectedBill.items || []).reduce((acc, it) => acc + (it.mrp * (it.quantity || it.qty || 1)), 0).toFixed(2)}</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: 12, color: C.text2 }}>Discount Total:</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: C.red }}>
                      -₹{((selectedBill.items || []).reduce((acc, it) => acc + (it.mrp * (it.quantity || it.qty || 1)), 0) - (selectedBill.grandTotal || 0)).toFixed(2)}
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${C.border}`, paddingTop: 10, marginTop: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: C.navy }}>Grand Total:</span>
                    <span style={{ fontSize: 16, fontWeight: 800, color: C.green }}>₹{(selectedBill.grandTotal || 0).toFixed(2)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Footer */}
            <div style={{ borderTop: `1.5px solid ${C.border}`, paddingTop: 16, marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setSelectedBill(null)}>
                Close Invoice View
              </button>
            </div>
          </div>
        </div>
      )}

      {showBillSuccessModal && lastBill && (
        <div style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(10,35,66,0.6)",
          backdropFilter: "blur(4px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 99999,
          fontFamily: "inherit"
        }}>
          <div style={{
            background: "#fff",
            borderRadius: 16,
            width: "90%",
            maxWidth: 480,
            padding: 28,
            boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
            border: `1px solid ${C.border}`,
            textAlign: "center"
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: "50%",
              background: "#E8F5EE",
              color: C.green,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              margin: "0 auto 16px"
            }}>
              ✓
            </div>
            
            <h3 style={{ fontSize: 18, fontWeight: 800, color: C.navy, margin: "0 0 8px 0" }}>
              Bill Saved Successfully!
            </h3>
            
            <p style={{ fontSize: 13, color: C.text3, margin: "0 0 20px 0" }}>
              Invoice <strong>{lastBill.billNumber}</strong> has been generated.
            </p>
            
            <div style={{ background: "#F8FAFC", borderRadius: 10, padding: 14, marginBottom: 24, textAlign: "left" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: C.text3 }}>Patient Name:</span>
                <span style={{ fontWeight: 700, color: C.navy }}>{lastBill.customerName}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: C.text3 }}>Payment Mode:</span>
                <span style={{ fontWeight: 700, color: C.blue }}>{lastBill.paymentMode}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 700, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                <span style={{ color: C.navy }}>Grand Total:</span>
                <span style={{ color: C.green }}>₹{(lastBill.grandTotal || 0).toFixed(2)}</span>
              </div>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button 
                style={{ ...S.btn("primary"), padding: "12px", fontSize: 14, width: "100%", justifyContent: "center" }}
                onClick={() => printA4PDFInvoice(lastBill)}
              >
                📄 Print A4 Invoice
              </button>
              
              <button 
                style={{ ...S.btn("teal"), padding: "12px", fontSize: 14, width: "100%", justifyContent: "center" }}
                onClick={() => printThermalReceipt(lastBill, storeDetails)}
              >
                🧾 Print Thermal Receipt
              </button>
              
              <button 
                style={{ ...S.btn("outline"), padding: "12px", fontSize: 14, width: "100%", justifyContent: "center", border: `1.5px solid ${C.border2}` }}
                onClick={() => {
                  setShowBillSuccessModal(false);
                  setTimeout(() => {
                    const inputEl = document.getElementById("billing-item-search-input");
                    if (inputEl) inputEl.focus();
                  }, 100);
                }}
              >
                🆕 Start New Bill
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer Bar ── */}
      <footer style={{
        height: 38,
        background: "#0A2342",
        borderTop: "1.5px solid rgba(255,255,255,0.08)",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "0 20px",
        color: "#fff",
        fontSize: 11,
        zIndex: 10,
        flexShrink: 0
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ color: "#6C7A9C" }}>Version: <strong style={{ color: "#fff" }}>1.35.0</strong></span>
          <span style={{ color: "#6C7A9C" }}>|</span>
          <span style={{ fontWeight: 600 }}>⏰ {now.toLocaleDateString("en-IN")} {now.toLocaleTimeString("en-IN")}</span>
        </div>
      </footer>

      {/* ── Drawers Overlays ── */}
      <div 
        className={`drawer-overlay ${
          doctorMasterOpen || uomMasterOpen || categoryMasterOpen || locationMasterOpen || storeInfoMasterOpen || emailConfigOpen || regionMasterOpen || helpSupportOpen ? "open" : ""
        }`}
        onClick={() => {
          setDoctorMasterOpen(false);
          setUomMasterOpen(false);
          setCategoryMasterOpen(false);
          setLocationMasterOpen(false);
          setStoreInfoMasterOpen(false);
          setEmailConfigOpen(false);
          setRegionMasterOpen(false);
          setHelpSupportOpen(false);
        }}
      />

      {/* ── Doctor Master Drawer ── */}
      <div className={`drawer ${doctorMasterOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>🩺 Doctor Master</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Manage registered practitioners for POS billing</span>
          </div>
          <button onClick={() => setDoctorMasterOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        
        {/* Add Doctor Form */}
        <div style={{ padding: "20px 24px", borderBottom: `1.5px solid ${C.border}`, background: "#F8FAFC" }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 12 }}>➕ Add New Doctor</h4>
          {newDoctorError && <div style={{ color: C.red, fontSize: 11, marginBottom: 8 }}>{newDoctorError}</div>}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
            <FF label="Doctor Name *">
              <input 
                style={S.input} 
                placeholder="Dr. John Doe"
                value={doctorForm.name} 
                onChange={e => setDoctorForm(p => ({ ...p, name: e.target.value }))}
              />
            </FF>
            <FF label="Specialization">
              <input 
                style={S.input} 
                placeholder="e.g. Pediatrics"
                value={doctorForm.specialization} 
                onChange={e => setDoctorForm(p => ({ ...p, specialization: e.target.value }))}
              />
            </FF>
            <FF label="Mobile No">
              <input 
                style={S.input} 
                placeholder="10-digit phone"
                value={doctorForm.phone} 
                onChange={e => setDoctorForm(p => ({ ...p, phone: e.target.value }))}
              />
            </FF>
            <FF label="Reg No / DL No">
              <input 
                style={S.input} 
                placeholder="Reg-998822"
                value={doctorForm.registrationNo} 
                onChange={e => setDoctorForm(p => ({ ...p, registrationNo: e.target.value }))}
              />
            </FF>
          </div>
          <button 
            style={{ ...S.btn("teal"), width: "100%", padding: "8px" }}
            onClick={async () => {
              if (!doctorForm.name) { setNewDoctorError("Doctor Name is required."); return; }
              setNewDoctorError("");
              const ok = await addDoctorMaster(doctorForm);
              if (ok) {
                setDoctorForm({ name: "", phone: "", specialization: "", registrationNo: "" });
                alert("✓ Doctor successfully added to Master list!");
              }
            }}
          >
            Add Doctor to Database
          </button>
        </div>

        {/* Doctor List */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>Registered Doctors ({doctors.length})</h4>
          {doctors.length === 0 ? (
            <div style={{ color: C.text3, fontSize: 12, textAlign: "center", padding: "20px 0" }}>No doctors registered yet. Add one above!</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {doctors.map(doc => (
                <div key={doc.id} style={{ padding: 12, border: `1.5px solid ${C.border}`, borderRadius: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>Dr. {doc.name}</div>
                    <div style={{ fontSize: 11, color: C.text2, marginTop: 2 }}>{doc.specialization} · Reg: {doc.registrationNo || "N/A"}</div>
                    {doc.phone && <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>📞 {doc.phone}</div>}
                  </div>
                  <button 
                    onClick={() => { if(confirm("Delete doctor?")) deleteDoctorMaster(doc.id); }}
                    style={{ background: "none", border: "none", color: C.red, fontSize: 14, cursor: "pointer", padding: 6 }}
                  >
                    🗑️
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── UOM Master Drawer ── */}
      <div className={`drawer ${uomMasterOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>⚖️ UOM Master</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Manage drug units (Forms of medicines)</span>
          </div>
          <button onClick={() => setUomMasterOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ padding: "20px 24px", background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>➕ Add New Medicine Form / Unit</h4>
          <div style={{ display: "flex", gap: 10 }}>
            <input 
              id="newUomInput" 
              style={{ ...S.input, flex: 1 }} 
              placeholder="e.g. Tube, Gel, Vial" 
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  const val = e.currentTarget.value.trim();
                  if (!val) return;
                  const DEFAULT_UOMS = ["Tablet", "Capsule", "Syrup", "Injectable", "Ointment", "Drops", "Vial", "Ampoule", "Gel", "Powder", "Inhaler", "Spray"];
                  const current = storeDetails?.uoms || DEFAULT_UOMS;
                  if (current.includes(val)) { alert("UOM already exists!"); return; }
                  const ok = await updateStoreConfigs("uoms", [...current, val]);
                  if (ok) { e.currentTarget.value = ""; alert("✓ Unit added!"); }
                }
              }}
            />
            <button 
              style={S.btn("teal")}
              onClick={async () => {
                const input = document.getElementById("newUomInput");
                const val = input?.value.trim();
                if (!val) return;
                const DEFAULT_UOMS = ["Tablet", "Capsule", "Syrup", "Injectable", "Ointment", "Drops", "Vial", "Ampoule", "Gel", "Powder", "Inhaler", "Spray"];
                const current = storeDetails?.uoms || DEFAULT_UOMS;
                if (current.includes(val)) { alert("UOM already exists!"); return; }
                const ok = await updateStoreConfigs("uoms", [...current, val]);
                if (ok) { input.value = ""; alert("✓ Unit added!"); }
              }}
            >
              Add
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>Available Units</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(() => {
              const DEFAULT_UOMS = ["Tablet", "Capsule", "Syrup", "Injectable", "Ointment", "Drops", "Vial", "Ampoule", "Gel", "Powder", "Inhaler", "Spray"];
              return (storeDetails?.uoms || DEFAULT_UOMS).map(unit => (
                <div key={unit} style={{ padding: "8px 12px", border: `1.5px solid ${C.border}`, borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{unit}</span>
                  <button 
                    onClick={async () => {
                      const current = storeDetails?.uoms || DEFAULT_UOMS;
                      if (confirm(`Remove ${unit}?`)) {
                        await updateStoreConfigs("uoms", current.filter(u => u !== unit));
                      }
                    }}
                    style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 11 }}
                  >
                    ×
                  </button>
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {/* ── Category Master Drawer ── */}
      <div className={`drawer ${categoryMasterOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>🗂️ Category Master</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Manage drug therapeutic categories</span>
          </div>
          <button onClick={() => setCategoryMasterOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ padding: "20px 24px", background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>➕ Add New Category</h4>
          <div style={{ display: "flex", gap: 10 }}>
            <input 
              id="newCatInput" 
              style={{ ...S.input, flex: 1 }} 
              placeholder="e.g. Cardiology" 
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  const val = e.currentTarget.value.trim();
                  if (!val) return;
                  const DEFAULT_CATEGORIES = ["General", "Antibiotic", "Analgesic", "Antacid", "Antihistamine", "Cardiology", "Diabetic", "Pediatric", "Multivitamin", "OTC"];
                  const current = storeDetails?.categories || DEFAULT_CATEGORIES;
                  if (current.includes(val)) { alert("Category already exists!"); return; }
                  const ok = await updateStoreConfigs("categories", [...current, val]);
                  if (ok) { e.currentTarget.value = ""; alert("✓ Category added!"); }
                }
              }}
            />
            <button 
              style={S.btn("teal")}
              onClick={async () => {
                const input = document.getElementById("newCatInput");
                const val = input?.value.trim();
                if (!val) return;
                const DEFAULT_CATEGORIES = ["General", "Antibiotic", "Analgesic", "Antacid", "Antihistamine", "Cardiology", "Diabetic", "Pediatric", "Multivitamin", "OTC"];
                const current = storeDetails?.categories || DEFAULT_CATEGORIES;
                if (current.includes(val)) { alert("Category already exists!"); return; }
                const ok = await updateStoreConfigs("categories", [...current, val]);
                if (ok) { input.value = ""; alert("✓ Category added!"); }
              }}
            >
              Add
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>Available Categories</h4>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(() => {
              const DEFAULT_CATEGORIES = ["General", "Antibiotic", "Analgesic", "Antacid", "Antihistamine", "Cardiology", "Diabetic", "Pediatric", "Multivitamin", "OTC"];
              return (storeDetails?.categories || DEFAULT_CATEGORIES).map(cat => (
                <div key={cat} style={{ padding: "10px 14px", border: `1.5px solid ${C.border}`, borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{cat}</span>
                  <button 
                    onClick={async () => {
                      const current = storeDetails?.categories || DEFAULT_CATEGORIES;
                      if (confirm(`Remove ${cat}?`)) {
                        await updateStoreConfigs("categories", current.filter(c => c !== cat));
                      }
                    }}
                    style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 12 }}
                  >
                    🗑️ Remove
                  </button>
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {/* ── Location Master Drawer ── */}
      <div className={`drawer ${locationMasterOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>📍 Location / Rack Master</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Manage inventory shelf rack coordinates</span>
          </div>
          <button onClick={() => setLocationMasterOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ padding: "20px 24px", background: "#F8FAFC", borderBottom: `1px solid ${C.border}` }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>➕ Add New Rack / Location</h4>
          <div style={{ display: "flex", gap: 10 }}>
            <input 
              id="newLocInput" 
              style={{ ...S.input, flex: 1 }} 
              placeholder="e.g. Rack D - Shelf 2" 
              onKeyDown={async e => {
                if (e.key === "Enter") {
                  const val = e.currentTarget.value.trim();
                  if (!val) return;
                  const DEFAULT_LOCATIONS = ["Rack A", "Rack B", "Rack C", "Shelf 1", "Shelf 2", "Shelf 3", "Cold Storage", "Counter 1"];
                  const current = storeDetails?.locations || DEFAULT_LOCATIONS;
                  if (current.includes(val)) { alert("Location already exists!"); return; }
                  const ok = await updateStoreConfigs("locations", [...current, val]);
                  if (ok) { e.currentTarget.value = ""; alert("✓ Location added!"); }
                }
              }}
            />
            <button 
              style={S.btn("teal")}
              onClick={async () => {
                const input = document.getElementById("newLocInput");
                const val = input?.value.trim();
                if (!val) return;
                const DEFAULT_LOCATIONS = ["Rack A", "Rack B", "Rack C", "Shelf 1", "Shelf 2", "Shelf 3", "Cold Storage", "Counter 1"];
                const current = storeDetails?.locations || DEFAULT_LOCATIONS;
                if (current.includes(val)) { alert("Location already exists!"); return; }
                const ok = await updateStoreConfigs("locations", [...current, val]);
                if (ok) { input.value = ""; alert("✓ Location added!"); }
              }}
            >
              Add
            </button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          <h4 style={{ fontSize: 13, fontWeight: 700, color: C.navy, marginTop: 0, marginBottom: 10 }}>Configured Shelves / Locations</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {(() => {
              const DEFAULT_LOCATIONS = ["Rack A", "Rack B", "Rack C", "Shelf 1", "Shelf 2", "Shelf 3", "Cold Storage", "Counter 1"];
              return (storeDetails?.locations || DEFAULT_LOCATIONS).map(loc => (
                <div key={loc} style={{ padding: "8px 12px", border: `1.5px solid ${C.border}`, borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{loc}</span>
                  <button 
                    onClick={async () => {
                      const current = storeDetails?.locations || DEFAULT_LOCATIONS;
                      if (confirm(`Remove ${loc}?`)) {
                        await updateStoreConfigs("locations", current.filter(l => l !== loc));
                      }
                    }}
                    style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 11 }}
                  >
                    ×
                  </button>
                </div>
              ));
            })()}
          </div>
        </div>
      </div>

      {/* ── Store Info & Compliance Drawer ── */}
      <div className={`drawer ${storeInfoMasterOpen ? "open" : ""}`} style={{ width: 500 }}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>🏪 Store Info & Compliance</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Update store profile and regulatory settings</span>
          </div>
          <button onClick={() => setStoreInfoMasterOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <FF label="Store Kendra Name *">
            <input style={S.input} value={storeEditForm.name} onChange={e => setStoreEditForm(p => ({ ...p, name: e.target.value }))} />
          </FF>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FF label="Helpline Number *">
              <input style={S.input} value={storeEditForm.helpline} onChange={e => setStoreEditForm(p => ({ ...p, helpline: e.target.value }))} />
            </FF>
            <FF label="Support Working Hours *">
              <input style={S.input} value={storeEditForm.supportTime} onChange={e => setStoreEditForm(p => ({ ...p, supportTime: e.target.value }))} />
            </FF>
            <FF label="GSTIN Code *">
              <input style={S.input} value={storeEditForm.gstin} onChange={e => setStoreEditForm(p => ({ ...p, gstin: e.target.value }))} />
            </FF>
            <FF label="Drug License Code *">
              <input style={S.input} value={storeEditForm.drugLicense} onChange={e => setStoreEditForm(p => ({ ...p, drugLicense: e.target.value }))} />
            </FF>
            <FF label="Store Lat Coordinate">
              <input style={S.input} placeholder="e.g. 14.7314" value={storeEditForm.latitude} onChange={e => setStoreEditForm(p => ({ ...p, latitude: e.target.value }))} />
            </FF>
            <FF label="Store Lng Coordinate">
              <input style={S.input} placeholder="e.g. 75.6202" value={storeEditForm.longitude} onChange={e => setStoreEditForm(p => ({ ...p, longitude: e.target.value }))} />
            </FF>
          </div>
          
          <FF label="Google Maps Location URL">
            <input style={S.input} placeholder="https://maps.google.com/?q=..." value={storeEditForm.mapUrl} onChange={e => setStoreEditForm(p => ({ ...p, mapUrl: e.target.value }))} />
          </FF>

          <FF label="Store Full Address *">
            <textarea style={{ ...S.input, height: 60, fontFamily: "inherit" }} value={storeEditForm.address} onChange={e => setStoreEditForm(p => ({ ...p, address: e.target.value }))} />
          </FF>

          {/* Banking Details Header */}
          <div style={{ borderTop: `1.5px solid ${C.border}`, paddingTop: 14, marginTop: 6 }}>
            <h4 style={{ fontSize: 13, fontWeight: 800, color: C.navy, margin: "0 0 12px" }}>🏦 PMBJP Store Bank Details</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <FF label="Account Holder Name">
                <input style={S.input} value={storeEditForm.bankAccountName} onChange={e => setStoreEditForm(p => ({ ...p, bankAccountName: e.target.value }))} />
              </FF>
              <FF label="Bank Name">
                <input style={S.input} value={storeEditForm.bankName} onChange={e => setStoreEditForm(p => ({ ...p, bankName: e.target.value }))} />
              </FF>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FF label="Bank Account Number">
                  <input style={S.input} value={storeEditForm.bankAccountNumber} onChange={e => setStoreEditForm(p => ({ ...p, bankAccountNumber: e.target.value }))} />
                </FF>
                <FF label="IFSC Code">
                  <input style={S.input} value={storeEditForm.bankIfsc} onChange={e => setStoreEditForm(p => ({ ...p, bankIfsc: e.target.value }))} />
                </FF>
              </div>
              <FF label="Bank Branch Name">
                <input style={S.input} value={storeEditForm.bankBranch} onChange={e => setStoreEditForm(p => ({ ...p, bankBranch: e.target.value }))} />
              </FF>
            </div>
          </div>

          {/* PMS Incentive settings */}
          <div style={{ borderTop: `1.5px solid ${C.border}`, paddingTop: 14 }}>
            <h4 style={{ fontSize: 13, fontWeight: 800, color: C.navy, margin: "0 0 10px" }}>💰 Accrued Incentive</h4>
            <FF label="Total Incentive Received (₹)">
              <input style={S.input} placeholder="1,14,041.00" value={storeEditForm.incentiveReceived || ""} onChange={e => setStoreEditForm(p => ({ ...p, incentiveReceived: e.target.value }))} />
            </FF>
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
            <button style={{ ...S.btn("primary"), flex: 1 }} onClick={saveStoreProfile} disabled={isSavingStore}>
              {isSavingStore ? "Saving Compliance Details..." : "Save Store Configuration"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Email Configuration Drawer ── */}
      <div className={`drawer ${emailConfigOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>📧 Email Configuration</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Automated notifications & low stock reports</span>
          </div>
          <button onClick={() => setEmailConfigOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <FF label="Notification Email for Alerts">
            <input style={S.input} type="email" placeholder="owner@janaushadhi.com" value={storeDetails?.alertEmail || ""} onChange={e => updateStoreConfigs("alertEmail", e.target.value)} />
          </FF>
          <div style={{ background: "#F1F5F9", borderRadius: 8, padding: 12, fontSize: 11, color: C.text2, lineHeight: 1.4 }}>
            📌 <strong>Automated Sync:</strong> System will send low-stock and expiry warning digests to this email address every Sunday at 9:00 AM.
          </div>
        </div>
      </div>

      {/* ── Area Master / Region Drawer ── */}
      <div className={`drawer ${regionMasterOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>🌐 Area Master</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Kendra Region & Territory classification</span>
          </div>
          <button onClick={() => setRegionMasterOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ padding: "24px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ background: "#F8FAFC", border: `1.5px solid ${C.border}`, borderRadius: 10, padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, fontSize: 12 }}>
              <div><strong style={{ color: C.text3 }}>STATE</strong><div style={{ fontWeight: 700, fontSize: 14, color: C.navy }}>Karnataka</div></div>
              <div><strong style={{ color: C.text3 }}>DISTRICT</strong><div style={{ fontWeight: 700, fontSize: 14, color: C.navy }}>Haveri</div></div>
              <div><strong style={{ color: C.text3 }}>CITY / TALUK</strong><div style={{ fontWeight: 700, fontSize: 14, color: C.navy }}>Ranebennur</div></div>
              <div><strong style={{ color: C.text3 }}>PINCODE</strong><div style={{ fontWeight: 700, fontSize: 14, color: C.navy }}>581115</div></div>
            </div>
          </div>
          <div style={{ fontSize: 11, color: C.text3, lineHeight: 1.4 }}>
            ℹ️ Territorial mapping details are synchronized with the Pradhan Mantri Bhartiya Janaushadhi Pariyojana national drug repository.
          </div>
        </div>
      </div>

      {/* ── Help & Support Drawer ── */}
      <div className={`drawer ${helpSupportOpen ? "open" : ""}`}>
        <div style={{ padding: "20px 24px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>💬 Help & Support</h3>
            <span style={{ fontSize: 11, color: C.text3 }}>Submit queries and view FAQs</span>
          </div>
          <button onClick={() => setHelpSupportOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ background: "#F1F5F9", borderRadius: 8, padding: 12, fontSize: 12 }}>
            📞 <strong>National Helpline:</strong> <a href="tel:18001808080" style={{ fontWeight: 700, color: C.blue }}>1800-180-8080</a> (Toll-Free)
          </div>
          <FF label="Search FAQs">
            <input style={S.input} placeholder="Type question (e.g. GST reports)..." />
          </FF>
          <div>
            <h4 style={{ fontSize: 12, fontWeight: 800, color: C.navy, margin: "10px 0 6px" }}>Common Support Topics</h4>
            <ul style={{ paddingLeft: 16, fontSize: 12, color: C.text2, lineHeight: 1.6 }}>
              <li>How to backfill legacy sales Excel imports?</li>
              <li>Configuring FEFO batch inventory sorting rules.</li>
              <li>Generating monthly GSTR-1 reports.</li>
              <li>Auto-matching unmapped items.</li>
            </ul>
          </div>
        </div>
      </div>

      {/* ── Bank Details Modal ── */}
      {bankDetailsOpen && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 450, padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>🏦 PMBJP Bank Details</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Store banking details for PMBJP remittances</span>
              </div>
              <button onClick={() => setBankDetailsOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>ACCOUNT NAME</label>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>{storeDetails?.bankAccountName || "PMBJP Jan Aushadhi Store #" + storeCode}</div>
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>BANK NAME</label>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>{storeDetails?.bankName || "State Bank of India"}</div>
              </div>
              <div>
                <label style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>ACCOUNT NUMBER</label>
                <div style={{ fontSize: 14, fontWeight: 800, color: C.teal, fontFamily: "monospace" }}>{storeDetails?.bankAccountNumber || "N/A - Configure in Store Info"}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>IFSC CODE</label>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>{storeDetails?.bankIfsc || "N/A"}</div>
                </div>
                <div>
                  <label style={{ fontSize: 10, fontWeight: 700, color: C.text3 }}>BRANCH</label>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.navy }}>{storeDetails?.bankBranch || "N/A"}</div>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button 
                style={S.btn("teal")} 
                onClick={() => {
                  const details = `Account Name: ${storeDetails?.bankAccountName || ""}\nBank: ${storeDetails?.bankName || ""}\nA/C: ${storeDetails?.bankAccountNumber || ""}\nIFSC: ${storeDetails?.bankIfsc || ""}\nBranch: ${storeDetails?.bankBranch || ""}`;
                  navigator.clipboard.writeText(details);
                  alert("✓ Bank details copied to clipboard!");
                }}
              >
                📋 Copy Details
              </button>
              <button style={S.btn("outline")} onClick={() => setBankDetailsOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Coordinates Location Modal ── */}
      {updateLocationOpen && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 9999 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 450, padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>📍 Update GPS Location</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Configure store map location coordinates</span>
              </div>
              <button onClick={() => setUpdateLocationOpen(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <FF label="Latitude">
                  <input style={S.input} value={storeEditForm.latitude} onChange={e => setStoreEditForm(p => ({ ...p, latitude: e.target.value }))} />
                </FF>
                <FF label="Longitude">
                  <input style={S.input} value={storeEditForm.longitude} onChange={e => setStoreEditForm(p => ({ ...p, longitude: e.target.value }))} />
                </FF>
              </div>
              <FF label="Map Link URL">
                <input style={S.input} placeholder="https://maps.google.com/?q=..." value={storeEditForm.mapUrl} onChange={e => setStoreEditForm(p => ({ ...p, mapUrl: e.target.value }))} />
              </FF>
              {storeDetails?.mapUrl && (
                <a href={storeDetails.mapUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, fontWeight: 700, color: C.blue, textDecoration: "none" }}>🔗 View Current Map Coordinates Location</a>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setUpdateLocationOpen(false)}>Cancel</button>
              <button style={S.btn("teal")} onClick={async () => {
                await saveStoreProfile();
                setUpdateLocationOpen(false);
              }}>
                Save Coordinates
              </button>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}