import React, { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

let logo;
try { logo = require('../assets/images/NCF LOGO (1).png'); } catch { logo = null; }

const NAV_ITEMS = [
  // ── Operations pipeline ──────────────────────────────────
  { path: '/',            label: 'Dashboard',             icon: '📊', roles: null },
  { path: '/entries',     label: 'Gate Entries',          icon: '🚛', roles: null },
  { path: '/entries/new', label: 'New Entry',             icon: '➕', roles: ['GateSecurity', 'Admin'], noViewer: true },
  { path: '/weighbridge', label: 'Weighbridge',           icon: '⚖️', roles: ['Weighbridge', 'Admin'] },
  { path: '/qa',          label: 'QA Inspection',         icon: '🔬', roles: ['QAInspector', 'QAManager', 'FactoryQA', 'Admin'] },
  { path: '/ops-approval',label: 'Ops Approval',          icon: '✅', roles: ['OpsManager', 'Supervisor', 'Director', 'Admin'] },
  { path: '/requisition-approval-status', label: 'Requisition Status', icon: '🔎', roles: ['FactoryReceiving', 'StoreReceiving', 'OpsManager', 'Director', 'Admin'] },
  { path: '/procurement/requisitions/raise', label: 'Raise Order', icon: '🧾', roles: ['FactoryReceiving', 'StoreReceiving', 'Admin'], noViewer: true },
  { path: '/central-stores/review', label: 'Central Stores Review', icon: '🏬', roles: ['StoreReceiving', 'Admin'] },
  { path: '/receiving',   label: 'Receiving / GRN',       icon: '📦', roles: ['StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'ProductionClerk', 'Admin'] },
  { path: '/grn',         label: 'GRN List',              icon: '📋', roles: null },
  { path: '/receiving/busy', label: 'Receiving ↔ Busy',   icon: '🔗', roles: ['Admin', 'Supervisor', 'StoreReceiving', 'FactoryReceiving', 'Procurement', 'Director', 'OpsManager'] },
  { path: '/traceability',label: 'Traceability',          icon: '🔍', roles: null },
  // ── Procurement module ───────────────────────────────────
  { divider: 'Procurement', roles: ['Procurement', 'Director', 'Admin', 'OpsManager'] },
  { path: '/procurement/requisitions',   label: 'Requisitions',       icon: '📝', roles: ['Procurement', 'Admin', 'Director'] },
  { path: '/procurement/quotations',     label: 'Capture Quotation',  icon: '💬', roles: ['Procurement', 'Admin'] },
  { path: '/director/evaluation',        label: 'Quote Evaluation',   icon: '⚖️',  roles: ['Director', 'Admin', 'Procurement'] },
  { path: '/procurement/awarded',        label: 'Awarded Suppliers',  icon: '🏆', roles: ['Procurement', 'Admin', 'Director'] },
  { path: '/procurement/held-items',     label: 'Held Items',         icon: '⏸️', roles: ['Procurement', 'Admin', 'Director'] },
  { path: '/procurement/pending-director-approval', label: 'Pending Director Approval', icon: '⏳', roles: ['Procurement', 'Admin', 'Director'] },
  { path: '/procurement/lpo-raised',     label: 'LPOs Raised in Busy', icon: '📑', roles: ['Procurement', 'Admin', 'Director'] },
  { path: '/procurement/trace',          label: 'Order Trace',        icon: '🧭', roles: ['Procurement', 'Admin', 'Director'] },
  { path: '/procurement/reconciliation', label: 'LPO Reconciliation', icon: '🔄', roles: ['Procurement', 'Admin'] },
  { path: '/procurement/reorder',        label: 'Reorder Levels',     icon: '📉', roles: ['Procurement', 'Admin', 'Director', 'ProductionManager', 'OpsManager'] },
  { path: '/procurement/fg-reorder',     label: 'FG Reorder Levels',  icon: '📦', roles: ['Procurement', 'Admin', 'Director', 'ProductionManager', 'OpsManager'] },
  // ── Production module ────────────────────────────────────
  { divider: 'Production', roles: ['Procurement', 'Director', 'Admin', 'ProductionClerk', 'ProductionManager', 'OpsManager'] },
  { path: '/production/planning', label: 'Production Planning', icon: '🧮', roles: ['Procurement', 'Admin', 'Director', 'ProductionClerk', 'ProductionManager', 'OpsManager'] },
  { path: '/production/aging-analysis', label: 'Aging Analysis', icon: '⏳', roles: ['Procurement', 'Admin', 'Director', 'ProductionClerk', 'ProductionManager', 'OpsManager'] },
  // ── Admin & reporting ────────────────────────────────────
  { divider: 'Admin', roles: ['Admin', 'Procurement', 'Supervisor', 'Auditor', 'QAManager'] },
  { path: '/admin/suppliers',       label: 'Suppliers',         icon: '🏭', roles: ['Admin', 'Procurement'] },
  { path: '/admin/item-categories', label: 'Item Category Map', icon: '🗂️', roles: ['Admin', 'Procurement'] },
  { path: '/admin/item-code-lookup', label: 'Item Code Lookup', icon: '🔤', roles: ['Admin', 'Procurement'] },
  { path: '/erp',                   label: 'ERP Lookup',        icon: '🔗', roles: ['Admin', 'Supervisor', 'Auditor', 'QAManager', 'Procurement'] },
  { path: '/users',                 label: 'User Management',   icon: '👥', roles: ['Admin'], noViewer: true },
];

// System Viewer (read-only) sees every link except `noViewer` ones —
// mirrors ProtectedRoute in App.js.
const canSee = (item, role) => {
  if (!item.roles) return true;
  if (role === 'Viewer') return !item.noViewer;
  return item.roles.includes(role);
};

export default function Layout() {
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const visibleNav = NAV_ITEMS.filter((item) => canSee(item, user.role));
  const isViewer = user.role === 'Viewer';

  const closeSidebar = () => setSidebarOpen(false);

  return (
    <div className="app-layout">
      {/* Mobile overlay */}
      {sidebarOpen && <div className="sidebar-overlay" onClick={closeSidebar} />}

      <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <div className="sidebar-brand">
          <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2 }}>Njoro Canning Factory</div>
          <div style={{ fontSize: 11, opacity: 0.7, marginTop: 2 }}>Material Traceability</div>
        </div>
        <nav className="sidebar-nav">
          {visibleNav.map((item) =>
            item.divider ? (
              <div key={item.divider} style={{
                padding: '12px 16px 4px',
                fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
                textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)',
                borderTop: '1px solid rgba(255,255,255,0.08)',
                marginTop: 4,
              }}>
                {item.divider}
              </div>
            ) : (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => isActive ? 'active' : ''}
                onClick={closeSidebar}
              >
                <span>{item.icon}</span> {item.label}
              </NavLink>
            )
          )}
        </nav>
        <div className="sidebar-footer">
          <div>{user.fullName || user.username}</div>
          <div className="text-muted" style={{ fontSize: 12 }}>{user.role}</div>
          <button onClick={logout} style={{ marginTop: 8 }}>Sign out</button>
        </div>
      </aside>
      <main className="main-content">
        <div className="top-bar">
          <div className="top-bar-left">
            <button className="hamburger-btn" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Menu">
              <span /><span /><span />
            </button>
            {logo && <img src={logo} alt="Njoro Canning Factory" className="top-bar-logo" />}
            <span className="top-bar-title">Njoro Canning Factory</span>
          </div>
          <div className="top-bar-right">
            <span className="top-bar-user">{user.fullName || user.username}</span>
            <span className="top-bar-role">{user.role}</span>
          </div>
        </div>
        {isViewer && (
          <div className="alert alert-info" style={{ margin: '12px 16px 0', fontSize: 13 }}>
            👁️ You are signed in as a <strong>System Viewer</strong> — read-only access. You can view every page, but changes are disabled.
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}