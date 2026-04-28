import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { Settings } from '../../shared/types';
import { GLOBAL_STYLE_CONFIG, GLOBAL_STYLE_ORDER, GlobalStyleConfig } from '../../shared/styleConfig';

export default function StyleView() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    (window as any).api.getSettings().then((loadedSettings: Settings) => {
      setSettings(loadedSettings);
    });
  }, []);

  const updateSetting = async (partial: Partial<Settings>) => {
    setSettings((previous) => (previous ? { ...previous, ...partial } : previous));

    try {
      const saved = await (window as any).api.saveSettings(partial);
      setSettings(saved);
    } catch (error) {
      const restored = await (window as any).api.getSettings();
      setSettings(restored);
      throw error;
    }
  };

  // Style is always on — if no tone has been chosen yet (fresh install or
  // legacy `null` value from the previous toggle UI), persist `casual` as
  // the default so the user always sees a selected card. `updateSetting` is
  // declared above and stable for the scope of this render; we deliberately
  // omit it from the dependency array to avoid re-firing the persist call
  // every render (it would loop).
  const needsDefaultStyle =
    settings !== null &&
    (settings.selectedGlobalStyleId === null || settings.selectedGlobalStyleId === undefined);
  useEffect(() => {
    if (needsDefaultStyle) {
      void (window as any).api.saveSettings({ selectedGlobalStyleId: 'casual' }).then((saved: Settings) => {
        setSettings(saved);
      });
    }
  }, [needsDefaultStyle]);

  if (!settings) return null;

  const selectedStyleId = settings.selectedGlobalStyleId ?? 'casual';

  return (
    <div className="page-shell">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Writing style</h1>
          <p className="page-subtitle">
            Pick a tone for your dictations. Echo will polish every transcript so it sounds the way you write — in chats, docs, emails, anywhere.
          </p>
        </div>
      </div>

      {/* Tone grid */}
      <div>
        <div className="mb-3 flex items-baseline">
          <h3 className="card-title">Choose a tone</h3>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GLOBAL_STYLE_ORDER.map((id) => {
            const cfg = GLOBAL_STYLE_CONFIG[id];
            const isSelected = selectedStyleId === id;
            return (
              <ToneCard
                key={id}
                cfg={cfg}
                selected={isSelected}
                onSelect={() => updateSetting({ selectedGlobalStyleId: id })}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ── ToneCard ──────────────────────────────────────────────────────────
   Individual tone option. Big serif label sits above a chat-bubble
   preview that shows what a dictation will look like once Echo applies
   the tone. Selected state uses an accent border + soft tint so the
   active card reads at a glance. */
function ToneCard({
  cfg,
  selected,
  onSelect,
}: {
  cfg: GlobalStyleConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card p-5 text-left transition-all duration-200 ${
        selected
          ? 'border-foreground/40 shadow-[0_10px_28px_-18px_rgba(15,23,42,0.28)]'
          : 'border-border hover:border-foreground/20 hover:shadow-[0_6px_20px_-16px_rgba(15,23,42,0.18)]'
      }`}
    >
      {/* Selected accent strip — runs along the top edge to make the
          active state obvious without needing thick borders. */}
      <div
        className={`absolute inset-x-0 top-0 h-[3px] transition-colors ${
          selected ? 'bg-foreground' : 'bg-transparent'
        }`}
      />

      {/* Selection indicator */}
      <div className="absolute right-4 top-4">
        <div
          className={`flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors ${
            selected
              ? 'border-foreground bg-foreground'
              : 'border-foreground/20 bg-background group-hover:border-foreground/35'
          }`}
        >
          {selected && <Check size={12} strokeWidth={3} className="text-background" />}
        </div>
      </div>

      {/* Tone name in the serif we already ship for stat numerals.
          Adds a touch of editorial character to differentiate this page
          from the rest of the app. */}
      <h3
        className="stat-num pr-8 text-[30px] font-semibold leading-[1.05] text-foreground"
        style={{ letterSpacing: '-0.01em' }}
      >
        {cfg.label}
      </h3>
      <p className="mt-1.5 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {cfg.subtitle}
      </p>

      {/* Preview chat bubble. Rounded with a tail, soft tint matching the
          selected accent so the bubble pops slightly when the card is
          chosen. */}
      <div className="mt-5 flex-1">
        <div
          className={`relative inline-block max-w-full rounded-2xl rounded-bl-md px-4 py-3 text-[13px] leading-snug transition-colors ${
            selected
              ? 'bg-foreground/[0.06] text-foreground'
              : 'bg-muted/55 text-foreground/80'
          }`}
        >
          {truncatePreview(cfg.preview)}
        </div>
      </div>

    </button>
  );
}

function truncatePreview(text: string): string {
  return text.length > 130 ? `${text.slice(0, 127).trimEnd()}…` : text;
}

