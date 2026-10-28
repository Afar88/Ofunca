import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter, Dimensions, Keyboard, Platform, View, type KeyboardEvent, type StyleProp, type ViewStyle } from 'react-native';

/** Bottom padding that lifts a container's bottom edge to the keyboard's top edge. Pure, so it can be checked in node. */
export function keyboardPad(containerBottom: number | null, keyboardTop: number | null): number {
  if (containerBottom == null || keyboardTop == null) return 0;
  return Math.max(0, Math.round(containerBottom - keyboardTop));
}

/** Keyboard top from the native IME inset: windowHeight - imeHeight (dp), or null when the keyboard is closed. */
export function imeTop(height: number | null | undefined, windowHeight: number | null | undefined): number | null {
  if (typeof height !== 'number' || !(height > 1) || typeof windowHeight !== 'number' || !(windowHeight > 0)) return null;
  return Math.max(0, windowHeight - height);
}

/** Small gap kept between the input bar and the keyboard, so nothing is ever tucked under its edge. */
export const KEYBOARD_GAP = 6;

/** Top edge of the keyboard in window coordinates, or null when it is hidden.
 *  Source of truth on Android: the native "ofuncaImeChange" event (plugins/withImeInsets.js), which fires on EVERY
 *  change of the IME inset — including the suggestion strip growing the keyboard after it opened, which React
 *  Native's own keyboardDidShow never reports. RN's keyboard events are only used until a native event arrives
 *  (older build / other platform). With edge-to-edge the window is not resized, so the app makes room itself. */
export function useKeyboardTop(onShow?: () => void): number | null {
  const [top, setTop] = useState<number | null>(null);
  const cb = useRef(onShow);
  cb.current = onShow;
  const nativeSeen = useRef(false);
  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const apply = (t: number | null) => {
      setTop((prev) => (prev === t ? prev : t));
      if (t != null) cb.current?.();
    };
    const onKb = (e: KeyboardEvent) => {
      if (nativeSeen.current) return; // the native inset is exact; RN's value misses the suggestion strip
      const h = e?.endCoordinates?.height ?? 0;
      let y = e?.endCoordinates?.screenY;
      if (typeof y !== 'number' || !(y > 0)) y = Dimensions.get('screen').height - h;
      if (h <= 0) return apply(null);
      apply(y);
    };
    const onIme = (e: { height?: number; windowHeight?: number }) => {
      nativeSeen.current = true;
      apply(imeTop(e?.height, e?.windowHeight));
    };
    const subs = [
      DeviceEventEmitter.addListener('ofuncaImeChange', onIme),
      Keyboard.addListener(showEv, onKb),
      Keyboard.addListener('keyboardDidChangeFrame' as any, onKb),
      Keyboard.addListener(hideEv, () => {
        if (!nativeSeen.current) apply(null);
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return top;
}

/** A flex container that pads its bottom so its last child (an input bar, a sheet) sits right above the keyboard.
 *  Re-measures itself on every layout change and every keyboard event (long chats, tab bar hiding, repeat focus). */
export function KeyboardSafe({ style, children, onShow }: { style?: StyleProp<ViewStyle>; children: React.ReactNode; onShow?: () => void }) {
  const ref = useRef<View>(null);
  const [bottom, setBottom] = useState<number | null>(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow((_x, y, _w, h) => {
      if (Number.isFinite(y) && Number.isFinite(h) && h > 0) setBottom(y + h);
    });
  }, []);
  const top = useKeyboardTop(() => {
    measure();
    onShow?.();
  });
  useEffect(() => {
    measure();
    // the tab bar hides / shows after the keyboard event: measure again once it has settled
    const t1 = setTimeout(measure, 120);
    const t2 = setTimeout(measure, 350);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [top, measure]);
  const pad = top == null ? 0 : keyboardPad(bottom, top - KEYBOARD_GAP);
  return (
    <View ref={ref} onLayout={measure} style={[{ flex: 1 }, style, { paddingBottom: pad }]}>
      {children}
    </View>
  );
}
