import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import LoginPage from './pages/LoginPage';
import './index.css';

// Lazy-load all page components for code splitting
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const GateEntryPage = lazy(() => import('./pages/GateEntryPage'));
const GateEntryListPage = lazy(() => import('./pages/GateEntryListPage'));
const WeighbridgePage = lazy(() => import('./pages/WeighbridgePage'));
const QAInspectionPage = lazy(() => import('./pages/QAInspectionPage'));
const ReceivingPage = lazy(() => import('./pages/ReceivingPage'));
const GRNListPage = lazy(() => import('./pages/GRNListPage'));
const GoodsRejectionPage = lazy(() => import('./pages/GoodsRejectionPage'));
const TraceabilityPage = lazy(() => import('./pages/TraceabilityPage'));
const ERPLookupPage = lazy(() => import('./pages/ERPLookupPage'));
const UserManagementPage = lazy(() => import('./pages/UserManagementPage'));
const OpsManagerApprovalPage  = lazy(() => import('./pages/OpsManagerApprovalPage'));
const RequisitionApprovalStatusPage = lazy(() => import('./pages/RequisitionApprovalStatusPage'));
const CreateRequisitionPage   = lazy(() => import('./pages/CreateRequisitionPage'));
const CentralStoresApprovalPage = lazy(() => import('./pages/CentralStoresApprovalPage'));

// Procurement module
const RequisitionsPage        = lazy(() => import('./pages/RequisitionsPage'));
const RequisitionDetailPage   = lazy(() => import('./pages/RequisitionDetailPage'));
const CreateBundledRFQPage    = lazy(() => import('./pages/CreateBundledRFQPage'));
const QuotationCapturePage    = lazy(() => import('./pages/QuotationCapturePage'));
const DirectorEvaluationPage  = lazy(() => import('./pages/DirectorEvaluationPage'));
const ProcurementAwardsPage   = lazy(() => import('./pages/ProcurementAwardsPage'));
const HeldItemsPage           = lazy(() => import('./pages/HeldItemsPage'));
const PendingDirectorApprovalPage = lazy(() => import('./pages/PendingDirectorApprovalPage'));
const LPOReconciliationPage   = lazy(() => import('./pages/LPOReconciliationPage'));
const BusyLPOsRaisedPage      = lazy(() => import('./pages/BusyLPOsRaisedPage'));
const BusyReceivingPage       = lazy(() => import('./pages/BusyReceivingPage'));
const OrderTracePage          = lazy(() => import('./pages/OrderTracePage'));
const ItemCategoryMapPage     = lazy(() => import('./pages/ItemCategoryMapPage'));
const ItemCodeLookupPage      = lazy(() => import('./pages/ItemCodeLookupPage'));
const SuppliersPage           = lazy(() => import('./pages/SuppliersPage'));
const ReorderLevelPage        = lazy(() => import('./pages/ReorderLevelPage'));
const FGReorderLevelPage      = lazy(() => import('./pages/FGReorderLevelPage'));
// Production module
const ProductionPlanningPage  = lazy(() => import('./pages/ProductionPlanning'));
const AgingAnalysisPage       = lazy(() => import('./pages/AgingAnalysis'));
// Public — no auth
const SupplierQuotePage       = lazy(() => import('./pages/SupplierQuotePage'));

const PageLoader = () => (
  <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '40vh', color: 'var(--gray-500)' }}>
    Loading…
  </div>
);

/**
 * ProtectedRoute — checks the user is logged in, and (optionally) that
 * their role is in the allowed list for this route.
 *
 * - No `roles` prop  -> any authenticated user can access (existing behavior).
 * - `roles` provided -> user.role must be included, or they're redirected
 *   to the dashboard instead of silently rendering a page whose sidebar
 *   link they never saw.
 *
 * Keep this list in sync with the `roles` arrays in Layout.js's NAV_ITEMS —
 * if a role can see the link, it should be able to load the route, and
 * vice versa.
 *
 * System Viewer (read-only) may open every role-restricted route except
 * those marked `noViewer` (create-only forms and User Management). Writes
 * are blocked by the API regardless.
 */
function ProtectedRoute({ children, roles, noViewer }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="text-center mt-4">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'Viewer') {
    if (noViewer) return <Navigate to="/" replace />;
    return children;
  }
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

function AppRoutes() {
  const { user } = useAuth();
  return (
    <Routes>
      {/* Public supplier RFQ self-submit — no auth */}
      <Route path="/supplier-quote/:token" element={<Suspense fallback={<PageLoader />}><SupplierQuotePage /></Suspense>} />

      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Suspense fallback={<PageLoader />}><DashboardPage /></Suspense>} />
        <Route path="entries" element={<Suspense fallback={<PageLoader />}><GateEntryListPage /></Suspense>} />
        <Route path="entries/new" element={
          <ProtectedRoute roles={['GateSecurity', 'Admin']} noViewer>
            <Suspense fallback={<PageLoader />}><GateEntryPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="entries/edit/:entryNo" element={
          <ProtectedRoute roles={['GateSecurity', 'Admin']} noViewer>
            <Suspense fallback={<PageLoader />}><GateEntryPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="weighbridge" element={
          <ProtectedRoute roles={['Weighbridge', 'Admin']}>
            <Suspense fallback={<PageLoader />}><WeighbridgePage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="qa" element={
          <ProtectedRoute roles={['QAInspector', 'QAManager', 'FactoryQA', 'Admin']}>
            <Suspense fallback={<PageLoader />}><QAInspectionPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="ops-approval" element={
          <ProtectedRoute roles={['OpsManager', 'Supervisor', 'Director', 'Admin']}>
            <Suspense fallback={<PageLoader />}><OpsManagerApprovalPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="requisition-approval-status" element={
          <ProtectedRoute roles={['FactoryReceiving', 'StoreReceiving', 'OpsManager', 'Director', 'Admin']}>
            <Suspense fallback={<PageLoader />}><RequisitionApprovalStatusPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="central-stores/review" element={
          <ProtectedRoute roles={['StoreReceiving', 'Admin']}>
            <Suspense fallback={<PageLoader />}><CentralStoresApprovalPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="receiving" element={
          <ProtectedRoute roles={['StoreReceiving', 'FactoryReceiving', 'FactoryQA', 'Supervisor', 'ProductionClerk', 'Admin']}>
            <Suspense fallback={<PageLoader />}><ReceivingPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="grn" element={<Suspense fallback={<PageLoader />}><GRNListPage /></Suspense>} />
        <Route path="rejections" element={<Suspense fallback={<PageLoader />}><GoodsRejectionPage /></Suspense>} />
        <Route path="traceability" element={<Suspense fallback={<PageLoader />}><TraceabilityPage /></Suspense>} />
        <Route path="erp" element={
          <ProtectedRoute roles={['Admin', 'Supervisor', 'Auditor', 'QAManager', 'Procurement']}>
            <Suspense fallback={<PageLoader />}><ERPLookupPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="users" element={
          <ProtectedRoute roles={['Admin']} noViewer>
            <Suspense fallback={<PageLoader />}><UserManagementPage /></Suspense>
          </ProtectedRoute>
        } />

        {/* Procurement module */}
        <Route path="procurement/requisitions" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']}>
            <Suspense fallback={<PageLoader />}><RequisitionsPage /></Suspense>
          </ProtectedRoute>
        } />
        {/* Registered BEFORE /procurement/requisitions/:id, same reasoning as
            /bundle below — "raise" would otherwise be swallowed as an :id. */}
        <Route path="procurement/requisitions/raise" element={
          <ProtectedRoute roles={['FactoryReceiving', 'StoreReceiving', 'Admin']} noViewer>
            <Suspense fallback={<PageLoader />}><CreateRequisitionPage /></Suspense>
          </ProtectedRoute>
        } />
        {/* Registered BEFORE /procurement/requisitions/:id — "bundle" would
            otherwise be swallowed as an :id param value, same ordering
            reasoning already used on the backend for /dispatches/search
            and /matching-suppliers. */}
        <Route path="procurement/requisitions/bundle" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']} noViewer>
            <Suspense fallback={<PageLoader />}><CreateBundledRFQPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/requisitions/:id" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']}>
            <Suspense fallback={<PageLoader />}><RequisitionDetailPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/quotations" element={
          <ProtectedRoute roles={['Procurement', 'Admin']}>
            <Suspense fallback={<PageLoader />}><QuotationCapturePage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/awarded" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']}>
            <Suspense fallback={<PageLoader />}><ProcurementAwardsPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/held-items" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']}>
            <Suspense fallback={<PageLoader />}><HeldItemsPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/pending-director-approval" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']}>
            <Suspense fallback={<PageLoader />}><PendingDirectorApprovalPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/reconciliation" element={
          <ProtectedRoute roles={['Procurement', 'Admin']}>
            <Suspense fallback={<PageLoader />}><LPOReconciliationPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/lpo-raised" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director']}>
            <Suspense fallback={<PageLoader />}><BusyLPOsRaisedPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/trace" element={<Suspense fallback={<PageLoader />}><OrderTracePage /></Suspense>} />
        <Route path="procurement/trace/:id" element={<Suspense fallback={<PageLoader />}><OrderTracePage /></Suspense>} />
        <Route path="receiving/busy" element={
          <ProtectedRoute roles={['Admin', 'Supervisor', 'StoreReceiving', 'FactoryReceiving', 'Procurement', 'Director', 'OpsManager']}>
            <Suspense fallback={<PageLoader />}><BusyReceivingPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/reorder" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director', 'ProductionManager', 'OpsManager']}>
            <Suspense fallback={<PageLoader />}><ReorderLevelPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="procurement/fg-reorder" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director', 'ProductionManager', 'OpsManager']}>
            <Suspense fallback={<PageLoader />}><FGReorderLevelPage /></Suspense>
          </ProtectedRoute>
        } />

        {/* Production module */}
        <Route path="production/planning" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director', 'ProductionClerk', 'ProductionManager', 'OpsManager']}>
            <Suspense fallback={<PageLoader />}><ProductionPlanningPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="production/aging-analysis" element={
          <ProtectedRoute roles={['Procurement', 'Admin', 'Director', 'ProductionClerk', 'ProductionManager', 'OpsManager']}>
            <Suspense fallback={<PageLoader />}><AgingAnalysisPage /></Suspense>
          </ProtectedRoute>
        } />

        <Route path="director/evaluation" element={
          <ProtectedRoute roles={['Director', 'Admin', 'Procurement']}>
            <Suspense fallback={<PageLoader />}><DirectorEvaluationPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="admin/item-categories" element={
          <ProtectedRoute roles={['Admin', 'Procurement']}>
            <Suspense fallback={<PageLoader />}><ItemCategoryMapPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="admin/item-code-lookup" element={
          <ProtectedRoute roles={['Admin', 'Procurement']}>
            <Suspense fallback={<PageLoader />}><ItemCodeLookupPage /></Suspense>
          </ProtectedRoute>
        } />
        <Route path="admin/suppliers" element={
          <ProtectedRoute roles={['Admin', 'Procurement']}>
            <Suspense fallback={<PageLoader />}><SuppliersPage /></Suspense>
          </ProtectedRoute>
        } />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}