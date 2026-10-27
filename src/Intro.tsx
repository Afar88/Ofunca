// Intro: the Ofunca O pops in bare, then its graduation hat streaks in from the top corner like a shooting
// star, loops around the O, swells as it climbs, and drops onto the O with a bounce. Then the
// letters of "Ofunca" fall in one by one and the tagline fades up. Plays over loading. Tap to skip.
// Full show on first launch and after updates; a quick version on every other launch.
import React, { useEffect, useRef } from 'react';
import * as FS from 'expo-file-system/legacy';
import { Animated, Dimensions, Easing, Image, Pressable, StyleSheet, Text, View } from 'react-native';

const PINK = '#FF3D8B';
const TRAIL = 5;
const LETTERS = 'Ofunca'.split('');
// The full show plays on first launch and after each update; other launches get a quick ~1.5 s version.
const SEEN = (FS.documentDirectory ?? '') + 'ofunca-intro-seen.json';
const VERSION: string = require('../app.json').expo.version;
export const TAGLINE = 'Study. Anywhere. No connection.';
// The hat as cut from the logo (346×278 of 1024), shown at the logo's 240 px scale.
const HAT_W = 81;
const HAT_H = 65;

export function Intro({ onDone }: { onDone: () => void }) {
  const { width: W, height: H } = Dimensions.get('window');
  // Starts at full size so it carries straight on from the launch screen's O (no blank gap).
  const scale = useRef(new Animated.Value(1)).current;
  const flight = useRef(new Animated.Value(0)).current;
  const trail = useRef(Array.from({ length: TRAIL }, () => new Animated.Value(0))).current;
  const land = useRef(new Animated.Value(0)).current; // 0 → 1 as the hat drops and settles
  const glow = useRef(new Animated.Value(0)).current;
  const drops = useRef(LETTERS.map(() => new Animated.Value(0))).current;
  const tag = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(1)).current;
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    Animated.timing(fade, { toValue: 0, duration: 260, useNativeDriver: true }).start(() => onDone());
  };

  // Flight path, relative to the centre of the O: top-right corner → sweep down the left → loop
  // under and round the right → climb high above the O (biggest here) → hover over the landing spot.
  const LAND = { x: 21, y: -39 }; // where the hat sits on the full logo
  const P = [0, 0.18, 0.36, 0.52, 0.68, 0.84, 1];
  const X = [W / 2 + 40, 60, -150, -40, 150, 40, LAND.x];
  const Y = [-H / 2 - 40, -190, -10, 160, 40, -190, LAND.y - 70];
  const S = [0.25, 0.35, 0.45, 0.55, 0.75, 1.5, 1.25];
  const pathX = (v: Animated.Value) => v.interpolate({ inputRange: P, outputRange: X });
  const pathY = (v: Animated.Value) => v.interpolate({ inputRange: P, outputRange: Y });

  useEffect(() => {
    let alive = true;
    (async () => {
      let full = true;
      try {
        const seen = JSON.parse(await FS.readAsStringAsync(SEEN));
        full = seen?.version !== VERSION;
      } catch {}
      FS.writeAsStringAsync(SEEN, JSON.stringify({ version: VERSION })).catch(() => {});
      if (!alive) return;
      if (full) playFull();
      else playShort();
    })();
    const t = setTimeout(finish, 7000); // safety net
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Quick version: the hat drops straight onto the O, the name and tagline rise in, a short hold.
  const playShort = () => {
    flight.setValue(1);
    trail.forEach((t) => t.setValue(1));
    Animated.sequence([
      Animated.parallel([
        Animated.spring(land, { toValue: 1, friction: 5, tension: 160, useNativeDriver: true }),
        Animated.timing(glow, { toValue: 1, duration: 420, delay: 100, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.stagger(35, drops.map((d) => Animated.spring(d, { toValue: 1, friction: 6, tension: 170, useNativeDriver: true }))),
        Animated.timing(tag, { toValue: 1, duration: 300, delay: 200, useNativeDriver: true }),
      ]),
      Animated.delay(550),
    ]).start(() => finish());
  };

  const playFull = () => {
    const FLY = 1500;
    const fly = (v: Animated.Value, delay = 0) =>
      Animated.timing(v, { toValue: 1, duration: FLY, delay, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    Animated.sequence([
      Animated.timing(scale, { toValue: 0.86, duration: 130, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 3.5, tension: 160, useNativeDriver: true }),
      Animated.parallel([fly(flight), ...trail.map((t, i) => fly(t, (i + 1) * 45))]),
      // Drop onto the O, and the O gives a little squash as it catches the hat.
      Animated.parallel([
        Animated.spring(land, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }),
        Animated.sequence([
          Animated.delay(120),
          Animated.timing(scale, { toValue: 0.93, duration: 90, useNativeDriver: true }),
          Animated.spring(scale, { toValue: 1, friction: 3, tension: 180, useNativeDriver: true }),
        ]),
        Animated.timing(glow, { toValue: 1, duration: 500, delay: 120, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]),
      Animated.stagger(
        80,
        drops.map((d) => Animated.spring(d, { toValue: 1, friction: 5, tension: 140, useNativeDriver: true })),
      ),
      Animated.timing(tag, { toValue: 1, duration: 380, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.delay(1100), // hold the finished logo so it can be enjoyed
    ]).start(() => finish());
  };

  // While flying the hat follows the path; once landing starts it drops the last 70 px.
  const hatY = Animated.add(pathY(flight), land.interpolate({ inputRange: [0, 1], outputRange: [0, 70] }));
  const hatScale = Animated.multiply(
    flight.interpolate({ inputRange: P, outputRange: S }),
    land.interpolate({ inputRange: [0, 1], outputRange: [1, 0.8] }),
  );
  const roll = flight.interpolate({ inputRange: [0, 1], outputRange: ['-360deg', '720deg'] });

  return (
    <Animated.View style={[st.wrap, { opacity: fade }]}>
      <Pressable style={st.fill} onPress={finish}>
        <View style={st.center}>
          <Animated.View style={{ transform: [{ scale }] }}>
            <Image source={require('../assets/intro-o.png')} style={st.mark} resizeMode="contain" fadeDuration={0} />
          </Animated.View>

          {/* Shooting-star tail: fading sparks that follow the hat's path a beat behind. */}
          {trail.map((t, i) => (
            <Animated.View
              key={i}
              pointerEvents="none"
              style={[
                st.spark,
                {
                  opacity: t.interpolate({ inputRange: [0, 0.05, 0.9, 1], outputRange: [0, 0.9 - i * 0.15, 0.6 - i * 0.1, 0] }),
                  transform: [
                    { translateX: pathX(t) },
                    { translateY: pathY(t) },
                    { scale: t.interpolate({ inputRange: P, outputRange: S.map((v) => v * (0.7 - i * 0.1)) }) },
                  ],
                },
              ]}
            />
          ))}

          {/* Soft ring that pulses out when the hat lands. */}
          <Animated.View
            pointerEvents="none"
            style={[
              st.ring,
              {
                opacity: glow.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 0.7, 0] }),
                transform: [{ translateX: LAND.x }, { translateY: LAND.y }, { scale: glow.interpolate({ inputRange: [0, 1], outputRange: [0.3, 2.4] }) }],
              },
            ]}
          />

          <Animated.View pointerEvents="none" style={[st.hat, { transform: [{ translateX: pathX(flight) }, { translateY: hatY }, { scale: hatScale }, { rotate: roll }] }]}>
            <Image source={require('../assets/intro-cap.png')} style={{ width: HAT_W, height: HAT_H }} resizeMode="contain" fadeDuration={0} />
          </Animated.View>
        </View>

        <View style={{ flexDirection: 'row', marginTop: 4 }}>
          {LETTERS.map((ch, i) => (
            <Animated.Text
              key={i}
              style={[
                st.name,
                {
                  opacity: drops[i],
                  transform: [
                    { translateY: drops[i].interpolate({ inputRange: [0, 1], outputRange: [-46, 0] }) },
                    { scale: drops[i].interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.4, 1.15, 1] }) },
                  ],
                },
              ]}
            >
              {ch}
            </Animated.Text>
          ))}
        </View>
        <Animated.Text style={[st.tag, { opacity: tag, transform: [{ translateY: tag.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}>
          {TAGLINE}
        </Animated.Text>
      </Pressable>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, backgroundColor: '#FFE9A8', zIndex: 999, elevation: 999 },
  fill: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  center: { width: 260, height: 260, alignItems: 'center', justifyContent: 'center' },
  mark: { width: 240, height: 240 },
  hat: { position: 'absolute', width: HAT_W, height: HAT_H, alignItems: 'center', justifyContent: 'center' },
  spark: { position: 'absolute', width: 18, height: 18, borderRadius: 9, backgroundColor: '#FFF6C9', borderWidth: 3, borderColor: '#FF8CC0' },
  ring: { position: 'absolute', width: 40, height: 40, borderRadius: 20, borderWidth: 3, borderColor: PINK },
  name: { fontSize: 44, fontWeight: '900', color: '#8B2CF5', letterSpacing: 1, textShadowColor: '#FF5FB0', textShadowOffset: { width: 0, height: 3 }, textShadowRadius: 0 },
  tag: { fontSize: 15, fontWeight: '700', color: '#9A4A00', marginTop: 8, letterSpacing: 0.3 },
});
