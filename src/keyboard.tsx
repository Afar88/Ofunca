import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Dimensions, Keyboard, Platform, View, type KeyboardEvent, type StyleProp, type ViewStyle } from 'react-native';

/** Bottom padding that lifts a container's bottom edge to the keyboard's top edge. Pure, so it can be checked in node. */
export function keyboardPad(containerBottom: number | null, keyboardTop: number | null): number {
  if (containerBottom == null || keyboardTop == null) return 0;
  return Math.max(0, Math.round(containerBottom - keyboardTop));
}

/** Top edge of the keyboard in window coordinates, or null when it is hidden. Updated on every show / hide / resize,
 *  so it never depends on a one-time measurement. With edge-to-edge on Android the window is not resized by
 *  adjustResize, so the app has to make room itself. */
export function useKeyboardTop(onShow?: () => void): number | null {
  const [top, setTop] = useState<number | null>(null);
  const cb = useRef(onShow);
  cb.current = onShow;
  useEffect(() => {
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onKb = (e: KeyboardEvent) => {
      const h = e?.endCoordinates?.height ?? 0;
      let y = e?.endCoordinates?.screenY;
      if (typeof y !== 'number' || !(y > 0)) y = Dimensions.get('screen').height - h;
      if (h <= 0) return setTop(null);
      setTop(y);
      cb.current?.();
    };
    const subs = [
      Keyboard.addListener(showEv, onKb),
      Keyboard.addListener('keyboardDidChangeFrame' as any, onKb),
      Keyboard.addListener(hideEv, () => setTop(null)),
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
    const t = setTimeout(measure, 120); // the tab bar hides / shows after the keyboard event: measure again
    return () => clearTimeout(t);
  }, [top, measure]);
  return (
    <View ref={ref} onLayout={measure} style={[{ flex: 1 }, style, { paddingBottom: keyboardPad(bottom, top) }]}>
      {children}
    </View>
  );
}
