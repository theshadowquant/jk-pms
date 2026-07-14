"use client";

import React, { useState, useEffect } from "react";
import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  serverTimestamp 
} from "firebase/firestore";
import { 
  Users, 
  Phone, 
  Mail, 
  Plus, 
  Search, 
  MessageCircle, 
  DollarSign, 
  Edit, 
  Trash, 
  PlusCircle,
  AlertCircle
} from "lucide-react";

// --- Types ---
interface Patient {
  id: string;
  name: string;
  phone: string;
  email?: string;
  outstandingDue: number;
  overdueAmount: number;
  overdueDetails?: string;
  createdAt?: any;
  updatedAt?: any;
}

interface PatientDuesLedgerProps {
  db: any;
  storeId: string;
  storeCode: string;
  user: any;
  patients: Patient[];
  storeDetails: any;
}

// --- Design System Colors ---
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

// --- Styles Helper ---
const S = {
  card: { background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, marginBottom: 16, boxShadow: "0 1px 3px rgba(0,0,0,0.05)" },
  input: { fontFamily: "inherit", fontSize: 13, border: `1.5px solid ${C.border2}`, borderRadius: 8, padding: "9px 12px", background: "#fff", color: C.text, outline: "none", width: "100%", transition: "all 0.15s ease" },
  label: { display: "block", fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase" as const, letterSpacing: "0.5px", marginBottom: 5 },
  btn: (t: "primary" | "teal" | "green" | "outline" | "whatsapp" | "red") => ({
    fontFamily: "inherit", fontSize: 13, fontWeight: 600, borderRadius: 8, padding: "8px 14px",
    cursor: "pointer", border: "none", letterSpacing: "0.2px", transition: "all 0.12s",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    ...(t === "primary" ? { background: C.navy, color: "#fff" } :
        t === "teal"    ? { background: C.teal, color: "#fff" } :
        t === "green"   ? { background: C.green, color: "#fff" } :
        t === "red"     ? { background: C.red, color: "#fff" } :
        t === "whatsapp"? { background: "#25D366", color: "#fff" } :
        t === "outline" ? { background: "#fff", border: `1.5px solid ${C.border2}`, color: C.text2 } : {})
  }),
  badge: (t: "green" | "amber" | "red" | "teal" | "blue") => ({
    display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600,
    ...(t === "green" ? { background: "#E8F5EE", color: C.green } :
        t === "amber" ? { background: "#FEF3DC", color: C.amber } :
        t === "red"   ? { background: "#FDECEA", color: C.red } :
        t === "teal"  ? { background: "#E0F7F4", color: C.teal } :
        t === "blue"  ? { background: "#EBF4FF", color: C.blue } : {})
  }),
  th: { padding: "12px 14px", textAlign: "left" as const, fontSize: 11, fontWeight: 700, color: C.text3, textTransform: "uppercase" as const, letterSpacing: "0.5px", borderBottom: `2px solid ${C.border}`, whiteSpace: "nowrap" as const, background: "#F8FAFC" },
  td: { padding: "12px 14px", borderBottom: `1px solid ${C.border}`, fontSize: 13, color: C.text2 },
};

const FF = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <label style={S.label}>{label}</label>
    {children}
  </div>
);

export default function PatientDuesLedger({
  db,
  storeId,
  storeCode,
  user,
  patients,
  storeDetails
}: PatientDuesLedgerProps) {
  // State
  const [searchQuery, setSearchQuery] = useState("");
  
  // Modal states
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showPayModal, setShowPayModal] = useState(false);
  
  // Forms
  const [newPatientForm, setNewPatientForm] = useState({
    name: "",
    phone: "",
    email: "",
    outstandingDue: "0",
    overdueAmount: "0",
    overdueDetails: ""
  });
  
  const [editPatientForm, setEditPatientForm] = useState<Patient | null>(null);
  
  const [paymentForm, setPaymentForm] = useState({
    patientId: "",
    patientName: "",
    amountPaid: "",
    notes: ""
  });

  // Filter patients
  const filteredPatients = patients.filter(
    p => 
      (p.name || "").toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.phone || "").includes(searchQuery)
  );

  // Totals
  const totalOutstanding = patients.reduce((sum, p) => sum + (p.outstandingDue || 0), 0);
  const totalOverdue = patients.reduce((sum, p) => sum + (p.overdueAmount || 0), 0);
  const patientsWithDues = patients.filter(p => (p.outstandingDue || 0) > 0).length;

  // Add Patient
  const handleAddPatient = async () => {
    if (!newPatientForm.name.trim()) {
      alert("Patient name is required.");
      return;
    }
    if (!newPatientForm.phone.trim()) {
      alert("Phone number is required.");
      return;
    }
    
    try {
      await addDoc(collection(db, "patients"), {
        storeId,
        storeCode,
        name: newPatientForm.name.trim(),
        phone: newPatientForm.phone.trim(),
        email: newPatientForm.email.trim(),
        outstandingDue: parseFloat(newPatientForm.outstandingDue) || 0,
        overdueAmount: parseFloat(newPatientForm.overdueAmount) || 0,
        overdueDetails: newPatientForm.overdueDetails.trim(),
        createdAt: serverTimestamp(),
        createdBy: user.uid,
        updatedAt: serverTimestamp()
      });
      
      alert(`✓ Patient ${newPatientForm.name} added successfully.`);
      setNewPatientForm({
        name: "",
        phone: "",
        email: "",
        outstandingDue: "0",
        overdueAmount: "0",
        overdueDetails: ""
      });
      setShowAddModal(false);
    } catch (err: any) {
      console.error("Error adding patient:", err);
      alert("Error adding patient: " + err.message);
    }
  };

  // Edit Patient
  const handleUpdatePatient = async () => {
    if (!editPatientForm || !editPatientForm.name.trim()) {
      alert("Patient name is required.");
      return;
    }
    
    try {
      const patientRef = doc(db, "patients", editPatientForm.id);
      await updateDoc(patientRef, {
        name: editPatientForm.name.trim(),
        phone: editPatientForm.phone.trim(),
        email: editPatientForm.email || "",
        outstandingDue: editPatientForm.outstandingDue || 0,
        overdueAmount: editPatientForm.overdueAmount || 0,
        overdueDetails: editPatientForm.overdueDetails || "",
        updatedAt: serverTimestamp()
      });
      
      alert("✓ Patient details updated successfully.");
      setShowEditModal(false);
      setEditPatientForm(null);
    } catch (err: any) {
      console.error("Error updating patient:", err);
      alert("Error updating patient: " + err.message);
    }
  };

  // Record Patient Payment
  const handleRecordPayment = async () => {
    const payAmt = parseFloat(paymentForm.amountPaid);
    if (!paymentForm.patientId || isNaN(payAmt) || payAmt <= 0) {
      alert("Please select a patient and enter a valid amount.");
      return;
    }
    
    try {
      const patientRef = doc(db, "patients", paymentForm.patientId);
      const patient = patients.find(p => p.id === paymentForm.patientId);
      if (!patient) return;

      const newOutstanding = Math.max(0, (patient.outstandingDue || 0) - payAmt);
      const newOverdue = Math.max(0, (patient.overdueAmount || 0) - payAmt);

      await updateDoc(patientRef, {
        outstandingDue: newOutstanding,
        overdueAmount: newOverdue,
        updatedAt: serverTimestamp()
      });

      // Add a patient transaction record
      await addDoc(collection(db, "patient_payments"), {
        storeId,
        storeCode,
        patientId: paymentForm.patientId,
        patientName: patient.name,
        patientPhone: patient.phone,
        amountPaid: payAmt,
        previousOutstanding: patient.outstandingDue || 0,
        newOutstanding: newOutstanding,
        previousOverdue: patient.overdueAmount || 0,
        newOverdue: newOverdue,
        notes: paymentForm.notes.trim() || "Manual Payment Settlement",
        createdAt: serverTimestamp(),
        createdBy: user.uid
      });

      alert(`✓ Recorded payment of ₹${payAmt.toFixed(2)} for ${patient.name}. Remaining Dues: ₹${newOutstanding.toFixed(2)}`);
      setPaymentForm({
        patientId: "",
        patientName: "",
        amountPaid: "",
        notes: ""
      });
      setShowPayModal(false);
    } catch (err: any) {
      console.error("Error recording payment:", err);
      alert("Error recording payment: " + err.message);
    }
  };

  // Delete Patient
  const handleDeletePatient = async (patientId: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete patient "${name}"? This action cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, "patients", patientId));
      alert("✓ Patient profile deleted successfully.");
    } catch (err: any) {
      alert("Error deleting patient: " + err.message);
    }
  };

  // Send WhatsApp Reminder
  const sendWhatsAppReminder = (patient: Patient) => {
    if (!patient.phone) return;
    
    const upiId = storeDetails?.upiId || "7676309842@jupiteraxis";
    const storeName = storeDetails?.name || "Janaushadhi Kendra";
    const storePhone = storeDetails?.phone || storeDetails?.helpline || "9964382376";
    
    const outstanding = (patient.outstandingDue || 0).toFixed(2);
    const overdue = (patient.overdueAmount || 0).toFixed(2);
    const payeeName = encodeURIComponent(storeName);
    
    // Generate UPI Payment URI
    const upiPayUri = `upi://pay?pa=${upiId}&pn=${payeeName}&am=${outstanding}&cu=INR`;
    
    const messageText = `*${storeName.toUpperCase()}*\nPh: ${storePhone}\n\nDear *${patient.name}*,\n\nThis is a friendly reminder from Janaushadhi Pharmacy regarding your pending outstanding balance.\n\n• *Total Outstanding Due:* ₹${outstanding}\n• *Overdue Amount:* ₹${overdue}\n\nPlease settle your dues at your earliest convenience. You can scan and pay via UPI directly using the link below:\n\n*Direct UPI Pay Link:*\n${upiPayUri}\n\nThank you! 🙏`;
    
    const cleanPhone = patient.phone.replace(/\D/g, "");
    const formattedPhone = cleanPhone.startsWith("91") ? cleanPhone : "91" + cleanPhone;
    
    window.open(`https://wa.me/${formattedPhone}?text=${encodeURIComponent(messageText)}`, "_blank");
  };

  return (
    <div>
      {/* HEADER ROW */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.navy, letterSpacing: "-0.3px", marginBottom: 3 }}>
            Patient Dues Ledger
          </div>
          <div style={{ fontSize: 12, color: C.text3 }}>
            Track patient outstanding balances, log manually overdue amounts, record payments, and send billing reminders.
          </div>
        </div>
        <button style={S.btn("primary")} onClick={() => setShowAddModal(true)}>
          <PlusCircle size={16} /> Add New Patient
        </button>
      </div>

      {/* KPI SUMMARY CARDS */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, marginBottom: 20 }}>
        <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: "#FDECEA", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.red }}>
            <AlertCircle size={24} />
          </div>
          <div>
            <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px", textTransform: "uppercase" }}>Total Outstanding Dues</span>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.red }}>₹{totalOutstanding.toFixed(2)}</div>
          </div>
        </div>

        <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: "#FEF3DC", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.amber }}>
            <DollarSign size={24} />
          </div>
          <div>
            <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px", textTransform: "uppercase" }}>Overdue Dues</span>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.amber }}>₹{totalOverdue.toFixed(2)}</div>
          </div>
        </div>

        <div style={{ ...S.card, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 44, height: 44, borderRadius: 10, background: "#E8F5EE", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, color: C.green }}>
            <Users size={24} />
          </div>
          <div>
            <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: "0.5px", textTransform: "uppercase" }}>Active Debtors</span>
            <div style={{ fontSize: 24, fontWeight: 800, color: C.green }}>{patientsWithDues} Patients</div>
          </div>
        </div>
      </div>

      {/* FILTER SEARCH ROW */}
      <div style={{ ...S.card, padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <Search size={18} style={{ color: C.text3 }} />
        <input
          style={{ ...S.input, border: "none", background: "transparent", padding: 0 }}
          placeholder="Search patients by name or phone number..."
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
        />
      </div>

      {/* PATIENTS TABLE */}
      <div style={{ ...S.card, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={S.th}>Patient Name</th>
                <th style={S.th}>Contact Info</th>
                <th style={S.th}>Outstanding balance</th>
                <th style={S.th}>Overdue Amount</th>
                <th style={S.th}>Status</th>
                <th style={{ ...S.th, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredPatients.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ ...S.td, textAlign: "center", padding: "32px 0", color: C.text3, fontStyle: "italic" }}>
                    No patients matched the criteria.
                  </td>
                </tr>
              ) : (
                filteredPatients.map(p => {
                  const hasDues = (p.outstandingDue || 0) > 0;
                  const hasOverdue = (p.overdueAmount || 0) > 0;
                  
                  return (
                    <tr key={p.id}>
                      <td style={{ ...S.td, fontWeight: 700, color: C.navy }}>{p.name}</td>
                      <td style={S.td}>
                        <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 600 }}>
                          <Phone size={12} style={{ color: C.text3 }} /> {p.phone}
                        </div>
                        {p.email && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: C.text3, marginTop: 2 }}>
                            <Mail size={12} style={{ color: C.text3 }} /> {p.email}
                          </div>
                        )}
                      </td>
                      <td style={{ ...S.td, fontWeight: 700, color: hasDues ? C.red : C.green }}>
                        ₹{(p.outstandingDue || 0).toFixed(2)}
                      </td>
                      <td style={{ ...S.td, fontWeight: 700, color: hasOverdue ? C.red : C.text2 }}>
                        ₹{(p.overdueAmount || 0).toFixed(2)}
                      </td>
                      <td style={S.td}>
                        <span style={S.badge(hasOverdue ? "red" : hasDues ? "amber" : "green")}>
                          {hasOverdue ? "Overdue" : hasDues ? "Due Balance" : "Clear"}
                        </span>
                      </td>
                      <td style={{ ...S.td, textAlign: "right" }}>
                        <div style={{ display: "inline-flex", gap: 6 }}>
                          {hasDues && (
                            <button
                              style={{ ...S.btn("green"), padding: "5px 10px", fontSize: 11 }}
                              onClick={() => {
                                setPaymentForm({
                                  patientId: p.id,
                                  patientName: p.name,
                                  amountPaid: String(p.outstandingDue),
                                  notes: ""
                                });
                                setShowPayModal(true);
                              }}
                            >
                              💸 Pay
                            </button>
                          )}
                          <button
                            style={{ ...S.btn("outline"), padding: "5px 10px", fontSize: 11 }}
                            onClick={() => {
                              setEditPatientForm(p);
                              setShowEditModal(true);
                            }}
                          >
                            ✏️ Edit
                          </button>
                          {hasDues && (
                            <button
                              style={{ ...S.btn("whatsapp"), padding: "5px 10px", fontSize: 11 }}
                              onClick={() => sendWhatsAppReminder(p)}
                              title="Send WhatsApp payment reminder"
                            >
                              <MessageCircle size={12} /> Remind
                            </button>
                          )}
                          <button
                            style={{ ...S.btn("outline"), padding: "5px 10px", fontSize: 11, borderColor: "#FCCACA", color: C.red }}
                            onClick={() => handleDeletePatient(p.id, p.name)}
                          >
                            <Trash size={12} />
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

      {/* ADD PATIENT MODAL */}
      {showAddModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 10000 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 450, padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Register New Patient</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Store custom patient credit profile details</span>
              </div>
              <button onClick={() => setShowAddModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Patient Name *">
                  <input
                    type="text"
                    style={S.input}
                    placeholder="Enter full name"
                    value={newPatientForm.name}
                    onChange={e => setNewPatientForm(p => ({ ...p, name: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Phone Number *">
                  <input
                    type="text"
                    style={S.input}
                    placeholder="10-digit mobile"
                    value={newPatientForm.phone}
                    onChange={e => setNewPatientForm(p => ({ ...p, phone: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Email Address">
                  <input
                    type="email"
                    style={S.input}
                    placeholder="patient@email.com"
                    value={newPatientForm.email}
                    onChange={e => setNewPatientForm(p => ({ ...p, email: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Outstanding Balance (₹)">
                  <input
                    type="number"
                    style={S.input}
                    placeholder="0.00"
                    value={newPatientForm.outstandingDue}
                    onChange={e => setNewPatientForm(p => ({ ...p, outstandingDue: e.target.value }))}
                  />
                </FF>
              </div>
              <div>
                <FF label="Overdue Amount (₹)">
                  <input
                    type="number"
                    style={S.input}
                    placeholder="0.00"
                    value={newPatientForm.overdueAmount}
                    onChange={e => setNewPatientForm(p => ({ ...p, overdueAmount: e.target.value }))}
                  />
                </FF>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Overdue Breakdown Details (Printed on Invoice)">
                  <textarea
                    style={{ ...S.input, height: 65, resize: "none" }}
                    placeholder="e.g. Inv No.: 24-25/9418\nLulicinazole 20 PCS * ₹55/- = ₹1100/-"
                    value={newPatientForm.overdueDetails}
                    onChange={e => setNewPatientForm(p => ({ ...p, overdueDetails: e.target.value }))}
                  />
                </FF>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowAddModal(false)}>Cancel</button>
              <button 
                style={S.btn("primary")} 
                onClick={handleAddPatient}
                disabled={!newPatientForm.name || !newPatientForm.phone}
              >
                Create Profile
              </button>
            </div>
          </div>
        </div>
      )}

      {/* EDIT PATIENT MODAL */}
      {showEditModal && editPatientForm && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 10000 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 450, padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Edit Patient Profile</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Update profiles and manual debt figures</span>
              </div>
              <button onClick={() => { setShowEditModal(false); setEditPatientForm(null); }} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }}>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Patient Name *">
                  <input
                    type="text"
                    style={S.input}
                    value={editPatientForm.name}
                    onChange={e => setEditPatientForm(p => p ? { ...p, name: e.target.value } : null)}
                  />
                </FF>
              </div>
              <div>
                <FF label="Phone Number *">
                  <input
                    type="text"
                    style={S.input}
                    value={editPatientForm.phone}
                    onChange={e => setEditPatientForm(p => p ? { ...p, phone: e.target.value } : null)}
                  />
                </FF>
              </div>
              <div>
                <FF label="Email Address">
                  <input
                    type="email"
                    style={S.input}
                    value={editPatientForm.email || ""}
                    onChange={e => setEditPatientForm(p => p ? { ...p, email: e.target.value } : null)}
                  />
                </FF>
              </div>
              <div>
                <FF label="Outstanding Balance (₹)">
                  <input
                    type="number"
                    style={S.input}
                    value={editPatientForm.outstandingDue}
                    onChange={e => setEditPatientForm(p => p ? { ...p, outstandingDue: parseFloat(e.target.value) || 0 } : null)}
                  />
                </FF>
              </div>
              <div>
                <FF label="Overdue Amount (₹)">
                  <input
                    type="number"
                    style={S.input}
                    value={editPatientForm.overdueAmount}
                    onChange={e => setEditPatientForm(p => p ? { ...p, overdueAmount: parseFloat(e.target.value) || 0 } : null)}
                  />
                </FF>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <FF label="Overdue Breakdown Details (Printed on Invoice)">
                  <textarea
                    style={{ ...S.input, height: 65, resize: "none" }}
                    placeholder="e.g. Inv No.: 24-25/9418\nLulicinazole 20 PCS * ₹55/- = ₹1100/-"
                    value={editPatientForm.overdueDetails || ""}
                    onChange={e => setEditPatientForm(p => p ? { ...p, overdueDetails: e.target.value } : null)}
                  />
                </FF>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => { setShowEditModal(false); setEditPatientForm(null); }}>Cancel</button>
              <button 
                style={S.btn("primary")} 
                onClick={handleUpdatePatient}
                disabled={!editPatientForm.name || !editPatientForm.phone}
              >
                Save Details
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECORD PAYMENT MODAL */}
      {showPayModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(10,35,66,0.5)", backdropFilter: "blur(4px)", display: "flex", justifyContent: "center", alignItems: "center", zIndex: 10000 }}>
          <div style={{ background: "#fff", borderRadius: 16, width: "100%", maxWidth: 450, padding: 24, boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)", border: `1px solid ${C.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: `1.5px solid ${C.border}`, paddingBottom: 12, marginBottom: 16 }}>
              <div>
                <h3 style={{ fontSize: 16, fontWeight: 800, color: C.navy, margin: 0 }}>Record Patient Dues Collection</h3>
                <span style={{ fontSize: 11, color: C.text3 }}>Deduct collected payment from patient outstanding ledger</span>
              </div>
              <button onClick={() => setShowPayModal(false)} style={{ background: "none", border: "none", fontSize: 20, cursor: "pointer", color: C.text3 }}>×</button>
            </div>
            
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20 }}>
              <FF label="Patient Name">
                <input
                  type="text"
                  style={{ ...S.input, background: "#E2E8F0", cursor: "not-allowed" }}
                  value={paymentForm.patientName}
                  disabled
                />
              </FF>
              
              <FF label="Amount Paid (₹) *">
                <input
                  type="number"
                  style={S.input}
                  placeholder="0.00"
                  value={paymentForm.amountPaid}
                  onChange={e => setPaymentForm(p => ({ ...p, amountPaid: e.target.value }))}
                />
              </FF>
              
              <FF label="Notes / Transaction Info">
                <input
                  type="text"
                  style={S.input}
                  placeholder="e.g. Cash, GPay UPI transaction ID, bank check"
                  value={paymentForm.notes}
                  onChange={e => setPaymentForm(p => ({ ...p, notes: e.target.value }))}
                />
              </FF>
            </div>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button style={S.btn("outline")} onClick={() => setShowPayModal(false)}>Cancel</button>
              <button 
                style={S.btn("primary")} 
                onClick={handleRecordPayment}
                disabled={!paymentForm.amountPaid || parseFloat(paymentForm.amountPaid) <= 0}
              >
                Settle Payment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
