"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { auth, db } from "@/lib/firebase";
import { signInWithEmailAndPassword, signOut, onAuthStateChanged } from "firebase/auth";
import { collection, addDoc, doc, updateDoc, deleteDoc, query, orderBy, serverTimestamp, onSnapshot } from "firebase/firestore";
import * as XLSX from "xlsx";

const STOP_WORDS = [
  "mg", "ml", "tab", "tabs", "tablet", "cap", "capsule",
  "strip", "bottle", "inj", "syrup", "suspension", "gel", "lotion", "cream", "ointment", "drops", "vial", "ampoule"
];

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
    const name = (i.genericName || "").substring(0, 18).padEnd(18);
    const qty = String(i.quantity || i.qty || 1).padStart(3);
    const total = `Rs.${(i.total || 0).toFixed(2)}`.padStart(10);
    return `${name}${qty}${total}`;
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
  const w = window.open("", "_blank", "width=320,height=600");
  if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); w.close(); }, 400); }
}

function sendWhatsApp(bill, phone) {
  if (!phone) return;
  const text = `*JANAUSHADHI KENDRA, Ranebennur*\nPh: 9964382376\n\n*Bill: ${bill.billNumber}*\nDate: ${new Date(bill.date || new Date()).toLocaleDateString("en-IN")}\n\n${(bill.items || []).map(i => `• ${i.genericName} x${i.quantity || i.qty} = ₹${(i.total || 0).toFixed(2)}`).join("\n")}\n\n*Total: ₹${(bill.grandTotal || 0).toFixed(2)}*\nPayment: ${bill.paymentMode}\n\n_Thank you! Get well soon._ 🙏`;
  const num = phone.replace(/\D/g, "");
  window.open(`https://wa.me/${num.startsWith("91") ? num : "91" + num}?text=${encodeURIComponent(text)}`, "_blank");
}

const C = {
  navy: "#0A2342", teal: "#0D7377", teal2: "#14A085",
  blue: "#1565C0", green: "#1B7A4E", amber: "#92600A", red: "#C0392B",
  bg: "#F4F6F9", surface: "#fff", border: "#E2E8F0", border2: "#CBD5E0",
  text: "#0A2342", text2: "#4A5568", text3: "#8A96A3",
};
const S = {
  topbar: { background: C.navy, height: 58, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px", flexShrink: 0 },
  logoMark: { width: 38, height: 38, borderRadius: 9, background: C.teal2, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0 },
  main: { flex: 1, padding: "24px", overflowX: "hidden", background: C.bg },
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 16 },
  input: { fontFamily: "inherit", fontSize: 13, border: `1.5px solid ${C.border2}`, borderRadius: 8, padding: "9px 12px", background: "#fff", color: C.text, outline: "none", width: "100%" },
  label: { display: "block", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 5 },
  btn: (t) => ({
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, borderRadius: 8, padding: "10px 18px",
    cursor: "pointer", border: "none", letterSpacing: "0.2px", transition: "all 0.12s",
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
  th: { padding: "10px 12px", textAlign: "left", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase", letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap" },
  td: { padding: "10px 12px", borderBottom: `1px solid ${C.border}`, fontSize: 13 },
};

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const login = async () => {
    if (!email || !password) { setError("Please enter email and password."); return; }
    setLoading(true); setError("");
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch { setError("Invalid email or password."); }
    finally { setLoading(false); }
  };
  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "'Inter',system-ui,sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 400, padding: "0 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 22, fontWeight: 700, color: "#fff" }}>JK</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.navy }}>Janaushadhi Kendra</div>
          <div style={{ fontSize: 13, color: C.text3, marginTop: 4 }}>Ranebennur · Pharmacy ERP</div>
        </div>
        <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 28 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.navy, marginBottom: 20, textAlign: "center" }}>Sign In to Your Store</div>
          {error && <div style={{ background: "#FDECEA", border: "1px solid #FCCACA", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: C.red }}>{error}</div>}
          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>Email Address</label>
            <input style={S.input} type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && login()} placeholder="your@email.com" />
          </div>
          <div style={{ marginBottom: 20 }}>
            <label style={S.label}>Password</label>
            <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && login()} placeholder="••••••••" />
          </div>
          <button style={{ ...S.btn("primary"), width: "100%", padding: "13px", fontSize: 15 }} onClick={login} disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
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
  const [dbLoading, setDbLoading] = useState(true);
  const [now, setNow] = useState(new Date());
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
  }, []);

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
    localStorage.setItem("jk_pms_draft_purchase_form", JSON.stringify(purchaseForm));
  }, [purchaseForm, isClient]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { setUser(u); setAuthLoading(false); });
    return unsub;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) return;
    const u1 = onSnapshot(query(collection(db, "medicines"), orderBy("genericName")), snap => {
      setMedicines(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setDbLoading(false);
    }, () => setDbLoading(false));
    const u2 = onSnapshot(query(collection(db, "sales"), orderBy("createdAt", "desc")), snap => setSales(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const u3 = onSnapshot(query(collection(db, "purchases"), orderBy("createdAt", "desc")), snap => setPurchases(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const u4 = onSnapshot(collection(db, "suppliers"), snap => setSuppliers(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => { u1(); u2(); u3(); u4(); };
  }, [user]);

  const lowStock = medicines.filter(m => m.stockQty <= m.lowStockAlert);
  const expiringSoon = medicines.filter(m => {
    if (!m.expiryDate) return false;
    const [y, mo] = m.expiryDate.split("-");
    const limit = new Date(); limit.setMonth(limit.getMonth() + 3);
    return new Date(+y, +mo - 1, 1) <= limit;
  });
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
  // FEFO: sort by nearest expiry first, then filter
  const getExpiryDate = (m) => { if (!m.expiryDate) return new Date(9999, 0); const [y, mo] = (m.expiryDate || "2099-12").split("-"); return new Date(+y, +mo - 1, 1); };
  const isExpiringSoon = (m) => { const exp = getExpiryDate(m); const limit = new Date(); limit.setMonth(limit.getMonth() + 3); return exp <= limit; };
  const isExpired = (m) => getExpiryDate(m) < new Date();
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
    const start = new Date();
    if (reportPeriod === "today") start.setHours(0, 0, 0, 0);
    else if (reportPeriod === "week") start.setDate(start.getDate() - 7);
    else { start.setDate(1); start.setHours(0, 0, 0, 0); }
    return sales.filter(s => { const d = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0); return d >= start; });
  };
  const getReportPurchases = () => {
    const start = new Date();
    if (reportPeriod === "today") start.setHours(0, 0, 0, 0);
    else if (reportPeriod === "week") start.setDate(start.getDate() - 7);
    else { start.setDate(1); start.setHours(0, 0, 0, 0); }
    return purchases.filter(p => { const d = p.createdAt?.toDate ? p.createdAt.toDate() : new Date(p.createdAt || 0); return d >= start; });
  };

  // ── EXCEL PARSING & INVOICE FLOWS ─────────
  const parseExpiry = (exp) => {
    if (!exp) return "2027-12";
    const str = String(exp).trim();
    if (str.includes("/")) {
      const parts = str.split("/");
      if (parts.length === 2) {
        const m = parts[0].padStart(2, "0");
        const y = parts[1].length === 2 ? `20${parts[1]}` : parts[1];
        return `${y}-${m}`;
      }
    }
    if (str.includes("-")) {
      const parts = str.split("-");
      if (parts[0].length === 4) return `${parts[0]}-${parts[1].padStart(2, "0")}`;
      if (parts[1].length === 4) return `${parts[1]}-${parts[0].padStart(2, "0")}`;
    }
    return str;
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
    setBillItems(prev => {
      const ex = prev.find(i => i.id === med.id);
      if (ex) return prev.map(i => i.id === med.id ? { ...i, qty: i.qty + 1 } : i);
      const activePrice = +med.sellingPrice || +med.mrp || 0;
      return [...prev, { ...med, mrp: activePrice, originalMrp: med.mrp, qty: 1, discount: 0 }];
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
    if (!searchResults.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSearchHighlight(h => Math.min(h + 1, searchResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSearchHighlight(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && searchHighlight >= 0) { e.preventDefault(); addToBill(searchResults[searchHighlight]); }
    else if (e.key === "Escape") { setBillSearch(""); setSearchHighlight(-1); }
  };

  const generateBill = async () => {
    if (!billItems.length) return;
    
    // Validate quantities
    for (const item of billItems) {
      if (item.qty === "" || !item.qty || +item.qty <= 0) {
        alert(`⚠ Please add the quantity for "${item.genericName || item.brandName}"!`);
        return;
      }
    }
    
    const billNumber = `JK-${now.getFullYear()}-${String(sales.length + 1).padStart(4, "0")}`;
    
    const finalizedItems = [];
    
    try {
      for (const item of billItems) {
        const med = medicines.find(m => m.id === item.id);
        const batchesUsed = [];
        
        if (med) {
          let currentBatches = Array.isArray(med.batches) ? [...med.batches] : [];
          let remainingQ = item.qty;
          let sortedBatches = [...currentBatches].sort((a, b) => getExpiryDate(a) - getExpiryDate(b));
          
          for (let b of sortedBatches) {
            if (remainingQ <= 0) break;
            const bq = b.quantity || 0;
            if (bq > 0) {
              const take = Math.min(bq, remainingQ);
              b.quantity = bq - take;
              batchesUsed.push({ batchNumber: b.batchNumber, quantity: take });
              remainingQ -= take;
            }
          }
          
          if (remainingQ > 0) {
            if (sortedBatches.length > 0) {
              sortedBatches[0].quantity = Math.max(0, (sortedBatches[0].quantity || 0) - remainingQ);
              batchesUsed.push({ batchNumber: sortedBatches[0].batchNumber, quantity: remainingQ });
            } else {
              const fallbackBatch = {
                batchNumber: med.batchNumber || "BAT-LEGACY",
                expiryDate: med.expiryDate || "2027-12",
                quantity: 0
              };
              sortedBatches.push(fallbackBatch);
              batchesUsed.push({ batchNumber: fallbackBatch.batchNumber, quantity: remainingQ });
            }
          }
          
          const totalStock = sortedBatches.reduce((sum, b) => sum + (b.quantity || 0), 0);
          
          await updateDoc(doc(db, "medicines", med.id), {
            stockQty: Math.max(0, totalStock),
            batches: sortedBatches,
            updatedAt: serverTimestamp()
          });
        } else {
          batchesUsed.push({ batchNumber: item.batchNumber || "BAT-LEGACY", quantity: item.qty });
        }
        
        const c = calcItem(item);
        finalizedItems.push({
          medicineId: item.id,
          genericName: item.genericName,
          brandName: item.brandName || "",
          quantity: item.qty,
          mrp: item.mrp,
          discount: item.discount || 0,
          total: c.total,
          gstRate: c.gstRate,
          taxableValue: c.taxableValue,
          cgst: c.cgst,
          sgst: c.sgst,
          totalGst: c.gstAmount,
          batchesUsed
        });
      }
      
      const billData = {
        billNumber,
        customerName,
        customerPhone,
        items: finalizedItems,
        subtotal: totals.sub,
        totalDiscount: totals.disc,
        grandTotal: totals.grand,
        taxableAmount: totals.taxable,
        cgstAmount: totals.cgst,
        sgstAmount: totals.sgst,
        totalGst: totals.gst,
        paymentMode,
        createdAt: serverTimestamp(),
        createdBy: user.uid
      };
      
      await addDoc(collection(db, "sales"), billData);
      setLastBill({ ...billData, date: new Date() });
      setBillItems([]); setCustomerName(""); setCustomerPhone("");
    } catch (err) {
      alert("Error generating bill: " + err.message);
    }
  };

  const saveMedicine = async () => {
    if (!newMed.genericName || !newMed.mrp || !newMed.stockQty) return;
    try {
      const mrpVal = +newMed.mrp;
      const sellVal = +newMed.sellingPrice || mrpVal;
      const buyVal = +newMed.purchasePrice || 0;
      const qtyVal = +newMed.stockQty;
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

      await addDoc(collection(db, "medicines"), {
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

      setShowAddMedForm(false);
      setNewMed({ genericName: "", brandName: "", strength: "", form: "Tablet", barcode: "", expiryDate: "", mrp: "", sellingPrice: "", purchasePrice: "", stockQty: "", unit: "Strip", lowStockAlert: "20", category: "", gstRate: "12" });
    } catch (err) { alert("Error: " + err.message); }
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
          name: purchaseForm.supplierName,
          totalPurchases: totalAmount,
          outstanding: purchaseForm.paymentStatus === "Unpaid" ? totalAmount : 0,
          createdAt: serverTimestamp(),
          createdBy: user.uid
        });
        distId = dRef.id;
      }

      await addDoc(collection(db, "purchases"), {
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

  const exportReportPDF = () => {
    const rS = getReportSales(); const rP = getReportPurchases();
    const tS = rS.reduce((a, s) => a + (s.grandTotal || 0), 0);
    const tP = rP.reduce((a, p) => a + (p.totalAmount || 0), 0);
    const totalGst = rS.reduce((a, s) => a + (s.totalGst || 0), 0);
    const taxableAmount = rS.reduce((a, s) => a + (s.taxableAmount || 0), 0);
    const cgst = rS.reduce((a, s) => a + (s.cgstAmount || 0), 0);
    const sgst = rS.reduce((a, s) => a + (s.sgstAmount || 0), 0);
    const label = reportPeriod === "today" ? "Today" : reportPeriod === "week" ? "Last 7 Days" : "This Month";
    const html = `<html><head><style>body{font-family:Arial,sans-serif;padding:20px;color:#0A2342}h1{font-size:20px;border-bottom:2px solid #0D7377;padding-bottom:8px}h2{font-size:15px;color:#0D7377;margin-top:20px}table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#0A2342;color:#fff;padding:8px;text-align:left;font-size:12px}td{padding:7px 8px;border-bottom:1px solid #E2E8F0;font-size:12px}.stat{display:inline-block;margin:8px 16px 8px 0;padding:10px 16px;background:#F4F6F9;border-radius:8px;border-left:3px solid #0D7377}.sl{font-size:10px;color:#8A96A3;font-weight:700;text-transform:uppercase}.sv{font-size:18px;font-weight:700}</style></head><body>
    <h1>Retail Billing & GST Management System — ${label} Report</h1>
    <p style="font-size:12px;color:#8A96A3">Generated: ${new Date().toLocaleString("en-IN")} · Pharmacy GST Ledger</p>
    <div style="margin:16px 0">
      <div class="stat"><div class="sl">Total Sales</div><div class="sv">₹${tS.toFixed(2)}</div></div>
      <div class="stat"><div class="sl">Taxable Value</div><div class="sv">₹${taxableAmount.toFixed(2)}</div></div>
      <div class="stat"><div class="sl">Total GST</div><div class="sv">₹${totalGst.toFixed(2)}</div></div>
      <div class="stat"><div class="sl">CGST (50%)</div><div class="sv">₹${cgst.toFixed(2)}</div></div>
      <div class="stat"><div class="sl">SGST (50%)</div><div class="sv">₹${sgst.toFixed(2)}</div></div>
    </div>
    <h2>Sales Transaction Ledger (${rS.length})</h2>
    <table>
      <thead>
        <tr><th>Bill No.</th><th>Patient</th><th>Taxable Amt</th><th>CGST</th><th>SGST</th><th>Total GST</th><th>Grand Total</th></tr>
      </thead>
      <tbody>
        ${rS.map(s=>`<tr><td>${s.billNumber||""}</td><td>${s.customerName||"—"}</td><td>₹${(s.taxableAmount||0).toFixed(2)}</td><td>₹${(s.cgstAmount||0).toFixed(2)}</td><td>₹${(s.sgstAmount||0).toFixed(2)}</td><td>₹${(s.totalGst||0).toFixed(2)}</td><td>₹${(s.grandTotal||0).toFixed(2)}</td></tr>`).join("")}
      </tbody>
    </table>
    <h2>Purchases (${rP.length})</h2>
    <table>
      <thead>
        <tr><th>Invoice</th><th>Supplier</th><th>Date</th><th>Status</th><th>Amount</th></tr>
      </thead>
      <tbody>
        ${rP.map(p=>`<tr><td>${p.invoiceNumber||""}</td><td>${p.supplierName||""}</td><td>${p.invoiceDate||""}</td><td>${p.paymentStatus||""}</td><td>₹${(p.totalAmount||0).toFixed(2)}</td></tr>`).join("")}
      </tbody>
    </table>
    </body></html>`;
    const w = window.open("", "_blank"); if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 400); }
  };

  if (authLoading) return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.bg }}><div style={{ textAlign: "center" }}><div style={{ width: 48, height: 48, borderRadius: 12, background: C.navy, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px", fontSize: 18, fontWeight: 700, color: "#fff" }}>JK</div><div style={{ fontSize: 14, color: C.text3 }}>Loading...</div></div></div>;
  if (!user) return <LoginScreen />;

  const TABS = [
    { id: "dashboard", label: "Dashboard", icon: "▣" },
    { id: "billing",   label: "Billing",   icon: "⊕" },
    { id: "purchase",  label: "Purchase",  icon: "⊞" },
    { id: "inventory", label: "Inventory", icon: "▤" },
    { id: "bills",     label: "Bills",     icon: "⊟" },
    { id: "reports",   label: "Reports",   icon: "▦" },
    { id: "alerts",    label: `Alerts(${lowStock.length})`, icon: "⚑" },
  ];



  const rSales = getReportSales(); const rPurch = getReportPurchases();
  const rTS = rSales.reduce((a, s) => a + (s.grandTotal || 0), 0);
  const rTP = rPurch.reduce((a, p) => a + (p.totalAmount || 0), 0);
  const todaySalesAll = sales.filter(s => { const d = s.createdAt?.toDate ? s.createdAt.toDate() : new Date(s.createdAt || 0); return d.toDateString() === now.toDateString(); });

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", display: "flex", flexDirection: "column" }}>
      <header style={S.topbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={S.logoMark}>JK</div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Janaushadhi Kendra</div>
            <div style={{ fontSize: 11, color: "#90A4B8", marginTop: 1 }}>Ranebennur · {user.email}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontSize: 11, color: "#90A4B8" }}>{now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, background: C.teal, borderRadius: 20, padding: "5px 12px" }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ECCA3", display: "block" }} />
            <span style={{ fontSize: 11, color: "#E0F7F4", fontWeight: 600 }}>LIVE</span>
          </div>
          <button onClick={() => signOut(auth)} style={{ ...S.btn("outline"), padding: "6px 12px", fontSize: 12 }}>Sign Out</button>
        </div>
      </header>

      <nav style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, display: "flex", padding: "0 24px", gap: 2, flexShrink: 0, overflowX: "auto" }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{ padding: "14px 16px", fontSize: 12, fontWeight: activeTab === tab.id ? 700 : 500, color: activeTab === tab.id ? C.teal : C.text2, background: "none", border: "none", borderBottom: `2.5px solid ${activeTab === tab.id ? C.teal : "transparent"}`, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {tab.label}
          </button>
        ))}
      </nav>

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
            <PH title="Billing / POS" sub="F2 = Search · ↑↓ Navigate · Enter = Add · F9 = Generate Bill" />
            {/* KEYBOARD SHORTCUT BAR */}
            <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
              {[["F2", "Focus Search"], ["↑↓", "Navigate"], ["Enter", "Add Item"], ["F9", "Generate Bill"], ["Esc", "Clear Search"]].map(([key, desc]) => (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "4px 10px" }}>
                  <span style={{ background: C.navy, color: "#fff", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 700, fontFamily: "monospace" }}>{key}</span>
                  <span style={{ fontSize: 11, color: C.text3 }}>{desc}</span>
                </div>
              ))}
            </div>
            {lastBill && (
              <div style={{ background: "#E8F5EE", border: "1.5px solid #68D391", borderRadius: 10, padding: "14px 18px", marginBottom: 18 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.green, marginBottom: 6 }}>✓ Bill Saved!</div>
                <div style={{ fontSize: 12, color: "#2D6A4F", marginBottom: 12 }}>{lastBill.billNumber} · ₹{lastBill.grandTotal.toFixed(2)} · {lastBill.paymentMode}</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button style={S.btn("teal")} onClick={() => printThermalReceipt(lastBill)}>Print Receipt</button>
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
                          <div style={{ fontSize: 11, color: C.text3 }}>{item.brandName}
                            {expired && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: C.red }}>⚠ EXPIRED</span>}
                            {!expired && expiring && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: C.amber }}>⏰ Exp {item.expiryDate}</span>}
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
                              <button onClick={() => deleteMedicine(m.id)} style={{ background: "none", border: "none", color: C.red, cursor: "pointer", fontSize: 14 }} title="Delete Medicine">🗑️</button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
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
                  <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
                    <button style={S.btn("teal")} onClick={()=>printThermalReceipt({...selectedBill,date:selectedBill.createdAt?.toDate?.()||new Date()})}>Reprint</button>
                    {selectedBill.customerPhone&&<button style={S.btn("whatsapp")} onClick={()=>sendWhatsApp({...selectedBill,date:selectedBill.createdAt?.toDate?.()||new Date()},selectedBill.customerPhone)}>WhatsApp</button>}
                    <button style={S.btn("outline")} onClick={()=>setSelectedBill(null)}>Close</button>
                  </div>
                </div>
                <table style={{ width:"100%",borderCollapse:"collapse" }}>
                  <thead><tr style={{ background:"#F8FAFC" }}>{["Medicine","Qty","Price","Discount","Amount"].map(h=><th key={h} style={S.th}>{h}</th>)}</tr></thead>
                  <tbody>{(selectedBill.items||[]).map((item,i)=>(<tr key={i}><td style={S.td}>{item.genericName}</td><td style={S.td}>{item.quantity||item.qty}</td><td style={S.td}>₹{item.mrp}</td><td style={S.td}>{item.discount||0}%</td><td style={{ ...S.td,fontWeight:700,color:C.green }}>₹{(item.total||0).toFixed(2)}</td></tr>))}</tbody>
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
            <PH title="Reports & P&L" sub="Daily / Monthly profit & loss · Export PDF" action={<button style={S.btn("teal")} onClick={exportReportPDF}>Export PDF</button>} />
            <div style={{ display:"flex",gap:8,marginBottom:20 }}>
              {[["today","Today"],["week","Last 7 Days"],["month","This Month"]].map(([val,label])=>(
                <button key={val} onClick={()=>setReportPeriod(val)} style={{ padding:"8px 18px",borderRadius:8,border:`1.5px solid ${reportPeriod===val?C.teal:C.border2}`,background:reportPeriod===val?"#E0F7F4":"#fff",color:reportPeriod===val?C.teal:C.text2,cursor:"pointer",fontFamily:"inherit",fontSize:13,fontWeight:reportPeriod===val?700:500 }}>{label}</button>
              ))}
            </div>
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
            <PH title="Stock Alerts" sub={`${lowStock.length} low stock · ${expiringSoon.length} expiring within 3 months`} />
            <div style={{ background:"#FEF9EC",border:"1px solid #F6D860",borderRadius:12,padding:18,marginBottom:14 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
                <span style={{ fontSize:12,fontWeight:700,color:C.amber,textTransform:"uppercase",letterSpacing:"0.5px" }}>Low Stock Items</span>
                <span style={S.badge("amber")}>{lowStock.length} items</span>
              </div>
              {lowStock.length===0?<div style={{ color:C.text3,fontSize:13 }}>All stock levels healthy ✓</div>:lowStock.map(m=>(<div key={m.id} style={{ display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #F0E0A0" }}><div><div style={{ fontSize:13,fontWeight:600 }}>{m.genericName}</div><div style={{ fontSize:11,color:C.text3 }}>{m.brandName} · Alert: {m.lowStockAlert}</div></div><span style={S.badge(m.stockQty===0?"red":"amber")}>{m.stockQty} left</span></div>))}
            </div>
            <div style={{ background:"#FEF2F2",border:"1px solid #FCA5A5",borderRadius:12,padding:18 }}>
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14 }}>
                <span style={{ fontSize:12,fontWeight:700,color:C.red,textTransform:"uppercase",letterSpacing:"0.5px" }}>Expiring / Expired</span>
                <span style={S.badge("red")}>{expiringSoon.length} items</span>
              </div>
              {expiringSoon.length===0?<div style={{ color:C.text3,fontSize:13 }}>No medicines expiring within 3 months ✓</div>:expiringSoon.map(m=>{const[y,mo]=(m.expiryDate||"2099-12").split("-");const isExp=new Date(+y,+mo-1,1)<new Date();return(<div key={m.id} style={{ display:"flex",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #FECACA" }}><div><div style={{ fontSize:13,fontWeight:600 }}>{m.genericName}</div><div style={{ fontSize:11,color:C.text3 }}>{m.brandName} · Batch: {m.batchNumber}</div></div><span style={S.badge(isExp?"red":"amber")}>{isExp?"EXPIRED":`Exp: ${m.expiryDate}`}</span></div>);})}
            </div>
          </div>
        )}
      </main>

      <nav style={{ display:"flex",background:C.navy,flexShrink:0 }}>
        {TABS.slice(0,6).map(tab=>(
          <button key={tab.id} onClick={()=>setActiveTab(tab.id)}
            style={{ flex:1,padding:"9px 2px 8px",background:"none",border:"none",borderTop:`3px solid ${activeTab===tab.id?"#4ECCA3":"transparent"}`,color:activeTab===tab.id?"#4ECCA3":"#90A4B8",cursor:"pointer",fontSize:8,fontFamily:"inherit",fontWeight:700,letterSpacing:"0.3px",textTransform:"uppercase",display:"flex",flexDirection:"column",alignItems:"center",gap:2 }}>
            <span style={{ fontSize:16 }}>{tab.icon}</span>
            <span>{tab.label.split("(")[0].trim().split(" ")[0]}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}