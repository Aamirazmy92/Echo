import { useCallback, useEffect, useRef, useState } from 'react';
import {
  computeMicBarLevels,
  micTestErrorMessage,
  setMicTestActive,
  startMicTestSession,
  type MicTestSession,
} from './micTest';

const BAR_COUNT = 7;
const EMPTY_BARS = [0, 0, 0, 0, 0, 0, 0];

export function normalizeMicDeviceId(value: string): string {
  return !value || value === 'default' ? '' : value;
}

export function useMicTest(active: boolean) {
  const [testingDeviceKey, setTestingDeviceKey] = useState<string | null>(null);
  const [bars, setBars] = useState<number[]>(EMPTY_BARS);
  const [error, setError] = useState('');
  const animFrameRef = useRef<number>(0);
  const sessionRef = useRef<MicTestSession | null>(null);
  const smoothedBarsRef = useRef<number[]>([...EMPTY_BARS]);

  const stopTesting = useCallback(async () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = 0;
    }

    const session = sessionRef.current;
    sessionRef.current = null;
    if (session) {
      await session.stop();
    }

    setMicTestActive(false);
    setTestingDeviceKey(null);
    setBars([...EMPTY_BARS]);
    smoothedBarsRef.current = [...EMPTY_BARS];
  }, []);

  const startTesting = useCallback(async (deviceKey: string) => {
    setError('');
    await stopTesting();

    try {
      const session = await startMicTestSession(normalizeMicDeviceId(deviceKey));
      sessionRef.current = session;
      setMicTestActive(true);
      setTestingDeviceKey(deviceKey);
      smoothedBarsRef.current = [...EMPTY_BARS];

      const tick = () => {
        const activeSession = sessionRef.current;
        if (!activeSession) return;

        const nextLevels = computeMicBarLevels(activeSession.analyser, BAR_COUNT);
        const newBars = nextLevels.map((raw, index) => {
          const prev = smoothedBarsRef.current[index] ?? 0;
          const next = raw > prev ? prev + (raw - prev) * 0.72 : prev + (raw - prev) * 0.28;
          smoothedBarsRef.current[index] = Math.max(0, next);
          return smoothedBarsRef.current[index];
        });

        setBars([...newBars]);
        animFrameRef.current = requestAnimationFrame(tick);
      };

      tick();
    } catch (err: unknown) {
      setError(micTestErrorMessage(err));
      await stopTesting();
    }
  }, [stopTesting]);

  const toggleDeviceTest = useCallback(async (deviceKey: string) => {
    if (testingDeviceKey === deviceKey) {
      await stopTesting();
      return;
    }

    await startTesting(deviceKey);
  }, [startTesting, stopTesting, testingDeviceKey]);

  useEffect(() => {
    if (active) return;
    void stopTesting();
  }, [active, stopTesting]);

  useEffect(() => {
    return () => {
      void stopTesting();
    };
  }, [stopTesting]);

  return {
    bars,
    error,
    testingDeviceKey,
    toggleDeviceTest,
    isTestingDevice: (deviceKey: string) => testingDeviceKey === deviceKey,
  };
}
