import DashboardRouter from './DashboardRouter';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Dashboard | VH Health Portal',
  description: 'Hospital management dashboard with real-time analytics and monitoring',
};

export default function DashboardPage() {
  return <DashboardRouter />;
}
