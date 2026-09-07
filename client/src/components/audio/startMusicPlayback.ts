/** A blocked autoplay and its gesture retry share the same fade and cleanup. */
export function startMusicPlayback(
  audio: HTMLAudioElement,
  getVolume: () => number,
  canPlay: () => boolean,
  gestures: Pick<Document, 'addEventListener' | 'removeEventListener'> = document,
): () => void {
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const current = () => !cancelled && canPlay();
  const stopFade = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const retry = () => { attempt(); };
  const attempt = () => {
    if (!current()) return;
    void audio.play().then(() => {
      if (!current()) return;
      stopFade();
      let step = 0;
      timer = setInterval(() => {
        if (!current() || audio.paused) {
          stopFade();
          return;
        }
        step++;
        audio.volume = Math.min(1, Math.max(0, getVolume())) * (step / 15);
        if (step >= 15) stopFade();
      }, 500 / 15);
    }).catch(() => {
      if (current()) gestures.addEventListener('click', retry, { once: true });
    });
  };
  attempt();
  return () => {
    cancelled = true;
    stopFade();
    gestures.removeEventListener('click', retry);
  };
}
