import { useEffect, useState } from 'react';
import { ArrowDown, Check } from 'lucide-react';
import { GlobalStyleId, Settings } from '../../shared/types';
import { GLOBAL_STYLE_CONFIG, GLOBAL_STYLE_ORDER, GlobalStyleConfig } from '../../shared/styleConfig';

/* Signature accent per tone — pulled from the hex baked into each tone's
   Tailwind accentClass in styleConfig, surfaced here as plain values so we
   can theme the rail dot, preview badge, and demo bubble inline. */
const TONE_ACCENT: Record<GlobalStyleId, string> = {
  formal: '#D97757',
  casual: '#788C5D',
  very_casual: '#E29E4B',
  concise: '#6A9BCC',
  code: '#88867E',
  excited: '#A28BB5',
};

export default function StyleView() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    window.api.getSettings().then((loadedSettings: Settings) => {
      setSettings(loadedSettings);
    });
  }, []);

  const updateSetting = async (partial: Partial<Settings>) => {
    setSettings((previous) => (previous ? { ...previous, ...partial } : previous));

    try {
      const saved = await window.api.saveSettings(partial);
      setSettings(saved);
    } catch (error) {
      const restored = await window.api.getSettings();
      setSettings(restored);
      throw error;
    }
  };

  // Style is always on — persist `casual` as the default the first time the
  // screen mounts on a fresh install so the user always sees a selected card.
  const needsDefaultStyle =
    settings !== null &&
    (settings.selectedGlobalStyleId === null || settings.selectedGlobalStyleId === undefined);
  useEffect(() => {
    if (needsDefaultStyle) {
      void window.api.saveSettings({ selectedGlobalStyleId: 'casual' }).then((saved: Settings) => {
        setSettings(saved);
      });
    }
  }, [needsDefaultStyle]);

  if (!settings) return null;

  const selectedStyleId: GlobalStyleId = settings.selectedGlobalStyleId ?? 'casual';
  const selectedCfg = GLOBAL_STYLE_CONFIG[selectedStyleId];
  const selectedAccent = TONE_ACCENT[selectedStyleId];

  return (
    <div className="echo-pane-inner">
      {/* Page header */}
      <div className="echo-style-head">
        <h1 className="echo-h-display">Writing style</h1>
        <p className="echo-lede">
          Pick a tone for your dictations. Echo polishes every transcript so it sounds the way you
          write — in chats, docs, emails, anywhere.
        </p>
      </div>

      {/* Two-panel: tone rail + live preview */}
      <div className="echo-style-layout">
        <div
          className="echo-style-rail"
          role="radiogroup"
          aria-label="Writing tone"
        >
          <div className="echo-style-rail-label">Choose a tone</div>
          {GLOBAL_STYLE_ORDER.map((id) => {
            const cfg = GLOBAL_STYLE_CONFIG[id];
            const accent = TONE_ACCENT[id];
            const isSelected = selectedStyleId === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => void updateSetting({ selectedGlobalStyleId: id })}
                className={`echo-style-tone ${isSelected ? 'selected' : ''}`}
                style={{ ['--tone-accent' as string]: accent }}
              >
                <span className="dot" aria-hidden="true" />
                <span className="meta">
                  <span className="label">{cfg.label}</span>
                  <span className="sublabel">{cfg.subtitle}</span>
                </span>
                {isSelected && (
                  <span className="tick" aria-hidden="true">
                    <Check size={12} strokeWidth={3} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <TonePreview cfg={selectedCfg} accent={selectedAccent} />
      </div>
    </div>
  );
}

/* ── TonePreview ───────────────────────────────────────────────────────
   Right-hand panel that demonstrates the selected tone. Shows the raw
   dictation Echo hears and the polished result it writes, themed with the
   tone's signature accent so switching tones feels tangible. */
function TonePreview({ cfg, accent }: { cfg: GlobalStyleConfig; accent: string }) {
  return (
    <div className="echo-style-preview" style={{ ['--tone-accent' as string]: accent }}>
      <div className="echo-style-preview-head">
        <span className="badge" aria-hidden="true">
          {cfg.badgeLabel}
        </span>
        <div className="titles">
          <div className="title">{cfg.label}</div>
          <div className="subtitle">{cfg.subtitle}</div>
        </div>
      </div>

      <p className="echo-style-desc">{cfg.description}</p>

      <div className="echo-style-demo">
        <div className="echo-style-demo-block">
          <span className="tag">You say</span>
          <p className="raw">“{cfg.inputExample}”</p>
        </div>

        <div className="echo-style-demo-arrow" aria-hidden="true">
          <ArrowDown size={15} />
        </div>

        <div className="echo-style-demo-block">
          <span className="tag accent">Echo writes</span>
          <p className="polished">{cfg.preview}</p>
        </div>
      </div>
    </div>
  );
}
