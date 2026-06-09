import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import type { UpdateStatusPayload } from '../api';

type UpdateNotchProps = {
  compact: boolean;
};

const actionableStates = new Set<UpdateStatusPayload['state']>([
  'available',
  'downloading',
  'ready',
]);

export default function UpdateNotch({ compact }: UpdateNotchProps) {
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null);
  const [isActing, setIsActing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void window.api.updateGetStatus().then((initialStatus) => {
      if (!cancelled) {
        setStatus(initialStatus);
      }
    }).catch((error) => {
      console.error('Failed to load update status:', error);
    });

    const unsubscribe = window.api.onUpdateStatus((nextStatus) => {
      setStatus(nextStatus);
      if (nextStatus.state !== 'available' && nextStatus.state !== 'ready') {
        setIsActing(false);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const view = useMemo(() => {
    if (!status || !actionableStates.has(status.state)) {
      return null;
    }

    if (status.state === 'available') {
      return {
        icon: Download,
        title: 'Update ready',
        body: status.version ? `Version ${status.version} is available.` : 'A new version is available.',
        action: 'Download',
      };
    }

    if (status.state === 'downloading') {
      const progress = typeof status.progress === 'number' ? status.progress : 0;
      return {
        icon: Loader2,
        title: 'Downloading',
        body: `${progress}% complete`,
        action: null,
      };
    }

    return {
      icon: RefreshCw,
      title: 'Update downloaded',
      body: 'Restart Echo to install it.',
      action: 'Restart',
    };
  }, [status]);

  if (!status || !view) {
    return null;
  }

  const Icon = view.icon;
  const isDownloading = status.state === 'downloading';

  const handleClick = async () => {
    if (isActing || isDownloading) return;

    setIsActing(true);
    try {
      if (status.state === 'available') {
        await window.api.updateDownload();
      } else if (status.state === 'ready') {
        await window.api.updateInstall();
      }
    } catch (error) {
      console.error('Update action failed:', error);
      setIsActing(false);
    }
  };

  if (compact) {
    return (
      <button
        type="button"
        onClick={handleClick}
        disabled={isDownloading || isActing}
        aria-label={view.action ?? view.title}
        title={view.action ?? view.title}
        className="mb-2 flex h-9 w-9 items-center justify-center rounded-md bg-[hsl(var(--success-soft))] text-[hsl(var(--success))] transition-colors hover:bg-[hsl(var(--success)/0.22)] disabled:cursor-default disabled:opacity-80"
      >
        <Icon size={18} className={isDownloading ? 'animate-spin' : undefined} />
      </button>
    );
  }

  return (
    <section className="mb-2 rounded-[8px] border border-border bg-[hsl(var(--success-soft))] px-3 py-2.5 text-foreground shadow-[0_1px_2px_rgba(31,27,22,0.04)]">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-popover/85 text-[hsl(var(--success))]">
          <Icon size={17} className={isDownloading ? 'animate-spin' : undefined} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold leading-4">{view.title}</p>
          <p className="mt-0.5 truncate text-[12px] font-medium leading-4 text-foreground/70">{view.body}</p>
          {view.action && (
            <button
              type="button"
              onClick={handleClick}
              disabled={isActing}
              className="mt-2 inline-flex h-7 items-center justify-center rounded-[5px] bg-primary px-2.5 text-[12px] font-semibold text-primary-foreground transition-colors hover:brightness-95 disabled:cursor-default disabled:opacity-70"
            >
              {isActing ? 'Starting...' : view.action}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
