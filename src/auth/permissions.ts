// src/auth/permissions.ts
//
// The ONE place that decides what each role may do. The API enforces these on every route,
// and the dashboard receives the list from /auth/me, so changing a role's abilities is a
// one-line edit here (no dashboard change needed).

export type Role = 'SUPER_ADMIN' | 'ADMIN_MANAGER' | 'OFFICER';

export type Permission =
  | 'reports:view'          // list reports and read their details
  | 'reports:update_status' // change a report's status and add notes
  | 'evidence:view'         // open photos, videos and documents (super admin only)
  | 'informant:view'        // reveal the informant's contact details (always audited)
  | 'audit:view'            // read the activity log
  | 'admins:manage';        // create / reset / remove OFFICER accounts

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Unit directors: oversight. They read reports and evidence and the activity log,
  // but they don't change statuses and they don't manage accounts.
  SUPER_ADMIN: ['reports:view', 'evidence:view', 'informant:view', 'audit:view'],

  // Creates and removes officer accounts. Works reports (status updates) but never sees evidence.
  ADMIN_MANAGER: ['reports:view', 'reports:update_status', 'informant:view', 'admins:manage'],

  // Works reports: reads them and moves them through the statuses. No evidence, no admin tools.
  OFFICER: ['reports:view', 'reports:update_status', 'informant:view'],
};

export function permissionsFor(role: string): Permission[] {
  return [...(ROLE_PERMISSIONS[role as Role] ?? [])];
}