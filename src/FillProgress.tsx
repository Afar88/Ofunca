// v1.0.17: "battery charging" progress inside a button. A lighter candy colour fills the button from left to
// right: real progress when it is known (PDF pages, indexing batches, photo-reading steps), otherwise a smooth
// estimate that creeps towards 92% and never claims to be done. A soft glow pulses on the filling edge.
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View, type LayoutChangeEvent } from 'react-native';

export type Fill = { p: number | null; label: string };

/** Absolute layer to put first inside a button (the button needs overflow: 'hidden' and position relative). */
export function FillLayer({ fill, color, glow = 'rgba(255,255,255,0.55)' }: { fill: Fill | null; color: string; glow?: string }) {
  const [w, setW] = useState(0);
  const v = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  const shown = useRef(0);
  const active = !!fill;
  const p = fill?.p;

  useEffect(() => {
    const id = v.addListener(({ value }) => (shown.current = value));
    return () => v.removeListener(id);
  }, [v]);

  useEffect(() => {
    if (!active) {
      v.stopAnimation();
      v.setValue(0);
      return;
    }
    v.stopAnimation();
    if (typeof p === 'number' && isFinite(p)) {
      const to = Math.max(shown.current, Math.min(1, Math.max(0, p))); // never runs backwards
      Animated.timing(v, { toValue: to, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
    } else {
      // unknown length: ease towards 92% over a long time (fast at first, then slower and slower)
      const left = 0.92 - shown.current;
      if (left > 0.01) Animated.timing(v, { toValue: 0.92, duration: 9000 + 30000 * (1 - left), easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    }
  }, [active, p, v]);

  useEffect(() => {
    if (!active) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
        Animated.timing(pulse, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.sin), useNativeDriver: false }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, pulse]);

  if (!active) return <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)} />;
  const width = v.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(1, w)] });
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" onLayout={(e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width)}>
      <Animated.View style={[st.fill, { width, backgroundColor: color }]}>
        <View style={st.shine} />
        <Animated.View style={[st.edge, { backgroundColor: glow, opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0.9] }) }]} />
      </Animated.View>
    </View>
  );
}

const st = StyleSheet.create({
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  shine: { position: 'absolute', left: 0, right: 0, top: 0, height: '42%', backgroundColor: 'rgba(255,255,255,0.28)' },
  edge: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 10, borderTopRightRadius: 6, borderBottomRightRadius: 6 },
});

/** Progress of a job made of steps: maps a step's own 0..1 into its slice of the whole bar. */
export const slice = (from: number, to: number, x: number) => from + (to - from) * Math.max(0, Math.min(1, x));
