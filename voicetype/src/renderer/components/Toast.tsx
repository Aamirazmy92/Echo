import { useEffect, useState } from 'react';
import { Check, X, Info } from 'lucide-react';

export type ToastType = 'success' | 'error' | 'info';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

export default function Toast({ message, type = 'success', duration = 1500, onClose }: ToastProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(onClose, 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const iconMap = {
    success: <Check size={14} />,
    error: <X size={14} />,
    info: <Info size={14} />,
  };

  const colorMap = {
    success: 'bg-emerald-500/10 text-emerald-700',
    error: 'bg-destructive/10 text-destructive',
    info: 'bg-foreground/8 text-foreground',
  };

  return (
    <div
      className={`fixed bottom-6 left-1/2 z-[150] -translate-x-1/2 transition-all duration-300 ${
        visible ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
      }`}
    >
      <div className="flex items-center gap-3 rounded-xl border border-border bg-background px-4 py-2.5 shadow-lg">
        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${colorMap[type]}`}>
          {iconMap[type]}
        </div>
        <p className="text-sm font-medium text-foreground">{message}</p>
      </div>
    </div>
  );
}
