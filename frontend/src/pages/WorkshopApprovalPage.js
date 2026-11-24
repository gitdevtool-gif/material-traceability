import React from 'react';
import { useAuth } from '../context/AuthContext';
import { RequisitionApprovalTab } from './OpsManagerApprovalPage';

/**
 * Workshop HOD approval — Workshop requisitions wait here (per item:
 * approve / reject / hold) before Procurement can see them. Same screen and
 * flow as the Ops Manager's "Requisition Approval" tab; the server only
 * lists, and only lets this role decide, requisitions on Mat Centre "Workshop".
 */
export default function WorkshopApprovalPage() {
  const { user } = useAuth();
  return (
    <div>
      <div className="page-header"><h1>Workshop Approval</h1></div>
      <RequisitionApprovalTab user={user} approverLabel="Workshop HOD" gate="workshop" />
    </div>
  );
}
