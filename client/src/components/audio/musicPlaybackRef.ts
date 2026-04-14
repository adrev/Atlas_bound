/**
 * Global mutable ref for music playback state. MusicEngine writes to
 * this every ~250ms; UI components poll it to display progress.
 */
export const musicPlaybackRef = {
  currentTime: 0,
  duration: 0,
  paused: false,
  currentFileUrl: '',
};
