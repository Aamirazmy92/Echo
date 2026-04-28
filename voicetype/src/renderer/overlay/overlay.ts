import type { AppState } from '../../shared/types';

const api = (window as any).api;

try {
  const params = new URLSearchParams(window.location.search);
  const anchor = params.get('anchor');
  if (anchor === 'top-center' || anchor === 'bottom-center') {
    document.documentElement.dataset.anchor = anchor;
  } else {
    document.documentElement.dataset.anchor = 'bottom-center';
  }
} catch {
  document.documentElement.dataset.anchor = 'bottom-center';
}

const BAR_COUNT = 7;
const IDLE_WIDTH = 36;
const IDLE_HEIGHT = 8;
const EXPANDED_WIDTH = 80;
const PILL_HEIGHT = 28;
const MAX_BAR_HEIGHT = 14;
const MIN_BAR_HEIGHT = 2;

let state: AppState = 'idle';
let levels: number[] = [];
let rafId: number | null = null;
let frame = 0;
let smoothed = new Array(BAR_COUNT).fill(0);

function getMode(nextState: AppState): 'idle' | 'wave' | 'processing' {
  if (nextState === 'recording') return 'wave';
  if (nextState === 'processing') return 'processing';
  return 'idle';
}

function sampleBand(bands: number[], barIndex: number) {
  if (!bands.length) return 0;
  if (bands.length === 1) return bands[0] ?? 0;

  const position = (barIndex / Math.max(1, BAR_COUNT - 1)) * (bands.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.min(bands.length - 1, Math.ceil(position));
  const mix = position - lowerIndex;
  const lower = bands[lowerIndex] ?? 0;
  const upper = bands[upperIndex] ?? lower;
  return lower + (upper - lower) * mix;
}

function sampleVoiceEnergy(bands: number[], barIndex: number) {
  const previous = sampleBand(bands, Math.max(0, barIndex - 1));
  const current = sampleBand(bands, barIndex);
  const next = sampleBand(bands, Math.min(BAR_COUNT - 1, barIndex + 1));
  return previous * 0.2 + current * 0.6 + next * 0.2;
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Overlay root element was not found.');
}

root.innerHTML = `
  <div id="overlay-shell">
    <div id="voice-pill" data-mode="idle">
      <div id="bars"></div>
      <svg id="spinner" width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="7" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="2.5"></circle>
        <circle cx="10" cy="10" r="7" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-dasharray="28 16" stroke-linecap="round"></circle>
      </svg>
    </div>
  </div>
`;

const pillElement = document.getElementById('voice-pill') as HTMLDivElement | null;
const barsElement = document.getElementById('bars') as HTMLDivElement | null;
const spinnerElement = document.querySelector('#spinner') as SVGSVGElement | null;

if (!pillElement || !barsElement || !spinnerElement) {
  throw new Error('Overlay elements failed to initialize.');
}

const pill = pillElement;
const bars = barsElement;
const spinner = spinnerElement;

for (let index = 0; index < BAR_COUNT; index += 1) {
  const bar = document.createElement('div');
  bar.className = 'voice-bar';
  bars.appendChild(bar);
}

const barElements = Array.from(bars.children) as HTMLDivElement[];

function stopWaveAnimation() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function resetBars() {
  smoothed = new Array(BAR_COUNT).fill(0);
  for (const bar of barElements) {
    bar.style.height = `${MIN_BAR_HEIGHT}px`;
    bar.style.opacity = '0.3';
    bar.style.boxShadow = 'none';
  }
}

function animateBars() {
  frame += 1;

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const bar = barElements[index];
    const band = Math.min(1, Math.max(0, sampleVoiceEnergy(levels, index)));
    const gated = band < 0.08 ? 0 : band;
    const target = Math.pow(gated, 0.85);
    const opacity = target > 0.05 ? 1 : 0.6;
    const previous = smoothed[index];
    const easing = target > previous ? 0.6 : 0.15;
    const nextValue = previous + (target - previous) * easing;

    smoothed[index] = nextValue;

    const height = MIN_BAR_HEIGHT + nextValue * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
    bar.style.height = `${Math.max(MIN_BAR_HEIGHT, Math.min(MAX_BAR_HEIGHT, height))}px`;
    bar.style.opacity = `${opacity}`;
    bar.style.boxShadow = opacity > 0.6 ? '0 0 8px rgba(255, 255, 255, 0.4)' : 'none';
  }

  rafId = requestAnimationFrame(animateBars);
}

function startWaveAnimation() {
  if (rafId !== null) return;
  resetBars();
  rafId = requestAnimationFrame(animateBars);
}

function applyMode() {
  const mode = getMode(state);
  pill.dataset.mode = mode;

  if (mode === 'idle') {
    pill.style.width = `${IDLE_WIDTH}px`;
    pill.style.height = `${IDLE_HEIGHT}px`;
    pill.style.padding = '0';
    pill.style.border = '1px solid rgba(255, 255, 255, 0.5)';
    bars.style.display = 'none';
    spinner.style.display = 'none';
    stopWaveAnimation();
    resetBars();
    return;
  }

  pill.style.width = `${EXPANDED_WIDTH}px`;
  pill.style.height = `${PILL_HEIGHT}px`;
  pill.style.padding = '0 10px';
  pill.style.border = '1.5px solid #ffffff';

  if (mode === 'processing') {
    bars.style.display = 'none';
    spinner.style.display = 'block';
    stopWaveAnimation();
    return;
  }

  spinner.style.display = 'none';
  bars.style.display = 'flex';
  startWaveAnimation();
}

api.onOverlayState((nextState: AppState) => {
  state = nextState;
  applyMode();
});

api.onAudioLevel((nextLevels: number[]) => {
  levels = nextLevels;
});

applyMode();

document.documentElement.classList.add('overlay-ready');
api.overlayRenderReady?.();
