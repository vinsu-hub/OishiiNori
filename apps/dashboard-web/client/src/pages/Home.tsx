import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Home() {
  const { user } = useAuth();

  return (
    <DashboardLayout title="Home">
      <div className="p-6">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="font-corp-display">Welcome, {user?.name}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Use the sidebar to get to POS Terminal, Order Queue, Kitchen Display, Inventory, and
              (for managers/executives) HR &amp; Payroll.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
