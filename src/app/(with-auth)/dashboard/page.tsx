import { Metadata } from 'next';

import CleanDashboard from './CleanDashboard';

export const metadata: Metadata = {
  title: 'Dashboard | VH Admin Portal',
  description: 'Hospital management dashboard with real-time analytics and monitoring',
};

export default function DashboardPage() {
  return <CleanDashboard />;
}
