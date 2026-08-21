import React from 'react';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface PlaceholderPageProps {
  title: string;
  milestone: string;
}

export function PlaceholderPage({ title, milestone }: PlaceholderPageProps) {
  return (
    <DashboardLayout title={title}>
      <div className="p-6">
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle className="font-corp-display">{title}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Coming in {milestone}. The nav route, auth guard, and layout shell are wired up now --
              this page's real functionality is built in a later checkpoint per the build plan.
            </p>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
