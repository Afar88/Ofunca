// Candy pop intro: the Ofunca O bursts out, does a little wiggle dance, sparkles fly, then the name drops in.
// Plays over whatever is loading underneath (about 1.8 s), so it never adds waiting. Tap to skip.
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View } from 'react-native';

const SPARKS = ['✨', '⭐', '💖', '✨', '🍬', '⭐', '✨', '💜'];

export function Intro({ onDone }: { onDone: () => void }) {
  const scale = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;
  const title = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    Animated.timing(fade, { toValue: 0, duration: 260, useNativeDriver: true }).start(() => onDone());
  };

  useEffect(() => {
    const wiggle = (to: number, d = 90) =>
      Animated.timing(spin, { toValue: to, duration: d, easing: Easing.inOut(Easing.quad), useNativeDriver: true });
    Animated.sequence([
      Animated.spring(scale, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }),
      Animated.parallel([
        Animated.timing(burst, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.sequence([wiggle(-1), wiggle(1), wiggle(-1), wiggle(1), wiggle(0, 120)]),
        Animated.spring(title, { toValue: 1, friction: 5, delay: 200, useNativeDriver: true }),
      ]),
      Animated.delay(350),
    ]).start(() => finish());
    const t = setTimeout(finish, 3000); // safety net
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rotate = spin.interpolate({ inputRange: [-1, 1], outputRange: ['-12deg', '12deg'] });
  const hop = spin.interpolate({ inputRange: [-1, 0, 1], outputRange: [-10, 0, -10] });

  return (
    <Animated.View style={[st.wrap, { opacity: fade }]}>
      <Pressable style={st.fill} onPress={finish}>
        <View style={st.center}>
          {SPARKS.map((sp, i) => {
            const a = (i / SPARKS.length) * Math.PI * 2;
            const dist = 130 + (i % 2) * 30;
            return (
              <Animated.Text
                key={i}
                style={[
                  st.spark,
                  {
                    opacity: burst.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
                    transform: [
                      { translateX: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(a) * dist] }) },
                      { translateY: burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(a) * dist] }) },
                      { scale: burst.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.3, 1.3, 0.8] }) },
                    ],
                  },
                ]}
              >
                {sp}
              </Animated.Text>
            );
          })}
          <Animated.View style={{ transform: [{ translateY: hop }, { scale }, { rotate }] }}>
            <Image source={require('../assets/splash-icon.png')} style={st.mark} resizeMode="contain" />
          </Animated.View>
        </View>
        <Animated.View
          style={{
            alignItems: 'center',
            opacity: title,
            transform: [{ translateY: title.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) }],
          }}
        >
          <Text style={st.name}>Ofunca</Text>
          <Text style={st.tag}>Your notes. Your tutor. No signal needed.</Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, backgroundColor: '#FFE9A8', zIndex: 999, elevation: 999 },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { width: 260, height: 260, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 240, height: 240 },
  spark: { position: 'absolute', fontSize: 28 },
  name: { fontSize: 44, fontWeight: '900', color: '#8B2CF5', letterSpacing: 1, marginTop: 8, textShadowColor: '#FF5FB0', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 0 },
  tag: { fontSize: 15, fontWeight: '700', color: '#9A4A00', marginTop: 6 },
});
