// src/app/dashboard/admin-management/edit-permissions/[id]/page.tsx
'use client'; // This page needs client-side interaction for the form

import { updatePermissionsAction } from '@/app/dashboard/admin-management/actions';
import { AdminUser } from '@/lib/types';
import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';

const ALL_PERMISSIONS = [
    "adminManagement", "userManagement", "doctorManagement", "departmentManagement", 
    "appointmentManagement", "pharmacyAdminRoutes", "notificationManagement", "viewAuditLogs"
];

const initialState = { message: '', success: false };

function SubmitButton() {
    const { pending } = useFormStatus();
    return <button type="submit" disabled={pending}>{pending ? "Saving..." : "Save Permissions"}</button>
}

// This is a placeholder. In a real app, you'd fetch this admin's data.
const mockAdmin: AdminUser = {
    id: 1, name: "Super Admin", email: "super@vhhealth.app", role: "SUPER_ADMIN",
    permissions: ["adminManagement", "userManagement"], last_login: new Date().toISOString(), is_active: true
};

// BETTER SOLUTION - Actually use the params.id:
export default function EditPermissionsPage({ params }: { params: { id: string } }) {
    const [state, formAction] = useFormState(updatePermissionsAction, initialState);
    
    // Use the id from params
    const adminId = params.id;
    console.log(`Editing permissions for admin ${adminId}`);
    
    // In a real app, you would fetch the admin user based on params.id
    const admin = mockAdmin;

    return (
        <div>
            <h2 className="text-2xl font-bold mb-4">Edit Permissions for {admin.name}</h2>
            <form action={formAction} className="p-6 bg-white rounded-lg shadow">
                <input type="hidden" name="adminId" value={admin.id} />
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {ALL_PERMISSIONS.map(permission => (
                        <div key={permission} className="flex items-center">
                            <input
                                type="checkbox"
                                id={permission}
                                name="permissions"
                                value={permission}
                                defaultChecked={admin.permissions.includes(permission)}
                                className="h-4 w-4 rounded border-gray-300"
                            />
                            <label htmlFor={permission} className="ml-2 block text-sm text-gray-900">
                                {permission}
                            </label>
                        </div>
                    ))}
                </div>
                <div className="mt-6 flex items-center gap-4">
                    <SubmitButton />
                    <Link href="/dashboard/admin-management">Cancel</Link>
                </div>
                {state?.message && <p className="mt-2">{state.message}</p>}
            </form>
        </div>
    );
}