type EchoLogoProps = {
  className?: string;
  title?: string;
};

let gradientCounter = 0;

export default function EchoLogo({ className, title }: EchoLogoProps) {
  // Each instance gets its own gradient id so multiple logos on the page
  // don't share one accidentally re-defined gradient.
  const gradientId = `echo-logo-bg-${++gradientCounter}`;

  return (
    <svg
      className={className}
      viewBox="0 0 256 256"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="256" y2="256" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4338CA" />
          <stop offset="55%" stopColor="#5448E2" />
          <stop offset="100%" stopColor="#6366F1" />
        </linearGradient>
      </defs>
      <rect x="20" y="20" width="216" height="216" rx="52" fill={`url(#${gradientId})`} />
      <rect x="20.5" y="20.5" width="215" height="215" rx="51.5" stroke="#0F172A" strokeOpacity="0.18" />
      <path d="M110 91H184" stroke="#FFFFFF" strokeOpacity="0.16" strokeWidth="15" strokeLinecap="round" />
      <path d="M110 128H184" stroke="#FFFFFF" strokeOpacity="0.16" strokeWidth="15" strokeLinecap="round" />
      <path d="M110 165H184" stroke="#FFFFFF" strokeOpacity="0.16" strokeWidth="15" strokeLinecap="round" />
      <path d="M96 91H168" stroke="#FFFFFF" strokeOpacity="0.32" strokeWidth="15" strokeLinecap="round" />
      <path d="M96 128H168" stroke="#FFFFFF" strokeOpacity="0.32" strokeWidth="15" strokeLinecap="round" />
      <path d="M96 165H168" stroke="#FFFFFF" strokeOpacity="0.32" strokeWidth="15" strokeLinecap="round" />
      <path d="M83 91H145" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="15" strokeLinecap="round" />
      <path d="M83 128H145" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="15" strokeLinecap="round" />
      <path d="M83 165H145" stroke="#FFFFFF" strokeOpacity="0.55" strokeWidth="15" strokeLinecap="round" />
      <path
        d="M128 91H86C74.954 91 66 99.954 66 111V145C66 156.046 74.954 165 86 165H128M84 128H126"
        stroke="#FFFFFF"
        strokeWidth="30"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
