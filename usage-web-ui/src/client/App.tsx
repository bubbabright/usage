import React, { useEffect, useState, useMemo } from 'react';
import { 
  Activity, Bell, Server, Settings, History, TrendingUp, TrendingDown, AlertCircle, RefreshCw, Power, RotateCw, Play,
  Bot, Brain, Cloud, Terminal, Wrench, Globe, Zap, Mic, Scan, Database, Cpu, HardDrive, Network, Shield, Key, Link, ExternalLink,
  Clock, Calendar, ChevronLeft, ChevronRight
} from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts';
import { format, formatDistanceToNow } from 'date-fns';
import { ProviderSettingsModal } from './SettingsView';
import { GlobalSettingsModal } from './GlobalSettingsModal';

import claudeLogo from './assets/providers/claude.svg?raw';
import grokLogo from './assets/providers/grok.svg?raw';
import mistralLogo from './assets/providers/mistral.svg?raw';
import ollamaLogo from './assets/providers/ollama.svg?raw';
import cloudflareLogo from './assets/providers/cloudflare.svg?raw';
import groqLogo from './assets/providers/groq.svg?raw';
import firecrawlLogo from './assets/providers/firecrawl.svg?raw';
import opencodeGoLogo from './assets/providers/opencode-go.svg?raw';

const SCOPE_LABEL: Record<string, string> = { poll: 'Since last poll', '12h': 'Last 12h', '24h': 'Last 24h' };

// Provider -> brand logo mapping (currentColor SVGs, rendered inline so they inherit the same
// className tint as the lucide fallback below -- an <img src> wouldn't pick up currentColor).
const PROVIDER_LOGOS: Record<string, string> = {
  claude: claudeLogo,
  grok: grokLogo,
  mistral: mistralLogo,
  ollama: ollamaLogo,
  cloudflare: cloudflareLogo,
  groq: groqLogo,
  firecrawl: firecrawlLogo,
  'opencode-go': opencodeGoLogo,
};

// Provider -> icon mapping for visual identification (fallback for providers with no brand logo above)
export function ProviderIcon({ provider, className = '', size = 16 }: { provider: string; className?: string; size?: number }) {
  const logo = PROVIDER_LOGOS[provider];
  if (logo) {
    const sized = logo.replace(/width="[^"]*"/, `width="${size}"`).replace(/height="[^"]*"/, `height="${size}"`);
    return (
      <span
        className={className}
        style={{ display: 'inline-flex', lineHeight: 0 }}
        dangerouslySetInnerHTML={{ __html: sized }}
      />
    );
  }
  const icons: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    ollama: Server,
    claude: Bot,
    grok: Brain,
    mistral: Bot,
    'opencode-go': Terminal,
    openrouter: Globe,
    cloudflare: Cloud,
    deepgram: Mic,
    groq: Zap,
    firecrawl: Scan,
  };
  const Icon = icons[provider] || icons[provider.split('-')[0]] || Server;
  return <Icon size={size} className={className} />;
}

// Window type -> icon mapping
function WindowIcon({ window }: { window: any }) {
  const id = window.id?.toLowerCase() || '';
  const label = window.label?.toLowerCase() || '';
  const unit = window.unit?.toLowerCase() || '';
  
  if (id.includes('token') || label.includes('token') || unit.includes('token')) return <Database size={14} className="text-neutral-400" />;
  if (id.includes('request') || label.includes('request')) return <Cpu size={14} className="text-neutral-400" />;
  if (id.includes('cost') || label.includes('cost') || unit.includes('$')) return <Zap size={14} className="text-neutral-400" />;
  if (id.includes('minute') || label.includes('minute') || unit.includes('min')) return <Clock size={14} className="text-neutral-400" />;
  if (id.includes('day') || label.includes('daily')) return <Calendar size={14} className="text-neutral-400" />;
  if (id.includes('month') || label.includes('monthly')) return <Calendar size={14} className="text-neutral-400" />;
  if (id.includes('week') || label.includes('weekly')) return <Calendar size={14} className="text-neutral-400" />;
  if (id.includes('session') || label.includes('session')) return <Activity size={14} className="text-neutral-400" />;
  if (id.includes('vibe') || label.includes('vibe')) return <Brain size={14} className="text-neutral-400" />;
  if (id.includes('primary') || label.includes('primary')) return <Server size={14} className="text-neutral-400" />;
  return <Database size={14} className="text-neutral-400" />;
}

// Pinned bar across every page — surfaces the single biggest %-point mover
// per time scope (poll/12h/24h) across ALL providers, so a big jump doesn't
// go unnoticed just because you're looking at a different provider's tab.
function HeadlineBar({ onJump, hidden, showDepletion }: { onJump: (provider: string) => void; hidden: Set<string>; showDepletion: boolean }) {
  const [headline, setHeadline] = useState<Record<string, any>>({});

  useEffect(() => {
    const fetchHeadline = async () => {
      try {
        const res = await fetch('/usage/headline');
        if (res.ok) setHeadline(await res.json());
      } catch (err) {
        console.error(err);
      }
    };
    fetchHeadline();
    const interval = setInterval(fetchHeadline, 30000);
    return () => clearInterval(interval);
  }, []);

  // Drop movers for providers the user hid — the daemon still ranks them, we
  // just don't surface them here.
  const entries = Object.entries(headline).filter(
    ([scope, mover]) => mover && !hidden.has(mover.provider) && (showDepletion || scope !== 'depleting'),
  );
  if (!entries.length) return null;

  return (
    <div className="w-full bg-neutral-900 border-b border-neutral-800 px-4 py-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs shrink-0">
      {entries.map(([scope, mover]) =>
        scope === 'depleting' ? (
          <button
            key={scope}
            onClick={() => onJump(mover.provider)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title={`${mover.provider_label} · ${mover.window_label}: ${mover.pct.toFixed(1)}% used, resets ${mover.resets_at ? formatDistanceToNow(new Date(mover.resets_at), { addSuffix: true }) : 'unknown'}`}
          >
            <span className="text-red-400 uppercase tracking-wider font-semibold">Depleting soon</span>
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <span className="text-neutral-200 font-medium">
              {mover.provider_label} {mover.window_label}
            </span>
            <span className="text-red-400">
              runs out {formatDistanceToNow(Date.now() + mover.eta_ms, { addSuffix: true })}
            </span>
          </button>
        ) : (
          <button
            key={scope}
            onClick={() => onJump(mover.provider)}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
            title={`${mover.provider_label} · ${mover.window_label}: ${mover.from_pct.toFixed(1)}% → ${mover.to_pct.toFixed(1)}%`}
          >
            <span className="text-neutral-400 uppercase tracking-wider font-semibold">{SCOPE_LABEL[scope] || scope}</span>
            {mover.delta >= 0 ? (
              <TrendingUp size={14} className="text-red-400 shrink-0" />
            ) : (
              <TrendingDown size={14} className="text-emerald-400 shrink-0" />
            )}
            <span className="text-neutral-200 font-medium">
              {mover.provider_label} {mover.window_label}
            </span>
            <span className={mover.delta >= 0 ? 'text-red-400' : 'text-emerald-400'}>
              {mover.delta >= 0 ? '+' : ''}{mover.delta.toFixed(1)}pt
            </span>
          </button>
        )
      )}
    </div>
  );
}

// Landing board (no provider selected): every provider at a glance — most
// recently refreshed first ("new refreshes") plus its live window usage
// ("what is in use"). Feeds off the /usage/providers list, which now carries a
// trimmed windows summary, so no per-provider fetch. Click a card to drill in.
// One card holding every provider the daemon tags `category: 'support'`
// (deepgram, firecrawl, serpapi today). They stay separate providers — own
// polling, own history, own detail page — they just don't each deserve a full
// plan card on the overview. They're metered APIs backing the work rather than
// the AI capacity you ration hour to hour.
//
// Rows are compact by design: a name, the number, and a bar ONLY when there's a
// cap to be a fraction of. A prepaid balance like deepgram's $197.73 has no
// ceiling, so a bar there would be decoration pretending to be information.
function SupportServicesCard({ providers, onJump }: { providers: any[]; onJump: (p: string) => void }) {
  if (!providers.length) return null;

  const valueText = (w: any) => {
    if (w?.unit && typeof w.used === 'number') {
      const n = w.used.toLocaleString(undefined, { maximumFractionDigits: 2 });
      return w.unit.toLowerCase() === 'usd' ? `$${n}` : `${n} ${w.unit}`;
    }
    return typeof w?.pct === 'number' ? `${w.pct.toFixed(1)}%` : '—';
  };

  return (
    <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Wrench size={16} className="text-neutral-400" />
        <h3 className="font-medium text-neutral-100">Support Services</h3>
        <span className="text-xs text-neutral-500">metered APIs</span>
      </div>

      <div className="flex flex-col divide-y divide-neutral-800">
        {providers.map((p) => {
          const w = p.windows?.[0];
          const hasBar = typeof w?.pct === 'number' && typeof w?.cap === 'number';
          return (
            <button
              key={p.provider}
              onClick={() => onJump(p.provider)}
              className="text-left py-2.5 first:pt-0 last:pb-0 hover:opacity-80 transition-opacity"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      p.status === 'ok' && !p.stale ? 'bg-emerald-500' : p.status === 'ok' ? 'bg-amber-500' : 'bg-red-500'
                    }`}
                  />
                  <ProviderIcon provider={p.provider} size={14} className="text-neutral-400 shrink-0" />
                  <span className="capitalize text-sm text-neutral-300 truncate">{p.provider}</span>
                </div>
                <span className="text-sm font-medium text-neutral-100 shrink-0 tabular-nums">
                  {p.status === 'ok' ? valueText(w) : p.status}
                </span>
              </div>

              {hasBar && (
                <div className="h-1 w-full bg-neutral-800 rounded-full overflow-hidden mt-1.5">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, w.pct)}%`, backgroundColor: w.color || '#6b7280' }}
                  />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// V3 Overview redesign — kept as a sibling of OverviewBoard (not an in-place
// edit) so V2 stays pixel-identical and selectable via the header toggle
// while this is being dogfooded. See PLAN-overview-v3 in the repo for the
// full rationale (raw-number-vs-pct fix, activity bar, reset countdown,
// content-driven grid, per-card depleting badge instead of a global bar).

// For a capacity-style resource (unit + used present — Cloudflare neurons,
// Firecrawl credits), the number that's actually useful at a glance is what's
// LEFT, not what's consumed — a plain "%" reads as "how full" when what you
// want to know is "how much runway." `used_is_remaining` (set by a provider
// whose own `used` field already holds a remaining balance, e.g. Firecrawl)
// distinguishes that from the more common `used` = "consumed against cap"
// (e.g. Cloudflare), since the two need opposite math to get to "remaining."
// Everything (raw count AND %) stays visible — nothing hidden, just reframed
// around what's left instead of what's gone.
function primaryMetric(w: any): { primary: string; secondary: string | null; label: string } {
  const label = w.label || w.id;
  const hasCapacity = w.unit && typeof w.used === 'number';

  if (!hasCapacity) {
    const primary = typeof w.pct === 'number' ? `${w.pct.toFixed(1)}%` : '—';
    return { primary, secondary: null, label };
  }

  const remainingCount = w.used_is_remaining
    ? w.used
    : typeof w.cap === 'number' ? Math.max(0, w.cap - w.used) : null;

  // % is already the bar's job (see ActivityBar below) — the primary number
  // is just the raw count so the two aren't saying the same thing twice.
  const countStr = remainingCount != null
    ? remainingCount.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : null;
  const remainingPct = typeof w.pct === 'number' ? Math.max(0, 100 - w.pct) : null;
  const pctStr = remainingPct != null ? `${remainingPct.toFixed(1)}%` : null;

  // Unit dropped from the primary number — the row label + secondary line
  // already say what it's counting, repeating "credits"/"neurons" here was
  // noise on the number that matters most at a glance.
  const primary = countStr != null
    ? `${countStr} left`
    : pctStr != null ? `${pctStr} left` : '—';

  const usedStr = w.used.toLocaleString(undefined, { maximumFractionDigits: 2 });
  let secondary: string | null = null;
  if (w.id === 'credits' && w.unit === 'credits' && typeof w.cycles_remaining === 'number') {
    secondary = `${w.cycles_remaining} cycle${w.cycles_remaining === 1 ? '' : 's'} banked`;
  } else if (typeof w.cap === 'number') {
    secondary = `${usedStr} / ${w.cap.toLocaleString()} ${w.unit} used`;
  } else {
    secondary = `${usedStr} ${w.unit} used`;
  }
  return { primary, secondary, label };
}

// Delta color for the activity sliver below — RED everywhere, regardless of
// the provider's own bar color, so scanning down the whole board for "what's
// actively being used right now" is just "look for red."
const ACTIVITY_DELTA_COLOR = '#ef4444';

// Two-tone activity bar — always fills in the consumed direction (matches
// how Cloudflare/Firecrawl's own dashboards read a usage gauge: fuller =
// closer to the limit), independent of whatever the primary number next to
// it says ("323 left" vs "61.0%" — the bar answers "how close to the wall,"
// the number answers whatever's most useful to know). Solid (provider color)
// = where we were an hour ago (or since the window's last reset — see
// runner.js's findActivityBase); the red segment on top of that = what's
// happened since — this hour's real activity, in one consistent color across
// every card. Falls back to a flat single-tone bar when there's no history
// yet at all (brand new provider).
function ActivityBar({ pct, pct1hAgo, color }: { pct: number | null; pct1hAgo: number | null; color: string }) {
  const clamp = (n: number) => Math.min(Math.max(n, 0), 100);
  const cur = clamp(pct || 0);
  const fill = color || '#10b981';
  if (typeof pct1hAgo === 'number') {
    const solid = Math.min(clamp(pct1hAgo), cur); // where we were 1h ago (or since reset)
    return (
      <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden relative">
        <div className="h-full absolute inset-y-0 left-0" style={{ width: `${solid}%`, backgroundColor: fill }} />
        {cur > solid && (
          <div className="h-full absolute inset-y-0" style={{ left: `${solid}%`, width: `${cur - solid}%`, backgroundColor: ACTIVITY_DELTA_COLOR }} />
        )}
      </div>
    );
  }
  return (
    <div className="h-1.5 w-full bg-neutral-800 rounded-full overflow-hidden">
      <div className="h-full" style={{ width: `${cur}%`, backgroundColor: fill }} />
    </div>
  );
}

// Reset-countdown formatter — deliberately separate from fmtUptime (which
// DaemonPanel uses for "up Xh Ym" and always shows two units). This one's
// granularity is driven purely by how far off the target is, not by the
// window's own scale (5h vs monthly): >=1 day out shows just the day count,
// 1h-1d shows hours+minutes, and under an hour switches to a live-ticking
// mm:ss so the final stretch actually reads as a countdown.
function fmtCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  if (d >= 1) return `${d}d`;
  const h = Math.floor(totalSec / 3600);
  if (h >= 1) {
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Must match App()'s setInterval(fetchProviders, 30000) — this is purely a
// display of that same client-side refetch cycle, not a second timer.
const BOARD_REFRESH_S = 30;

function OverviewBoardV3({ providers, onJump, showDepletion, fetchedAt }: { providers: any[]; onJump: (p: string) => void; showDepletion: boolean; fetchedAt: number | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!providers.length) {
    return <div className="flex items-center justify-center h-full text-neutral-400">No providers configured</div>;
  }

  // Support-service providers collapse into a single shared card instead of
  // taking a full grid cell each (daemon tags them category: 'support').
  const support = providers.filter((p) => p.category === 'support');
  const plans = providers.filter((p) => p.category !== 'support');
  const sorted = [...plans].sort((a, b) => a.provider.localeCompare(b.provider));

  // Usage-window reset countdown, not the daemon's poll-interval countdown
  // (that was V2's "next refresh in Xs" — irrelevant to the user, since it's
  // about when the daemon will next hit the provider's API, not when the
  // usage window itself resets). Null resets_at (openrouter/deepgram always,
  // firecrawl mid-rollover) means there's genuinely no clock to show — omit
  // rather than inventing placeholder text.
  //
  // Granularity matches how far off the reset actually is, not the window's
  // label — a 5h window and a monthly window both fall through the same
  // rule as they count down: >=1 day out shows just the day count (nobody
  // needs "6d 3h" this far out), 1h-1d shows hours+minutes, and under an
  // hour switches to a live mm:ss countdown so the last stretch actually
  // feels like it's ticking.
  const resetText = (w: any) => {
    if (!w.resets_at) return null;
    const ms = new Date(w.resets_at).getTime() - Date.now();
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return fmtCountdown(ms); // clock icon at the render site carries the "resets in" meaning
  };

  // One indicator for the whole board instead of a "1 minute ago" on every
  // card (they were all saying the same thing, and a plain wall clock here
  // was just duplicating the OS's own clock). This is more useful: a
  // countdown to when the board's own data actually refreshes next — ticks
  // off the same 1s interval already driving the reset countdowns above.
  const secondsSinceFetch = fetchedAt != null ? Math.floor((Date.now() - fetchedAt) / 1000) : null;
  const nextRefreshS = secondsSinceFetch != null ? Math.max(0, BOARD_REFRESH_S - secondsSinceFetch) : null;

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2">
          <Activity size={18} className="text-emerald-400" />
          <h2 className="text-lg font-semibold text-neutral-100">Overview</h2>
          <span className="text-xs text-neutral-400">current usage &amp; activity in the last hour</span>
        </div>
        <span title="Time until this board's data refreshes" className="flex items-center gap-1.5 text-xs text-neutral-400">
          <RefreshCw size={13} className="text-neutral-500" />
          {nextRefreshS != null ? `next refresh in ${nextRefreshS}s` : '—'}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(360px,1fr))] gap-4">
        {/* Support services share one grid cell rather than taking one each. */}
        <SupportServicesCard providers={support} onJump={onJump} />
        {sorted.map((p) => (
          <button
            key={p.provider}
            onClick={() => onJump(p.provider)}
            className="text-left bg-neutral-900 border border-neutral-800 rounded-xl p-5 hover:border-neutral-700 transition-colors"
          >
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2 h-2 rounded-full shrink-0 ${p.status === 'ok' && !p.stale ? 'bg-emerald-500' : p.status === 'ok' ? 'bg-amber-500' : 'bg-red-500'}`} />
              <ProviderIcon provider={p.provider} size={18} className="text-emerald-400" />
              <span className="capitalize font-medium text-neutral-100">{p.provider}</span>
            </div>
            {p.status !== 'ok' && (
              <div className="text-xs text-red-400 mb-2">{p.status}{p.stale ? ' (stale)' : ''}</div>
            )}
            {p.windows?.length ? (
              <div className="flex flex-col gap-3">
                {p.windows.map((w: any) => {
                  const { primary, secondary, label } = primaryMetric(w);
                  const reset = resetText(w);
                  const depleting = showDepletion && w.will_deplete;
                  return (
                    <div key={w.id}>
                      <div className="flex items-center justify-between text-xs mb-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <WindowIcon window={w} />
                          {/* Fixed-width label so "resets in" starts at the same
                              x position on every row (and every card) — reads
                              as one aligned column instead of drifting with
                              each label's length. */}
                          <span className="text-neutral-400 w-24 shrink-0 truncate">{label}</span>
                          {reset && (
                            <span title={`resets in ${reset}`} className="flex items-center gap-1 text-[11px] font-medium text-neutral-300 shrink-0">
                              <Clock size={10} className="text-neutral-500" />
                              {reset}
                            </span>
                          )}
                          {depleting && (
                            <span title="Projected to run out before it resets" className="flex items-center shrink-0">
                              <AlertCircle size={12} className="text-red-400" />
                            </span>
                          )}
                        </div>
                        <span className={`shrink-0 ${depleting ? 'text-red-400 font-medium' : 'text-neutral-200'}`}>{primary}</span>
                      </div>
                      {/* Bar always fills in the consumed direction (matches
                          Cloudflare/Firecrawl's own dashboards, and reads as
                          a standard gauge — fuller = closer to the limit)
                          even though the primary NUMBER next to it says
                          "left" — those are two different, both-correct
                          views of the same pct: text answers "how much do I
                          have," bar answers "how close am I to the wall." */}
                      <ActivityBar pct={w.pct} pct1hAgo={w.pct_1h_ago} color={w.color} />
                      {secondary && (
                        <div className="text-[11px] text-neutral-400 mt-1">{secondary}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-neutral-400">no data yet</div>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function fmtUptime(s: number) {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Daemon status + lifecycle controls. Talks only over /usage/health and
// /usage/admin/* — no coupling to daemon internals. Buttons appear only when the
// daemon reports control is enabled (config [control] allow_control). The daemon
// runs under the `usage-daemon` --user systemd unit (Restart=always), so a stop
// self-heals in ~5s and restart respawns directly. "Start" can't be served by a
// stopped daemon, so it surfaces the systemctl command instead.
function DaemonPanel() {
  const [health, setHealth] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/usage/health');
      if (r.ok) { setHealth(await r.json()); return; }
    } catch { /* unreachable */ }
    setHealth(null);
  };
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, []);

  const down = !health;
  const control = health?.control ?? {};

  const act = async (action: string) => {
    if (action === 'start') {
      setNote('run: systemctl --user start usage-daemon');
      return;
    }
    setBusy(action); setNote(null);
    try {
      const r = await fetch(`/usage/admin/${action}`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (action === 'restart') {
        setNote('restarting…');
        for (let i = 0; i < 20; i++) {
          await new Promise((res) => setTimeout(res, 1000));
          try { const h = await fetch('/usage/health'); if (h.ok) { setHealth(await h.json()); setNote('back up'); return; } } catch { /* still down */ }
        }
        setNote('did not come back — check: journalctl --user -u usage-daemon -n 50');
      } else if (action === 'stop') {
        setNote('stopping…');
        setTimeout(load, 1500);
      } else if (!r.ok) {
        setNote(body.hint || body.error || 'unavailable');
      }
    } catch {
      setNote('request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-3 md:px-4 py-3 text-xs border-t border-neutral-800">
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2 h-2 rounded-full ${down ? 'bg-red-500' : 'bg-emerald-500'}`} />
        <span className="font-medium text-neutral-300">Daemon</span>
        {health && <span className="text-neutral-400">v{health.version}</span>}
      </div>
      {down ? (
        <div className="text-red-400 mb-2">unreachable — start via <code className="text-neutral-300">systemctl --user start usage-daemon</code></div>
      ) : (
        <div className="text-neutral-400 mb-2">
          up {fmtUptime(health.uptime_s)} · {health.providers.ok} ok / {health.providers.stale} stale / {health.providers.down} down
          {health.under_systemd ? '' : ' · not supervised'}
        </div>
      )}
      <div className="flex gap-1">
        <button disabled={down || !control.restart || !!busy} onClick={() => act('restart')} title="Restart daemon"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 transition-colors">
          <RotateCw size={12} className={busy === 'restart' ? 'animate-spin' : ''} /> Restart
        </button>
        <button disabled={down || !control.stop || !!busy} onClick={() => act('stop')} title="Stop daemon"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-red-800/70 disabled:opacity-40 transition-colors">
          <Power size={12} /> Stop
        </button>
        <button disabled={!!busy} onClick={() => act('start')} title="Start (shows the systemctl command to run)"
          className="flex items-center gap-1 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 disabled:opacity-40 transition-colors">
          <Play size={12} /> Start
        </button>
      </div>
      {note && <div className="mt-1.5 text-neutral-400 break-words">{note}</div>}
    </div>
  );
}

export function App() {
  const [providers, setProviders] = useState<any[]>([]);
  const [providersFetchedAt, setProvidersFetchedAt] = useState<number | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [settingsProvider, setSettingsProvider] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Additional data for selected provider
  const [config, setConfig] = useState<any>(null);
  const [current, setCurrent] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);

  // Client-side visibility: hide a provider from the UI (sidebar, overview,
  // headline) WITHOUT touching the daemon — it keeps polling & recording. Just
  // a display preference, persisted in localStorage so it survives reloads.
  const [hidden, setHidden] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('hiddenProviders') || '[]'));
    } catch {
      return new Set();
    }
  });
  const toggleHidden = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      localStorage.setItem('hiddenProviders', JSON.stringify([...next]));
      return next;
    });
  const visibleProviders = providers.filter((p) => !hidden.has(p.provider));

  // App-wide UI toggles (currently just depletion info), persisted as one
  // JSON blob so future settings don't each need their own localStorage key.
  const [globalSettings, setGlobalSettings] = useState<{ showDepletion: boolean }>(() => {
    try {
      return { showDepletion: false, ...JSON.parse(localStorage.getItem('globalSettings') || '{}') };
    } catch {
      return { showDepletion: false };
    }
  });
  const updateGlobalSettings = (next: { showDepletion: boolean }) => {
    setGlobalSettings(next);
    localStorage.setItem('globalSettings', JSON.stringify(next));
  };
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);

  // Sidebar collapse (desktop only — the mobile layout is already a
  // horizontal top nav, collapsing it wouldn't make sense there). Persisted
  // so it survives reloads.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleSidebar = () =>
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('sidebarCollapsed', next ? '1' : '0'); } catch {}
      return next;
    });

  // Overview page redesign (V3) lives side-by-side with the current layout
  // (V2) rather than replacing it, so the two can be A/B'd. Defaults to V2 —
  // nothing changes for existing usage until explicitly switched — and
  // persists across reloads.

  // Keyboard nav: Up/Down (or j/k) walk [Overview, ...visible providers].
  // Ignored while typing in a form field or with the settings modal open.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || settingsProvider) return;
      const down = e.key === 'ArrowDown' || e.key === 'j';
      const up = e.key === 'ArrowUp' || e.key === 'k';
      if (!down && !up) return;
      e.preventDefault();
      const order: (string | null)[] = [null, ...visibleProviders.map((p) => p.provider)];
      const i = order.indexOf(selectedProvider);
      const next = down ? Math.min(order.length - 1, (i < 0 ? -1 : i) + 1) : Math.max(0, (i < 0 ? 1 : i) - 1);
      setSelectedProvider(order[next]);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [visibleProviders, selectedProvider, settingsProvider]);

  const fetchProviders = async () => {
    try {
      const res = await fetch('/usage/providers');
      if (!res.ok) throw new Error('Failed to fetch providers');
      const data = await res.json();
      setProviders(data);
      setProvidersFetchedAt(Date.now());
      // No auto-select: selectedProvider stays null on load so the landing view
      // is the cross-provider Overview board (recent refreshes + current usage).
      // The user drills into a provider by clicking; the "Overview" nav item and
      // the header title both return here (setSelectedProvider(null)).
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
    const interval = setInterval(fetchProviders, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchProviderDetails = async (id: string) => {
    try {
      const [confRes, curRes, histRes] = await Promise.all([
        fetch(`/usage/${id}/config`),
        fetch(`/usage/${id}/current`),
        fetch(`/usage/${id}/history`)
      ]);
      if (confRes.ok) setConfig(await confRes.json());
      if (curRes.ok) setCurrent(await curRes.json());
      if (histRes.ok) setHistory(await histRes.json());
    } catch (err: any) {
      console.error(err);
    }
  };

  useEffect(() => {
    if (!selectedProvider) return;
    fetchProviderDetails(selectedProvider);
    const interval = setInterval(() => fetchProviderDetails(selectedProvider), 30000);
    return () => clearInterval(interval);
  }, [selectedProvider]);

  const refreshCurrent = async () => {
    if (!selectedProvider) return;
    try {
      const res = await fetch(`/usage/${selectedProvider}/refresh`, { method: 'POST' });
      if (res.ok) {
        setCurrent(await res.json());
        fetchProviders();
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div
      className="min-h-[100dvh] text-neutral-100 flex flex-col"
      style={{
        backgroundImage: "linear-gradient(rgba(9,9,11,0.85), rgba(9,9,11,0.85)), url('/bubbalab-wallpaper.png')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }}
    >
      <div className="flex-1 flex flex-col md:flex-row min-h-0">
      {/* Sidebar / Top Nav on Mobile */}
      <aside className={`w-full ${sidebarCollapsed ? 'md:w-16' : 'md:w-64'} bg-neutral-900 border-b md:border-b-0 md:border-r border-neutral-800 flex flex-col shrink-0 transition-[width] duration-150`}>
        <div className="p-4 md:p-6 border-b border-neutral-800 flex items-center justify-between md:block">
          <div className="flex items-center justify-between gap-2">
            <button onClick={() => setSelectedProvider(null)} className="text-left flex items-center gap-3 min-w-0">
              <img src="/hoboguppy-logo2.svg" alt="" className="w-10 h-10 shrink-0" />
              <div className={`min-w-0 ${sidebarCollapsed ? 'md:hidden' : ''}`}>
                <p className="text-cyan-400 text-sm md:text-base font-extrabold hidden md:block" style={{ fontFamily: 'ui-rounded, "Segoe UI Rounded", system-ui, sans-serif' }}>bubbAlab</p>
                <h1 className="text-lg md:text-xl font-bold">Usage Daemon</h1>
              </div>
            </button>
            <div className={`flex items-center gap-2 shrink-0 ${sidebarCollapsed ? 'md:hidden' : ''}`}>
              <button
                onClick={() => setShowGlobalSettings(true)}
                className="p-1.5 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors shrink-0"
                title="Settings"
              >
                <Settings size={16} />
              </button>
            </div>
          </div>
          <button
            onClick={toggleSidebar}
            className="hidden md:flex items-center justify-center w-full mt-2 py-1 rounded-md text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>

        <nav className="flex md:flex-col p-3 md:p-4 gap-2 overflow-x-auto md:overflow-y-auto custom-scrollbar flex-1">
          <button
            onClick={() => setSelectedProvider(null)}
            title="Overview"
            className={`flex-shrink-0 flex items-center gap-2 ${sidebarCollapsed ? 'md:justify-center md:px-2' : 'px-3'} py-2 text-sm rounded-lg transition-colors ${
              selectedProvider === null
                ? 'bg-neutral-800 text-white font-medium'
                : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
            }`}
          >
            <Activity size={16} className={selectedProvider === null ? 'text-emerald-400' : ''} />
            <span className={sidebarCollapsed ? 'md:hidden' : ''}>Overview</span>
          </button>
          <div className={`hidden md:block text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2 mt-2 px-2 ${sidebarCollapsed ? 'md:hidden' : ''}`}>Providers</div>
          {providers.length === 0 && !loading && (
            <div className={`px-2 text-sm text-neutral-400 whitespace-nowrap ${sidebarCollapsed ? 'md:hidden' : ''}`}>No providers found</div>
          )}
          {visibleProviders.map((p) => (
            <div
              key={p.provider}
              title={p.provider}
              className={`group flex-shrink-0 flex items-center justify-between gap-1 ${sidebarCollapsed ? 'md:justify-center md:px-1' : 'pl-3 pr-1'} py-1 text-sm rounded-lg transition-colors ${
                selectedProvider === p.provider
                  ? 'bg-neutral-800 text-white font-medium'
                  : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-200'
              }`}
            >
              <button onClick={() => setSelectedProvider(p.provider)} className="flex items-center gap-2 py-1 min-w-0">
                <ProviderIcon provider={p.provider} size={16} className={selectedProvider === p.provider ? 'text-emerald-400' : ''} />
                <span className={`capitalize truncate ${sidebarCollapsed ? 'md:hidden' : ''}`}>{p.provider}</span>
              </button>
              <div className={`flex items-center gap-1 shrink-0 ${sidebarCollapsed ? 'md:hidden' : ''}`}>
                <button
                  onClick={(e) => { e.stopPropagation(); setSettingsProvider(p.provider); }}
                  className="p-1.5 rounded-md text-neutral-500 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-neutral-200 hover:bg-neutral-700/50 transition-opacity"
                  title={`${p.provider} settings`}
                >
                  <Settings size={14} />
                </button>
                <div className={`w-2 h-2 rounded-full shrink-0 ${p.status === 'ok' && !p.stale ? 'bg-emerald-500' : p.status === 'ok' ? 'bg-amber-500' : 'bg-red-500'}`} />
              </div>
            </div>
          ))}
        </nav>

        <div className={sidebarCollapsed ? 'md:hidden' : ''}>
          <DaemonPanel />
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-4 md:p-8 custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <RefreshCw className="animate-spin text-neutral-500" />
          </div>
        ) : error ? (
          <div className="p-4 bg-red-900/20 border border-red-500/50 rounded-xl text-red-400 flex items-center gap-3">
            <AlertCircle />
            <span>{error}</span>
          </div>
        ) : selectedProvider ? (
          <ProviderDashboard
            provider={selectedProvider}
            config={config}
            current={current}
            history={history}
            onRefresh={refreshCurrent}
            showDepletion={globalSettings.showDepletion}
            // Carries cookie_from_firefox, so an errored-out cookie provider can
            // offer the "refresh from Firefox" prompt inline.
            providerMeta={providers.find((p: any) => p.provider === selectedProvider)}
          />
        ) : (
          <OverviewBoardV3 providers={visibleProviders} onJump={setSelectedProvider} showDepletion={globalSettings.showDepletion} fetchedAt={providersFetchedAt} />
        )}
      </main>
      </div>
      {settingsProvider && (
        <ProviderSettingsModal
          provider={settingsProvider}
          providerMeta={providers.find((p) => p.provider === settingsProvider)}
          onClose={() => setSettingsProvider(null)}
          onRefresh={fetchProviders}
          hidden={hidden}
          onToggleHidden={toggleHidden}
        />
      )}
      {showGlobalSettings && (
        <GlobalSettingsModal
          settings={globalSettings}
          onChange={updateGlobalSettings}
          onClose={() => setShowGlobalSettings(false)}
          providers={providers}
          hidden={hidden}
          onToggleHidden={toggleHidden}
        />
      )}
    </div>
  );
}

// Ordinary least-squares slope of y over x — mirrors the daemon's own
// burnrate.js. The daemon only exposes a will_deplete boolean per window;
// this recomputes an actual ETA client-side from the same history rows for
// the projection callout below.
function slope(points: [number, number][]): number {
  const n = points.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

// Projects depletion for a single window from its own history — shown inline
// on that window's own tile (a "Deplete:" line next to "Reset:") rather than
// a separate callout, so there's one place to look, not two saying similar
// things about the same window.
function projectWindowDepletion(w: any, history: any[]) {
  if (!w.resets_at || w.pct == null) return null;
  const now = Date.now();
  const resetMs = new Date(w.resets_at).getTime();
  if (Number.isNaN(resetMs) || resetMs <= now) return null;

  // Already fully used — "runs out in ~0ms" is a nonsense projection (and
  // formatDistanceToNow will round that to "ago" depending on render timing,
  // reading as if depletion is somehow in the past). State it plainly instead.
  if (w.pct >= 100) return { etaMs: null, alreadyDepleted: true };

  const pts: [number, number][] = (history || [])
    .filter((r: any) => typeof r[w.id] === 'number')
    .map((r: any) => [r.t, r[w.id]]);
  if (pts.length < 2) return null;

  const m = slope(pts); // pct per ms
  if (m <= 0) return null; // flat/dropping, not depleting

  const msToFull = (100 - w.pct) / m;
  if (now + msToFull >= resetMs) return null; // will last to reset
  return { etaMs: msToFull, alreadyDepleted: false };
}

// Pixels of chart width per data point when scrolling — wide enough that
// dense history stays legible instead of squashing to fit the card.
const CHART_PX_PER_POINT = 6;

// Quick-zoom presets for the history chart. null = show all history.
const RANGE_PRESETS: { label: string; ms: number | null }[] = [
  { label: '5h', ms: 5 * 3600e3 },
  { label: '12h', ms: 12 * 3600e3 },
  { label: '1d', ms: 24 * 3600e3 },
  { label: '7d', ms: 7 * 24 * 3600e3 },
  { label: 'All', ms: null },
];

// Inline prompt shown when a cookie-auth provider has errored out and the
// daemon says its cookie can be pulled from Firefox. The point is that the
// offer appears where the failure appears — you shouldn't have to go digging
// through a settings modal to fix an expired session.
//
// Outcomes are deliberately distinguished, because they mean different things:
//   - Firefox had no live cookie          -> you were never/no longer logged in there
//   - refreshed, but still not authorized -> the browser session itself is dead
// Both point at the same fix (log in to the site in Firefox), and saying so
// beats a generic failure.
function CookieExpiredPrompt({ provider, domain, onRefresh }: any) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const refresh = async () => {
    setBusy(true);
    setNote(null);
    setOk(null);
    try {
      const r = await fetch(`/usage/${provider}/cookie/from-firefox`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNote(`${body.error ?? 'could not read the cookie'} — log in to ${domain} in Firefox, then try again.`);
      } else if (body.status && body.status !== 'ok') {
        setNote(`Got a cookie from Firefox, but ${provider} still rejected it — that session is dead. Log in to ${domain} in Firefox, then try again.`);
      } else {
        // Say what actually happened. A prompt that just disappears leaves you
        // guessing whether it worked or the page simply moved on.
        const c = body.cookie_source;
        setOk(
          c
            ? `Pulled ${c.cookies} cookie(s) from Firefox (${c.profile}) — ${provider} is back. ` +
              (c.expires_at === 'session-only'
                ? 'Session cookie: lasts until Firefox closes.'
                : `Good until ${new Date(c.expires_at).toLocaleString()}.`)
            : `${provider} is back.`,
        );
      }
      onRefresh();
    } catch {
      setNote('request failed — is the daemon up?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-amber-200">
          Session cookie for <span className="font-mono">{domain}</span> has expired. Refresh it from Firefox?
        </p>
        <button
          disabled={busy}
          onClick={refresh}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          {busy ? 'Reading Firefox…' : 'Yes, refresh'}
        </button>
      </div>
      {note && <p className="text-xs text-amber-300/90">{note}</p>}
      {ok && <p className="text-xs text-emerald-300/90">{ok}</p>}
    </div>
  );
}

// The oauth-file counterpart to CookieExpiredPrompt (grok, claude).
//
// These providers read a token straight out of the CLI's own credentials file
// on every poll, and the daemon never refreshes it — so unlike the cookie case
// there is nothing to re-pull: the file already holds whatever it holds, and
// an expired token stays expired until you log in again with the CLI. What was
// missing was saying so. A bare "auth_expired" doesn't tell you which file is
// involved or which command fixes it; this does, and Retry re-reads the file
// the moment you have.
function AuthFileExpiredPrompt({ provider, auth, onRefresh }: any) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const retry = async () => {
    setBusy(true);
    setNote(null);
    setOk(null);
    try {
      const r = await fetch(`/usage/${provider}/refresh`, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (r.ok && body.status === 'ok') setOk(`${provider} is authorized again.`);
      else setNote(body.error || `Still not authorized — has ${auth?.relogin || 'the CLI login'} finished?`);
      onRefresh();
    } catch {
      setNote('request failed — is the daemon up?');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-amber-950/40 border border-amber-800/60 rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-amber-200">
          {provider} isn't authorized. Its token is read from{' '}
          <span className="font-mono text-xs">{auth?.path || 'the CLI credentials file'}</span>{' '}
          and never refreshed here — run{' '}
          <span className="font-mono text-xs bg-neutral-900 px-1.5 py-0.5 rounded">{auth?.relogin || 'the CLI login'}</span>,
          then retry.
        </p>
        <button
          disabled={busy}
          onClick={retry}
          className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
        >
          {busy ? 'Re-reading…' : 'Retry'}
        </button>
      </div>
      {note && <p className="text-xs text-amber-300/90">{note}</p>}
      {ok && <p className="text-xs text-emerald-300/90">{ok}</p>}
    </div>
  );
}

function ProviderDashboard({ provider, config, current, history, onRefresh, showDepletion, providerMeta }: any) {
  const windows = current?.windows || config?.windows || [];

  // Selected time window for the history chart (null = All). A user
  // preference, not per-provider state -- persisted in localStorage and kept
  // across provider switches / reloads, same pattern as hiddenProviders.
  const [rangeLabel, setRangeLabel] = useState<string>(() => localStorage.getItem('historyRange') || 'All');
  const rangeMs = RANGE_PRESETS.find((r) => r.label === rangeLabel)?.ms ?? null;
  function selectRange(label: string) {
    setRangeLabel(label);
    localStorage.setItem('historyRange', label);
  }

  const chartData = useMemo(() => {
    if (!history || !Array.isArray(history) || !windows.length) return [];
    // History rows are the daemon's compact store format: {t, tier, <windowId>: pct}
    // (see store.js) — key off the current window list's ids, not hardcoded names,
    // so this works for every provider (grok's monthly/weekly, mistral's
    // vibe_monthly, cloudflare's neurons, etc), not just claude/ollama's
    // session/weekly.
    return history.map((snap: any) => {
      const date = new Date(snap.t);
      const data: any = {
        t: snap.t,               // epoch ms — drives a real time-scaled X axis
        time: format(date, 'MMM d HH:mm'),
        fullDate: date
      };
      windows.forEach((w: any) => {
        if (snap[w.id] !== undefined) data[w.label || w.id] = snap[w.id];
      });
      return data;
    });
  }, [history, windows]);

  const depletionByWindow = useMemo(
    () =>
      showDepletion
        ? Object.fromEntries(windows.map((w: any) => [w.id, projectWindowDepletion(w, history)]))
        : {},
    [windows, history, showDepletion],
  );

  // Numeric X-axis domain for the selected range. Anchored to the newest
  // sample (not wall-clock now) so an idle gap doesn't push all data off-screen.
  // allowDataOverflow on the axis clips the lines to this window.
  const [xDomain, visibleMs]: [[number, number] | ['dataMin', 'dataMax'], number] = useMemo(() => {
    if (!chartData.length) return [['dataMin', 'dataMax'], 0];
    const lastT = chartData[chartData.length - 1].t;
    const firstT = chartData[0].t;
    if (rangeMs == null) return [['dataMin', 'dataMax'], lastT - firstT];
    const start = Math.max(firstT, lastT - rangeMs);
    // A zero-width numeric domain (e.g. only one sample falls in the selected
    // range) hangs Recharts'/d3's tick generation for a time-scaled axis --
    // floor the width so the axis always has something to divide.
    const safeStart = start >= lastT ? lastT - 60_000 : start;
    return [[safeStart, lastT], lastT - safeStart];
  }, [chartData, rangeMs]);

  // Date needed on ticks only once the visible window straddles >1 day.
  const visibleMultiDay = visibleMs > 24 * 3600e3;

  // What Recharts actually renders: chartData is the FULL history (now
  // potentially thousands of rows since store.js stopped losing it) -- the
  // range preset only clipped the axis domain, not this array, so every
  // provider switch re-rendered every point regardless of zoom. Slice to the
  // selected window, then stride-downsample so even "All" on a heavy history
  // stays well under a point count Recharts chokes on.
  const MAX_CHART_POINTS = 500;
  const visibleChartData = useMemo(() => {
    const windowed =
      typeof xDomain[0] === 'number'
        ? chartData.filter((d) => d.t >= xDomain[0] && d.t <= (xDomain[1] as number))
        : chartData;
    if (windowed.length <= MAX_CHART_POINTS) return windowed;
    const stride = Math.ceil(windowed.length / MAX_CHART_POINTS);
    const sampled = windowed.filter((_, i) => i % stride === 0);
    if (sampled[sampled.length - 1] !== windowed[windowed.length - 1]) sampled.push(windowed[windowed.length - 1]);
    return sampled;
  }, [chartData, xDomain]);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <header className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-6 border-b border-neutral-800">
        <div>
          <h2 className="text-3xl font-bold capitalize flex items-center gap-3">
            <ProviderIcon provider={provider} size={28} className="text-emerald-400" />
            {config?.label || provider}
            {current?.tier && <span className="text-xs font-medium px-2 py-1 bg-neutral-800 rounded-md uppercase tracking-wider text-neutral-300">{current.tier}</span>}
          </h2>
          <div className="flex items-center gap-4 mt-2 text-sm text-neutral-400">
            <span className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${current?.status === 'ok' && !current?.stale ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {current?.status || 'Unknown'} {current?.stale ? '(Stale)' : ''}
            </span>
            {current?.t && <span>Updated {formatDistanceToNow(current.t, { addSuffix: true })}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onRefresh} className="flex items-center gap-2 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 rounded-lg text-sm transition-colors">
            <RefreshCw size={16} />
            Force Poll
          </button>
        </div>
      </header>

      {providerMeta?.cookie_from_firefox && current?.status && current.status !== 'ok' && (
        <CookieExpiredPrompt
          provider={provider}
          domain={providerMeta.cookie_from_firefox}
          onRefresh={onRefresh}
        />
      )}

      {config?.auth?.kind === 'oauth-file' && current?.status && current.status !== 'ok' && (
        <AuthFileExpiredPrompt provider={provider} auth={config.auth} onRefresh={onRefresh} />
      )}

      {/* Overview Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {windows.map((w: any) => (
          <div key={w.id} className="bg-neutral-900 border border-neutral-800 rounded-xl p-5 relative overflow-hidden">
            <div className="flex justify-between items-start mb-4">
              <h3 className="text-neutral-400 font-medium">{w.label || w.id}</h3>
              <span className={`text-2xl font-bold ${showDepletion && w.will_deplete ? 'text-red-400' : 'text-neutral-100'}`}>
                {/* When the window carries a countable unit + hard cap (e.g.
                    cloudflare neurons), lead with the absolute count — that's
                    the real signal — and keep pct as the small line below. */}
                {w.unit && typeof w.used === 'number'
                  ? `${w.used.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${w.unit}`
                  : typeof w.pct === 'number' ? `${w.pct.toFixed(1)}%` : '—'}
              </span>
            </div>
            
            <div className="h-2 w-full bg-neutral-800 rounded-full overflow-hidden">
              <div 
                className="h-full rounded-full transition-all duration-1000"
                style={{ 
                  width: `${Math.min(Math.max(w.pct || 0, 0), 100)}%`,
                  backgroundColor: w.color || '#10b981'
                }}
              />
            </div>
            
            <div className="mt-4 flex flex-col gap-1 text-xs text-neutral-400">
              {w.resets_at && (
                <span>Reset: {formatDistanceToNow(new Date(w.resets_at), { addSuffix: true })}</span>
              )}
              {w.unit && typeof w.used === 'number' && typeof w.cap === 'number' && (
                <span>
                  {w.used.toLocaleString(undefined, { maximumFractionDigits: 2 })} / {w.cap.toLocaleString()} {w.unit}
                  {typeof w.pct === 'number' ? ` · ${w.pct.toFixed(2)}%` : ''}
                </span>
              )}
              {showDepletion && (() => {
                const dep = depletionByWindow[w.id];
                if (dep?.alreadyDepleted) {
                  return <span className="text-red-400 flex items-center gap-1"><AlertCircle size={12}/> Deplete: already at 100%</span>;
                }
                if (dep?.etaMs != null) {
                  return (
                    <span className="text-red-400 flex items-center gap-1">
                      <AlertCircle size={12}/> Deplete: {formatDistanceToNow(Date.now() + dep.etaMs, { addSuffix: true })}
                    </span>
                  );
                }
                return null;
              })()}
            </div>
          </div>
        ))}
      </div>

      {/* Charts area */}
      <div className="grid grid-cols-1 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-5">
          <div className="flex items-center justify-between gap-2 mb-6">
            <div className="flex items-center gap-2">
              <TrendingUp className="text-neutral-400" />
              <h3 className="font-medium text-lg">Usage History</h3>
            </div>
            <div className="flex items-center gap-1">
              {RANGE_PRESETS.map((r) => (
                <button
                  key={r.label}
                  onClick={() => selectRange(r.label)}
                  className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
                    rangeMs === r.ms
                      ? 'bg-neutral-700 border-neutral-600 text-neutral-100'
                      : 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="h-[340px] w-full overflow-x-auto custom-scrollbar">
            {chartData.length > 0 ? (
              <div
                className="h-full min-w-full"
                style={{ width: `${visibleChartData.length * CHART_PX_PER_POINT}px` }}
              >
                <ResponsiveContainer width="100%" height="100%">
                <LineChart data={visibleChartData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
                  <XAxis
                    dataKey="t"
                    // Real time scale: ticks land on actual timestamps and are
                    // spaced by elapsed time, not one-per-sample. minTickGap
                    // drops any label that would collide with its neighbour, so
                    // the axis never crowds regardless of sample density.
                    type="number"
                    scale="time"
                    domain={xDomain}
                    allowDataOverflow
                    stroke="#a3a3a3"
                    fontSize={12}
                    tickMargin={10}
                    minTickGap={64}
                    tickFormatter={(t: number) =>
                      // Drop the date when the visible window fits in one day
                      // (just HH:mm); include "MMM d" once it crosses days.
                      format(t, visibleMultiDay ? 'MMM d HH:mm' : 'HH:mm')
                    }
                  />
                  <YAxis stroke="#a3a3a3" fontSize={12} domain={[0, 100]} tickFormatter={(val) => `${val}%`} />
                  <RechartsTooltip
                    contentStyle={{ backgroundColor: '#171717', borderColor: '#262626', borderRadius: '8px' }}
                    labelStyle={{ color: '#e5e5e5' }}
                    itemStyle={{ fontSize: '14px' }}
                    labelFormatter={(t: number) => format(t, 'MMM d HH:mm')}
                  />
                  <Legend />
                  {windows.map((w: any, i: number) => (
                    <Line
                      key={w.id}
                      type="monotone"
                      dataKey={w.label || w.id}
                      stroke={w.color || ['#10b981', '#3b82f6', '#f59e0b', '#ef4444'][i % 4]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 6 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-neutral-400">
                Not enough history data
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
