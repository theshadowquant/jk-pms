"use client";

import React, { useState, useCallback, useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  Settings,
  HelpCircle,
  LogOut,
  User,
  Building2,
  Package,
  ShoppingCart,
  CreditCard,
  Landmark,
  FileText,
  Users,
  Wrench,
  Store,
  Pill,
  Stethoscope,
  Truck,
  Receipt,
  ArrowLeftRight,
  Boxes,
  BarChart3,
  Bell,
  Search,
  Plus,
  Minus,
  RotateCcw,
  FileMinus,
  BookOpen,
  Calculator,
  Wallet,
  ClipboardList,
  TrendingUp,
  MessageCircle,
  Smartphone,
  Database,
  Download,
  Upload,
  Shield,
  type LucideIcon,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────

interface SubMenuItem {
  label: string;
  id: string;
  icon?: React.ComponentType<any>;
  action?: "navigate" | "modal" | "toast";
  target?: string;
  modalType?: "openingStock" | "payment" | "receipt" | "contra" | "journal";
}

interface NavGroup {
  label: string;
  id: string;
  icon: React.ComponentType<any>;
  items: SubMenuItem[];
  defaultExpanded?: boolean;
}

interface SidebarProps {
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  storeName?: string;
  storeCode?: string;
  userRole?: string;
  userEmail?: string;
  onSignOut: () => void;
  onOpenModal?: (type: string) => void;
  onNavigate?: (path: string) => void;
  activeTab?: string;
}

// ─── Navigation Data ────────────────────────────────────────────────
// Mapped to actual SPA tab IDs in target fields so they match app/page.jsx state:
// /dashboard -> dashboard
// /vendors   -> vendors
// /inventory -> inventory
// /billing   -> billing
// /purchase  -> purchase
// /reorders  -> reorders
// /bills     -> bills
// /reports   -> reports
// /settings  -> settings

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Dashboard",
    id: "dashboard",
    icon: LayoutDashboard,
    items: [],
    defaultExpanded: false,
  },
  {
    label: "Master",
    id: "master",
    icon: Database,
    items: [
      { label: "Accounts Master", id: "accounts-master", icon: Users, action: "navigate", target: "/vendors" },
      { label: "Inventory Master", id: "inventory-master", icon: Package, action: "navigate", target: "/inventory" },
      { label: "PMBI Item Master", id: "pmbi-item-master", icon: FileText, action: "navigate", target: "/pmbi-item-master" },
      { label: "Rate Master", id: "rate-master", icon: TrendingUp, action: "toast" },
      { label: "Discount Master", id: "discount-master", icon: Minus, action: "toast" },
      { label: "Other Master", id: "other-master", icon: Wrench, action: "toast" },
      { label: "Opening Balance", id: "opening-balance", icon: Plus, action: "modal", modalType: "openingStock" },
      { label: "PMBI Opening Stock", id: "pmbi-opening-stock", icon: Plus, action: "navigate", target: "/pmbi-opening-stock" },
    ],
  },
  {
    label: "Sale",
    id: "sale",
    icon: ShoppingCart,
    items: [
      { label: "Bill", id: "sale-bill", icon: Receipt, action: "navigate", target: "/billing" },
      { label: "Stock Issue", id: "stock-issue", icon: ArrowLeftRight, action: "navigate", target: "/billing" },
      { label: "Order", id: "sale-order", icon: ClipboardList, action: "navigate", target: "/billing" },
      { label: "Return", id: "sale-return", icon: RotateCcw, action: "navigate", target: "/billing" },
      { label: "Brk/Waste Receive", id: "brk-waste-receive", icon: FileMinus, action: "toast" },
      { label: "Draft", id: "sale-draft", icon: FileText, action: "navigate", target: "/billing" },
    ],
  },
  {
    label: "Purchase",
    id: "purchase",
    icon: Truck,
    items: [
      { label: "Bill", id: "purchase-bill", icon: Receipt, action: "navigate", target: "/purchase" },
      { label: "PMBI Purchase Entry", id: "pmbi-purchase", icon: Receipt, action: "navigate", target: "/pmbi-purchase" },
      { label: "Challan", id: "purchase-challan", icon: ClipboardList, action: "navigate", target: "/purchase" },
      { label: "Stock Receive", id: "stock-receive", icon: Boxes, action: "navigate", target: "/purchase" },
      { label: "Order", id: "purchase-order", icon: BookOpen, action: "navigate", target: "/reorders" },
      { label: "Return", id: "purchase-return", icon: RotateCcw, action: "navigate", target: "/purchase" },
      { label: "Brk/Waste Issue", id: "brk-waste-issue", icon: FileMinus, action: "toast" },
    ],
  },
  {
    label: "Accounting Trans.",
    id: "accounting",
    icon: Calculator,
    items: [
      { label: "Receipt", id: "receipt", icon: Receipt, action: "navigate", target: "/bills" },
      { label: "Payment", id: "payment", icon: CreditCard, action: "modal", modalType: "payment" },
      { label: "Debit Note", id: "debit-note", icon: FileMinus, action: "toast" },
      { label: "Credit Note", id: "credit-note", icon: Plus, action: "toast" },
      { label: "Contra", id: "contra", icon: ArrowLeftRight, action: "navigate", target: "/bills" },
      { label: "Journal", id: "journal", icon: BookOpen, action: "navigate", target: "/bills" },
      { label: "PDC Cheque", id: "pdc-cheque", icon: Landmark, action: "toast" },
      { label: "Bank Reconciliation", id: "bank-reconciliation", icon: Landmark, action: "toast" },
    ],
  },
  {
    label: "Stock Management",
    id: "stock",
    icon: Boxes,
    items: [
      { label: "Stock Transfer", id: "stock-transfer", icon: ArrowLeftRight, action: "navigate", target: "/inventory" },
      { label: "Physical Stock", id: "physical-stock", icon: Search, action: "navigate", target: "/inventory" },
    ],
  },
  {
    label: "Banking",
    id: "banking",
    icon: Landmark,
    items: [
      { label: "Bank Reconciliation", id: "banking-reconciliation", icon: FileText, action: "toast" },
      { label: "PDC Management", id: "pdc-management", icon: Shield, action: "toast" },
    ],
  },
  {
    label: "Report",
    id: "report",
    icon: BarChart3,
    items: [
      { label: "Accounts Report", id: "accounts-report", icon: FileText, action: "navigate", target: "/reports" },
      { label: "Inventory Report", id: "inventory-report", icon: Package, action: "navigate", target: "/reports" },
      { label: "Statutory Report", id: "statutory-report", icon: Shield, action: "navigate", target: "/reports" },
      { label: "Management Report", id: "management-report", icon: TrendingUp, action: "navigate", target: "/analytics" },
      { label: "PMBI Reports", id: "pmbi-reports", icon: BarChart3, action: "navigate", target: "/pmbi-reports" },
      { label: "H1 Drug Register", id: "h1-tracking", icon: ClipboardList, action: "navigate", target: "/h1-tracking" },
    ],
  },
  {
    label: "CRM",
    id: "crm",
    icon: Users,
    items: [
      { label: "Customers", id: "crm-customers", icon: Users, action: "navigate", target: "/vendors" },
      { label: "Suppliers", id: "crm-suppliers", icon: Truck, action: "navigate", target: "/vendors" },
      { label: "Doctors", id: "crm-doctors", icon: Stethoscope, action: "navigate", target: "/vendors" },
    ],
  },
  {
    label: "Other Products",
    id: "other-products",
    icon: Pill,
    items: [
      { label: "Generic Medicines", id: "generic-medicines", icon: Pill, action: "navigate", target: "/inventory" },
      { label: "Surgical Items", id: "surgical-items", icon: Stethoscope, action: "navigate", target: "/inventory" },
      { label: "Wellness", id: "wellness", icon: Heart, action: "navigate", target: "/inventory" },
    ],
  },
  {
    label: "Utilities & Tools",
    id: "utilities",
    icon: Wrench,
    items: [
      { label: "Data Backup", id: "data-backup", icon: Download, action: "toast" },
      { label: "Data Import", id: "data-import", icon: Upload, action: "toast" },
      { label: "Settings", id: "settings", icon: Settings, action: "navigate", target: "/settings" },
    ],
  },
  {
    label: "Online Store",
    id: "online-store",
    icon: Store,
    items: [
      { label: "Storefront", id: "storefront", icon: Smartphone, action: "navigate", target: "/settings" },
      { label: "Orders", id: "online-orders", icon: ShoppingCart, action: "navigate", target: "/settings" },
    ],
  },
];

const getTabGroup = (tab: string) => {
  if (["billing"].includes(tab)) return "sale";
  if (["purchase", "reorders", "pmbi-purchase"].includes(tab)) return "purchase";
  if (["vendors", "inventory", "pmbi-opening-stock"].includes(tab)) return "master";
  if (["reports", "pmbi-reports", "h1-tracking", "analytics"].includes(tab)) return "report";
  if (["settings"].includes(tab)) return "utilities";
  if (["bills"].includes(tab)) return "accounting";
  return null;
};

// Heart icon missing from lucide import, adding inline
function Heart(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
    </svg>
  );
}

// ─── Toast Component (Inline) ─────────────────────────────────────

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);

  return (
    <div className="fixed bottom-4 right-4 z-[9999] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="bg-slate-800 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-3">
        <Bell className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-medium">{message}</span>
        <button onClick={onClose} className="ml-2 text-slate-400 hover:text-white">
          ×
        </button>
      </div>
    </div>
  );
}

// ─── Tooltip Component ─────────────────────────────────────────────

function Tooltip({ children, content, visible }: { children: React.ReactNode; content: string; visible: boolean }) {
  if (!visible) return <>{children}</>;
  return (
    <div className="group relative">
      {children}
      <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-slate-800 text-white text-xs rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 whitespace-nowrap pointer-events-none z-50">
        {content}
        <div className="absolute left-0 top-1/2 -translate-x-1 -translate-y-1/2 border-4 border-transparent border-r-slate-800" />
      </div>
    </div>
  );
}

// ─── Main Sidebar Component ───────────────────────────────────────

export default function Sidebar({
  isCollapsed,
  onToggleCollapse,
  storeName = "GENERIC AUSHADHI KENDRA",
  storeCode = "GEAUKE",
  userRole = "Admin",
  userEmail = "",
  onSignOut,
  onOpenModal,
  onNavigate,
  activeTab = "dashboard",
}: SidebarProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    const activeGroup = getTabGroup(activeTab);
    if (activeGroup) {
      initial.add(activeGroup);
    } else {
      NAV_GROUPS.forEach((g) => {
        if (g.defaultExpanded) initial.add(g.id);
      });
    }
    return initial;
  });

  const [toast, setToast] = useState<string | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  // Auto-expand group containing active item
  useEffect(() => {
    const activeGroup = getTabGroup(activeTab);
    if (activeGroup) {
      setExpandedGroups(new Set([activeGroup]));
    }
  }, [activeTab]);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set<string>();
      if (!prev.has(groupId)) {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const handleItemClick = useCallback(
    (item: SubMenuItem) => {
      if (item.action === "navigate" && item.target) {
        if (onNavigate) {
          onNavigate(item.target);
        } else {
          router.push(item.target);
        }
      } else if (item.action === "modal" && item.modalType && onOpenModal) {
        onOpenModal(item.modalType);
      } else if (item.action === "toast") {
        setToast(`"${item.label}" is coming soon!`);
      }
    },
    [onNavigate, onOpenModal, router]
  );

  const isGroupActive = (group: NavGroup) => {
    if (group.id === activeTab) return true;
    const tabGroup = getTabGroup(activeTab);
    return tabGroup === group.id;
  };

  const isItemActive = (item: SubMenuItem) => {
    if (!item.target) return false;
    const targetTab = item.target.split("/").pop();
    return targetTab === activeTab;
  };

  return (
    <>
      {/* Toast Notification */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}

      <aside
        className={`
          fixed left-0 top-0 h-screen bg-[#0f172a] flex flex-col
          transition-all duration-300 ease-in-out z-40
          md:translate-x-0
          ${isCollapsed 
            ? "w-0 -translate-x-full md:w-16 md:translate-x-0" 
            : "w-60 translate-x-0"
          }
        `}
      >
        {/* ─── Logo / Company Header ─── */}
        <div
          className={`
            h-14 flex items-center border-b border-slate-700/50
            ${isCollapsed ? "justify-center px-2" : "px-4 gap-3"}
          `}
        >
          <div className="w-8 h-8 rounded bg-[#0f766e] flex items-center justify-center flex-shrink-0">
            <Pill className="w-5 h-5 text-white" strokeWidth={1.5} />
          </div>
          {!isCollapsed && (
            <div className="flex-1 min-w-0">
              <div className="text-white font-semibold text-sm truncate leading-tight">
                {storeName}
              </div>
              <div className="text-slate-400 text-[10px] uppercase tracking-wider">
                {storeCode}
              </div>
            </div>
          )}
        </div>

        {/* ─── Navigation Groups ─── */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 custom-scrollbar">
          {NAV_GROUPS.map((group) => {
            const Icon = group.icon;
            const expanded = expandedGroups.has(group.id);
            const groupActive = isGroupActive(group);

            return (
              <div key={group.id} className="mb-0.5">
                {/* Group Header */}
                {group.items.length === 0 ? (
                  // Single item (no submenu) — like Dashboard
                  <Tooltip content={group.label} visible={isCollapsed}>
                    <button
                      onClick={() => handleItemClick({ id: group.id, label: group.label, action: "navigate", target: "/dashboard" })}
                      className={`
                        w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-all duration-200 cursor-pointer
                        ${groupActive || activeTab === group.id
                          ? "bg-[#1e293b] text-white border-l-[3px] border-[#0f766e]"
                          : "text-slate-400 hover:bg-[#1e293b] hover:text-white border-l-[3px] border-transparent"
                        }
                        ${isCollapsed ? "justify-center px-2" : ""}
                      `}
                    >
                      <Icon className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
                      {!isCollapsed && (
                        <>
                          <span className="flex-1 text-left truncate">{group.label}</span>
                        </>
                      )}
                    </button>
                  </Tooltip>
                ) : (
                  // Group with submenu
                  <>
                    <Tooltip content={group.label} visible={isCollapsed}>
                      <button
                        onClick={() => !isCollapsed && toggleGroup(group.id)}
                        className={`
                          w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-all duration-200 cursor-pointer
                          ${groupActive
                            ? "bg-[#1e293b] text-white border-l-[3px] border-[#0f766e]"
                            : "text-slate-400 hover:bg-[#1e293b] hover:text-white border-l-[3px] border-transparent"
                          }
                          ${isCollapsed ? "justify-center px-2" : ""}
                        `}
                      >
                        <Icon className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
                        {!isCollapsed && (
                          <>
                            <span className="flex-1 text-left truncate">{group.label}</span>
                            <ChevronRight
                              className={`
                                w-4 h-4 flex-shrink-0 transition-transform duration-200
                                ${expanded ? "rotate-90" : ""}
                              `}
                            />
                          </>
                        )}
                      </button>
                    </Tooltip>

                    {/* Submenu Items */}
                    {!isCollapsed && expanded && (
                      <div className="overflow-hidden transition-all duration-300 ease-in-out">
                        <div className="bg-[#0f172a]/50 py-1">
                          {group.items.map((item) => {
                            const ItemIcon = item.icon || FileText;
                            const itemActive = isItemActive(item);

                            return (
                              <button
                                key={item.id}
                                onClick={() => handleItemClick(item)}
                                className={`
                                  w-full flex items-center gap-3 pl-10 pr-3 py-2 text-sm transition-all duration-200 cursor-pointer
                                  ${itemActive
                                    ? "text-[#0f766e] font-medium bg-[#1e293b]/50"
                                    : "text-slate-500 hover:text-slate-300 hover:bg-[#1e293b]/30"
                                  }
                                `}
                              >
                                <ItemIcon className="w-4 h-4 flex-shrink-0" strokeWidth={1.5} />
                                <span className="flex-1 text-left truncate">{item.label}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </nav>

        {/* ─── Bottom Actions ─── */}
        <div className="border-t border-slate-700/50 py-2">
          {/* Collapse Toggle */}
          <Tooltip content={isCollapsed ? "Expand" : "Collapse"} visible={isCollapsed}>
            <button
              onClick={onToggleCollapse}
              className={`
                w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-400
                hover:bg-[#1e293b] hover:text-white transition-all duration-200 cursor-pointer
                ${isCollapsed ? "justify-center px-2" : ""}
              `}
            >
              <ChevronLeft
                className={`
                  w-5 h-5 flex-shrink-0 transition-transform duration-300
                  ${isCollapsed ? "rotate-180" : ""}
                `}
                strokeWidth={1.5}
              />
              {!isCollapsed && <span className="flex-1 text-left">Collapse</span>}
            </button>
          </Tooltip>

          {/* User Profile */}
          {!isCollapsed && userEmail && (
            <div className="px-3 py-2 mt-1">
              <div className="flex items-center gap-2 px-2 py-2 rounded bg-[#1e293b]/50">
                <div className="w-7 h-7 rounded-full bg-[#0f766e] flex items-center justify-center">
                  <User className="w-4 h-4 text-white" strokeWidth={1.5} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-xs font-medium truncate">{userEmail}</div>
                  <div className="text-slate-500 text-[10px]">{userRole}</div>
                </div>
              </div>
            </div>
          )}

          {/* Sign Out */}
          <Tooltip content="Sign Out" visible={isCollapsed}>
            <button
              onClick={onSignOut}
              className={`
                w-full flex items-center gap-3 px-3 py-2.5 text-sm text-slate-400
                hover:bg-red-900/20 hover:text-red-400 transition-all duration-200 cursor-pointer
                ${isCollapsed ? "justify-center px-2" : ""}
              `}
            >
              <LogOut className="w-5 h-5 flex-shrink-0" strokeWidth={1.5} />
              {!isCollapsed && <span className="flex-1 text-left">Sign Out</span>}
            </button>
          </Tooltip>
        </div>
      </aside>

      {/* Custom Scrollbar Styles */}
      <style jsx>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #334155;
          border-radius: 2px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #475569;
        }
      `}</style>
    </>
  );
}
