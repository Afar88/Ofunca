// Candy confetti rain for a perfect quiz score. Pointer events pass through; ends on its own.
import React, { useEffect, useRef } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';

const COLORS = ['#FF5FB0', '#8B2CF5', '#FFB23F', '#3DD68C', '#4FC3F7', '#FF6B86'];

export function Confetti({ onDone }: { onDone: () => void }) {
  const { width, height } = Dimensions.get('window');
  const t = useRef(new Animated.Value(0)).current;
  const pieces = useRef(
    Array.from({ length: 40 }, (_, i) => ({
      x: Math.random() * width,
      drift: (Math.random() - 0.5) * 120,
      delay: Math.random() * 0.35,
      size: 8 + Math.random() * 8,
      color: COLORS[i % COLORS.length],
      spin: (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 540),
      round: i % 3 === 0,
    })),
  ).current;

  useEffect(() => {
    Animated.timing(t, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: true }).start(() => onDone());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {pieces.map((p, i) => {
        const start = p.delay;
        const y = t.interpolate({ inputRange: [0, start, 1], outputRange: [-40, -40, height + 40] });
        const x = t.interpolate({ inputRange: [0, 1], outputRange: [p.x, p.x + p.drift] });
        const r = t.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${p.spin}deg`] });
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              width: p.size,
              height: p.round ? p.size : p.size * 1.6,
              borderRadius: p.round ? p.size / 2 : 2,
              backgroundColor: p.color,
              transform: [{ translateX: x }, { translateY: y }, { rotate: r }],
            }}
          />
        );
      })}
      <Animated.View
        style={[
          st.banner,
          {
            opacity: t.interpolate({ inputRange: [0, 0.1, 0.8, 1], outputRange: [0, 1, 1, 0] }),
            transform: [{ scale: t.interpolate({ inputRange: [0, 0.12, 0.2, 1], outputRange: [0.4, 1.15, 1, 1] }) }],
          },
        ]}
      >
        <Text style={st.big}>🎉 Perfect score! 🎉</Text>
        <Text style={st.small}>You know your notes!</Text>
      </Animated.View>
    </View>
  );
}

const st = StyleSheet.create({
  banner: { position: 'absolute', top: '38%', alignSelf: 'center', backgroundColor: '#8B2CF5', paddingHorizontal: 24, paddingVertical: 14, borderRadius: 24, borderBottomWidth: 5, borderBottomColor: '#6D1FC9', alignItems: 'center' },
  big: { color: '#fff', fontSize: 24, fontWeight: '900' },
  small: { color: '#FFE9A8', fontSize: 14, fontWeight: '700', marginTop: 4 },
});
