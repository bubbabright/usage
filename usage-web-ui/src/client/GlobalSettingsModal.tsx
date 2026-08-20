import { X, Eye, EyeOff } from 'lucide-react';

// App-wide UI preferences, opened via the gear icon in the sidebar header.
// Distinct from ProviderSettingsModal (SettingsView.tsx), which holds
// per-provider auth/visibility settings.
export function GlobalSettingsModal({ settings, onChange, onClose, providers, hidden, onToggleHidden }: any) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="bg-neutral-900 border border-neutral-800 rounded-xl p-4 w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-medium text-base">Settings</h4>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-300 p-1">
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center justify-between p-2 bg-neutral-950 rounded-lg border border-neutral-800">
          <span className="text-sm text-neutral-400">Show depletion info</span>
          <button
            onClick={() => onChange({ ...settings, showDepletion: !settings.showDepletion })}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              settings.showDepletion
                ? 'bg-emerald-950/50 border border-emerald-900 text-emerald-400 hover:bg-emerald-950'
                : 'bg-neutral-800 hover:bg-neutral-700 text-neutral-400'
            }`}
            title={settings.showDepletion ? 'On — click to hide' : 'Off — click to show'}
          >
            {settings.showDepletion ? <><Eye size={14} /> On</> : <><EyeOff size={14} /> Off</>}
          </button>
        </div>

        {Array.isArray(providers) && providers.length > 0 && (
          <div className="mt-3">
            <div className="text-sm text-neutral-400 mb-2">Provider visibility</div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {providers.map((p: any) => {
                const isHidden = hidden?.has(p.provider);
                return (
                  <div
                    key={p.provider}
                    className="flex items-center justify-between p-2 bg-neutral-950 rounded-lg border border-neutral-800"
                  >
                    <span className="text-sm text-neutral-300 capitalize">{p.provider}</span>
                    <button
                      onClick={() => onToggleHidden(p.provider)}
                      className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                        isHidden
                          ? 'bg-neutral-800 hover:bg-neutral-700 text-neutral-400'
                          : 'bg-emerald-950/50 border border-emerald-900 text-emerald-400 hover:bg-emerald-950'
                      }`}
                      title={isHidden ? 'Hidden — click to show' : 'Visible — click to hide'}
                    >
                      {isHidden ? <><EyeOff size={14} /> Hidden</> : <><Eye size={14} /> Visible</>}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
