type EchoMarkProps = {
  className?: string;
  title?: string;
};

let gradientCounter = 0;

export default function EchoMark({ className, title }: EchoMarkProps) {
  const gradientId = `echo-mark-gradient-${++gradientCounter}`;
  const rearGradientId = `echo-mark-rear-${gradientCounter}`;
  const middleGradientId = `echo-mark-middle-${gradientCounter}`;
  const glowId = `echo-mark-glow-${gradientCounter}`;

  return (
    <svg
      className={className}
      viewBox="0 0 520 320"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={rearGradientId} x1="96" y1="58" x2="190" y2="258" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="55%" stopColor="#DCE6FF" />
          <stop offset="100%" stopColor="#EEF2FF" />
        </linearGradient>
        <linearGradient id={middleGradientId} x1="156" y1="60" x2="250" y2="260" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#B8C9FF" />
          <stop offset="48%" stopColor="#6E91FF" />
          <stop offset="100%" stopColor="#4E55FF" />
        </linearGradient>
        <linearGradient id={gradientId} x1="232" y1="52" x2="378" y2="262" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#F3F7FF" />
          <stop offset="42%" stopColor="#A9C7FF" />
          <stop offset="100%" stopColor="#5963FF" />
        </linearGradient>
        <filter id={glowId} x="48" y="24" width="424" height="272" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.30 0 0 0 0 0.36 0 0 0 0 1.00 0 0 0 0.34 0" />
          <feBlend in="SourceGraphic" mode="screen" />
        </filter>
      </defs>
      <g opacity="0.82">
        <path d="M125 160C125 84 182 42 256 42C302 42 339 61 363 94" stroke={`url(#${rearGradientId})`} strokeWidth="104" strokeLinecap="round" />
        <path d="M125 160C125 236 182 278 256 278C301 278 338 260 363 226" stroke={`url(#${rearGradientId})`} strokeWidth="104" strokeLinecap="round" />
      </g>
      <g opacity="0.92">
        <path d="M184 160C184 90 236 52 305 52C347 52 382 70 405 101" stroke={`url(#${middleGradientId})`} strokeWidth="100" strokeLinecap="round" />
        <path d="M184 160C184 230 236 268 305 268C347 268 382 251 405 219" stroke={`url(#${middleGradientId})`} strokeWidth="100" strokeLinecap="round" />
      </g>
      <g filter={`url(#${glowId})`}>
        <path d="M282 160H440" stroke={`url(#${gradientId})`} strokeWidth="88" strokeLinecap="round" />
        <path d="M439 98C411 64 373 46 326 46C253 46 198 92 198 160C198 228 253 274 326 274C372 274 410 257 439 222" stroke={`url(#${gradientId})`} strokeWidth="88" strokeLinecap="round" />
      </g>
    </svg>
  );
}
