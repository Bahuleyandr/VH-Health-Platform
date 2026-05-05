# UI Table And List Consistency Audit

Updated: 2026-05-05

## Standard

Primary desktop admin management tables should provide:

- Search across the fields visible in the row.
- Sortable headers for the fields users naturally compare.
- Page-size control with 10, 50, and 100 row options, unless the backend route already owns a different operational page size.
- Pagination that stays on the current route and preserves active filters.
- Horizontal scrolling with a stable minimum table width on narrow windows.
- Clear empty, loading, and error states.

Mobile patient and staff app list screens should not copy desktop table controls. They should provide:

- Search and filters for long lists.
- Pull-to-refresh or an explicit refresh affordance where data changes frequently.
- Empty, loading, and error states.
- Tap targets that remain usable on small screens.

## Updated In This Pass

- Admin Doctors: search now covers name, email, phone, department, and speciality; table keeps its sortable headers, rows-per-page, pagination, and wide layout.
- Admin Users: existing search, role filter, sortable headers, rows-per-page, pagination, and edit modal preserved; shared pagination now works on whichever route uses it.
- Admin Appointments: primary appointment workflow table now preserves page size, route-correct pagination, sortable headers, and the correct appointment label.
- Admin legacy Appointments table: search, sortable headers, rows-per-page, pagination, empty state, and wide layout added.
- Admin Administrators: search, sortable headers, rows-per-page, pagination, empty state, and wide layout added.
- Admin Permission Grid: admin/role/permission search, admin-name sort, rows-per-page, pagination, and horizontal resilience added.
- Admin Departments: search, sortable headers, rows-per-page, pagination, empty state, and wide layout added.
- Admin Notifications: search, sortable headers, rows-per-page, pagination, empty state, and wide layout added.
- Admin System Logs and Audit Logs: server-owned filtering/pagination preserved; page-size control and wide table layout added.

## Already Treated Differently By Design

- Clinical AI module tables are task panels and review workbenches, not one uniform management list. When a panel becomes a daily operational queue, it should adopt the table standard above.
- Billing, pharmacy, investigations, attendance, payroll, compliance, and housekeeping have several domain-specific grids with filters or tabs already embedded in their workflows. Each should be migrated to the standard when the route is promoted to a primary management screen.
- Patient and staff Flutter screens are card/list-first experiences. Use search/filter/refresh/empty-state consistency there instead of desktop rows-per-page controls.

## Follow-Up Backlog

- Create shared admin table primitives for server-side query state so Users, Doctors, Appointments, and Logs do not each maintain their own small pagination implementation.
- Add a lint or Storybook-style visual checklist for new admin tables: search present, sort present where applicable, page-size present, no narrow-window clipping.
- Sweep high-use domain tables next: pharmacy orders/catalog, investigations bookings/catalog, attendance pages, billing invoices/claims, and clinical AI review queues.
- Add mobile list UX audit for patient and staff after the current admin desktop consistency pass lands.
