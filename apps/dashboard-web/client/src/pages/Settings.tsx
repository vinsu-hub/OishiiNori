import React from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function Settings() {
  const { user, logout } = useAuth();

  return (
    <DashboardLayout title="Settings">
      <div className="p-6 space-y-4">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="font-corp-display">Account</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm">
              <span className="text-muted-foreground">Name:</span> {user?.name}
            </p>
            <p className="text-sm">
              <span className="text-muted-foreground">Email:</span> {user?.email}
            </p>
            <p className="text-sm capitalize">
              <span className="text-muted-foreground">Role:</span> {user?.role}
            </p>
            <Button variant="destructive" onClick={logout} className="mt-2">
              Log out
            </Button>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
