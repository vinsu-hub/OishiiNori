import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { useAuth } from '@/contexts/AuthContext';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { ApiOishiAiChartSpec, queryOishiAi } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { ChevronRight, Loader2, Send, Sparkles, Trash2 } from 'lucide-react';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  chart: ApiOishiAiChartSpec | null;
}

const SERIES_COLORS = ['#D42A2A', '#C98A2C', '#14524B', '#6E8368', '#241726'];

const SUGGESTED_PROMPTS = [
  "What's my revenue today?",
  "What's my best seller?",
  "What's driving my losses?",
  "What's my accumulated loss overall?",
  'What needs restocking?',
  'Show revenue by day this month',
];

const WELCOME_MESSAGE: ChatMessage = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hi, I'm Oishii AI. Ask me about today's revenue, best sellers, losses, payroll, or low stock -- I'll answer from your real data, and chart it when that helps.",
  chart: null,
};

function buildChartConfig(spec: ApiOishiAiChartSpec): ChartConfig {
  const config: ChartConfig = {};
  spec.series.forEach((series, index) => {
    config[series.name] = { label: series.name, color: SERIES_COLORS[index % SERIES_COLORS.length] };
  });
  return config;
}

function buildChartData(spec: ApiOishiAiChartSpec): Record<string, number | string>[] {
  const labels: string[] = [];
  for (const series of spec.series) {
    for (const point of series.data) {
      if (!labels.includes(point.label)) labels.push(point.label);
    }
  }
  return labels.map((label) => {
    const row: Record<string, number | string> = { label };
    for (const series of spec.series) {
      row[series.name] = series.data.find((p) => p.label === label)?.value ?? 0;
    }
    return row;
  });
}

export function OishiAiChartView({ spec }: { spec: ApiOishiAiChartSpec }) {
  const config = buildChartConfig(spec);
  const data = buildChartData(spec);
  const ChartEl = spec.type === 'bar' ? BarChart : LineChart;

  return (
    <Card className="mt-3 border-l-4 border-l-primary">
      <CardHeader>
        <CardTitle className="text-base">{spec.title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="max-h-64 w-full">
          <ChartEl data={data} margin={{ left: 8, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="label" tickLine={false} axisLine={false} />
            <YAxis tickLine={false} axisLine={false} width={72} tickFormatter={(v) => formatCurrency(Number(v))} />
            <ChartTooltip content={<ChartTooltipContent formatter={(value) => formatCurrency(Number(value))} />} />
            {spec.series.map((series, index) =>
              spec.type === 'bar' ? (
                <Bar key={series.name} dataKey={series.name} fill={SERIES_COLORS[index % SERIES_COLORS.length]} radius={4} />
              ) : (
                <Line
                  key={series.name}
                  type="monotone"
                  dataKey={series.name}
                  stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                />
              )
            )}
          </ChartEl>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export default function OishiAi() {
  const { user } = useAuth();
  const storageKey = user ? `oishii-ai-chat-log-${user.id}` : null;

  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  useEffect(() => {
    if (messages.length > prevCountRef.current) {
      scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
    prevCountRef.current = messages.length;
  }, [messages]);

  useEffect(() => {
    if (!storageKey) return;
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as ChatMessage[];
        if (Array.isArray(parsed) && parsed.length > 0) setMessages(parsed);
      } catch {
        // ignore corrupt saved log, keep the default welcome message
      }
    }
    setHydrated(true);
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || !hydrated) return;
    localStorage.setItem(storageKey, JSON.stringify(messages.slice(-100)));
  }, [messages, storageKey, hydrated]);

  if (user && user.role !== 'executive') {
    return (
      <DashboardLayout title="Oishii AI">
        <div className="p-6">
          <p className="text-sm text-muted-foreground">You don't have access to this page.</p>
        </div>
      </DashboardLayout>
    );
  }

  const send = async (question: string = input) => {
    if (!question.trim() || loading) return;

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'user', content: question, chart: null }]);
    setInput('');
    setLoading(true);

    try {
      const response = await queryOishiAi(question);
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: response.answer, chart: response.chart },
      ]);
    } catch (error) {
      toast.error("Oishii AI couldn't answer that. Check your connection and try again.");
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const clearLog = () => {
    setMessages([WELCOME_MESSAGE]);
    if (storageKey) localStorage.removeItem(storageKey);
  };

  return (
    <DashboardLayout title="Oishii AI">
      <div className="p-6 h-full flex flex-col md:flex-row gap-6">
        <Card className="flex-1 flex flex-col overflow-hidden border-l-4 border-l-primary min-h-[50vh] md:min-h-0">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-primary-foreground shrink-0">
                <Sparkles className="w-4 h-4" />
              </div>
              <div>
                <CardTitle className="text-base">Chat Log</CardTitle>
                <p className="text-xs text-muted-foreground">Saved automatically -- grounded in your live data</p>
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={clearLog} title="Clear log" aria-label="Clear log">
              <Trash2 className="w-4 h-4" />
            </Button>
          </CardHeader>

          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4">
              {messages.map((message) => (
                <div key={message.id} className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={message.role === 'user' ? 'max-w-md' : 'max-w-xl w-full'}>
                    <div
                      className={`px-4 py-2 rounded-lg text-sm ${
                        message.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground'
                      }`}
                    >
                      {message.content}
                    </div>
                    {message.chart && <OishiAiChartView spec={message.chart} />}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-secondary px-4 py-2 rounded-lg flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Thinking...
                  </div>
                </div>
              )}
            </div>
            <div ref={scrollAnchorRef} />
          </ScrollArea>
        </Card>

        <Card className="w-full md:w-80 shrink-0 flex flex-col">
          <CardHeader className="border-b">
            <CardTitle className="text-base">Ask Oishii AI</CardTitle>
            <p className="text-xs text-muted-foreground">Type a question or pick one below</p>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-4 pt-4">
            <div className="space-y-2">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  size="sm"
                  className="w-full justify-start text-xs h-auto py-2 px-3 text-left"
                  onClick={() => send(prompt)}
                  disabled={loading}
                >
                  <ChevronRight className="w-3 h-3 mr-2 shrink-0" />
                  {prompt}
                </Button>
              ))}
            </div>

            <div className="mt-auto flex gap-2">
              <Input
                placeholder="Ask a question..."
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !loading) send();
                }}
                disabled={loading}
                className="text-sm"
              />
              <Button onClick={() => send()} disabled={loading || !input.trim()} size="icon">
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
