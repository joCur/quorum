import * as React from "react";
import {
  isStillAvailable,
  rememberInputDevice,
  readRememberedInputDevice,
  toAudioInputs,
  type AudioInput,
} from "@/features/recording/input-device";

export interface AudioInputsState {
  /** The inputs the browser is willing to name. Empty until the microphone permission is given. */
  inputs: AudioInput[];
  /** The input a recording would use, or `null` for whatever the system considers the default. */
  deviceId: string | null;
  /** True once — and only once — after a remembered device turned out to be gone. */
  forgotten: boolean;
  choose: (deviceId: string | null) => void;
}

/**
 * The audio inputs available to this browser, and which of them the next recording uses.
 *
 * The list refreshes on `devicechange`, which is also what makes the picker appear after the very
 * first recording: granting the microphone permission fires that event, and the labels the browser
 * withheld until then arrive with it. Deliberately no permission request of its own — asking for
 * the microphone to populate a dropdown would put the permission prompt in front of a user who
 * has not yet said they want to record, and the consent notice comes first (STATES.md §1).
 */
export function useAudioInputs(): AudioInputsState {
  const [inputs, setInputs] = React.useState<AudioInput[]>([]);
  const [chosen, setChosen] = React.useState<string | null>(() => readRememberedInputDevice());
  const [forgotten, setForgotten] = React.useState(false);
  // The notice is shown for one disappearance, not for every re-enumeration that follows it.
  const announcedRef = React.useRef(false);

  React.useEffect(() => {
    const media = navigator.mediaDevices as MediaDevices | undefined;
    if (!media?.enumerateDevices) return;

    let active = true;
    const refresh = () => {
      void media
        .enumerateDevices()
        .then((devices) => {
          if (!active) return;
          const next = toAudioInputs(devices);
          setInputs(next);
          // Nothing can be judged gone while the browser is naming nothing at all.
          if (next.length === 0) return;
          setChosen((current) => {
            if (isStillAvailable(current, next) || current === null) return current;
            // The remembered device is gone. Forget it, so the fallback is stated once and the
            // screen is quiet again next time.
            rememberInputDevice(null);
            if (!announcedRef.current) {
              announcedRef.current = true;
              setForgotten(true);
            }
            return null;
          });
        })
        .catch(() => {
          // A browser that refuses to enumerate simply offers no choice.
        });
    };

    refresh();
    media.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      media.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const choose = React.useCallback((deviceId: string | null) => {
    setChosen(deviceId);
    setForgotten(false);
    rememberInputDevice(deviceId);
  }, []);

  const deviceId = isStillAvailable(chosen, inputs) ? chosen : null;

  return { inputs, deviceId, forgotten, choose };
}
