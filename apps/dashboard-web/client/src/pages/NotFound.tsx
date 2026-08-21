import React from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  const [, navigate] = useLocation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4">
      <h1 className="text-4xl font-corp-display font-semibold">404</h1>
      <p className="text-muted-foreground">Page not found.</p>
      <Button onClick={() => navigate('/')}>Go home</Button>
    </div>
  );
}
