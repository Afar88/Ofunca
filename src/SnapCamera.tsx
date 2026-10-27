import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { CameraView } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

export type SnapResult = { uri: string } | null;

type Shot = { uri: string; w: number; h: number };
type Box = { x: number; y: number; w: number; h: number };
const MIN = 60;

/**
 * Ofunca's own camera. It runs inside the app, so Android never has to close Ofunca to make
 * room for a separate camera app, and the photo can't get lost on the way back.
 */
export default function SnapCamera({ visible, accent, onDone }: { visible: boolean; accent: string; onDone: (r: SnapResult) => void }) {
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [shooting, setShooting] = useState(false);
  const [shot, setShotRaw] = useState<Shot | null>(null);
  const [area, setArea] = useState({ w: 0, h: 0 });
  const [box, setBox] = useState<Box | null>(null);
  const boxRef = useRef<Box | null>(null);
  const start = useRef<Box | null>(null);
  const [working, setWorking] = useState(false);

  /** Where the photo sits on screen (it's letterboxed to fit). */
  const fit = useMemo(() => {
    if (!shot || !(area.w > 0) || !(area.h > 0) || !(shot.w > 0) || !(shot.h > 0)) return null;
    const k = Math.min(area.w / shot.w, area.h / shot.h);
    if (!isFinite(k) || k <= 0) return null;
    const w = shot.w * k, h = shot.h * k;
    return { k, w, h, x: (area.w - w) / 2, y: (area.h - h) / 2 };
  }, [shot, area]);

  function putBox(b: Box | null) {
    boxRef.current = b;
    setBox(b);
  }
  function setShot(u: string | null) {
    putBox(null);
    setReady(false);
    if (!u) return setShotRaw(null);
    Image.getSize(u, (w, h) => setShotRaw({ uri: u, w: w > 0 ? w : 1000, h: h > 0 ? h : 1400 }), () => setShotRaw({ uri: u, w: 1000, h: 1400 }));
  }
  // Start with a box just inside the photo's edges.
  useEffect(() => {
    if (!fit) return;
    const m = Math.min(fit.w, fit.h) * 0.06;
    putBox({ x: m, y: m, w: fit.w - 2 * m, h: fit.h - 2 * m });
  }, [fit]);

  /** One drag handler per corner (and one for moving the whole box). */
  const handles = useMemo(() => {
    const make = (kind: 'tl' | 'tr' | 'bl' | 'br' | 'move') =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => (start.current = boxRef.current),
        onPanResponderMove: (_e, g) => {
          const b0 = start.current;
          const f = fitRef.current;
          if (!b0 || !f) return;
          let { x, y, w, h } = b0;
          const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
          if (kind === 'move') {
            x = clamp(b0.x + g.dx, 0, f.w - w);
            y = clamp(b0.y + g.dy, 0, f.h - h);
          } else {
            if (kind === 'tl' || kind === 'bl') { const nx = clamp(b0.x + g.dx, 0, b0.x + b0.w - MIN); w = b0.w + (b0.x - nx); x = nx; }
            else w = clamp(b0.w + g.dx, MIN, f.w - b0.x);
            if (kind === 'tl' || kind === 'tr') { const ny = clamp(b0.y + g.dy, 0, b0.y + b0.h - MIN); h = b0.h + (b0.y - ny); y = ny; }
            else h = clamp(b0.h + g.dy, MIN, f.h - b0.y);
          }
          putBox({ x, y, w, h });
        },
      });
    return { tl: make('tl'), tr: make('tr'), bl: make('bl'), br: make('br'), move: make('move') };
  }, []);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  async function pickGallery() {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
      if (!r.canceled && r.assets?.length) setShot(r.assets[0].uri);
    } catch {} // gallery closed or unavailable: stay on the camera
  }

  async function useCropped() {
    if (!shot) return;
    const b = boxRef.current;
    if (!b || !fit) return finish({ uri: shot.uri });
    setWorking(true);
    try {
      // Keep the crop inside the photo and at least 1 px, so rounding can never ask for an impossible size.
      const originX = Math.min(Math.max(0, Math.round(b.x / fit.k)), shot.w - 1);
      const originY = Math.min(Math.max(0, Math.round(b.y / fit.k)), shot.h - 1);
      const crop = {
        originX,
        originY,
        width: Math.max(1, Math.min(shot.w - originX, Math.round(b.w / fit.k))),
        height: Math.max(1, Math.min(shot.h - originY, Math.round(b.h / fit.k))),
      };
      const bad = ![crop.originX, crop.originY, crop.width, crop.height].every((n) => isFinite(n));
      const full = bad || (crop.width >= shot.w * 0.97 && crop.height >= shot.h * 0.97);
      const out = full ? shot : await ImageManipulator.manipulateAsync(shot.uri, [{ crop }], { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
      finish({ uri: out.uri });
    } catch {
      finish({ uri: shot.uri });
    } finally {
      setWorking(false);
    }
  }

  function finish(r: SnapResult) {
    setShot(null);
    setReady(false);
    setTorch(false);
    setShooting(false);
    onDone(r);
  }

  async function capture() {
    if (!cam.current || !ready || shooting) return;
    setShooting(true);
    try {
      const p = await cam.current.takePictureAsync({ quality: 0.7, exif: false, shutterSound: false });
      if (p?.uri) setShot(p.uri);
    } catch {
      // camera busy or closed mid-shot: just let the user tap the shutter again
    } finally {
      setShooting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => (shot ? setShot(null) : finish(null))} statusBarTranslucent>
      <View style={st.root}>
        {shot ? null : (
          visible && (
            <CameraView
              ref={cam}
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch={torch}
              animateShutter
              onCameraReady={() => setReady(true)}
            />
          )
        )}

        <SafeAreaView style={st.overlay} edges={['top', 'bottom']}>
          <View style={st.top}>
            <Pressable style={st.round} onPress={() => (shot ? setShot(null) : finish(null))} hitSlop={10} accessibilityLabel="Close">
              <Ionicons name={shot ? 'arrow-back' : 'close'} size={24} color="#fff" />
            </Pressable>
            <Text style={st.title}>{shot ? 'Crop to your notes' : 'Snap a page'}</Text>
            {shot ? (
              <View style={{ width: 44 }} />
            ) : (
              <Pressable style={[st.round, torch && { backgroundColor: '#fff' }]} onPress={() => setTorch((t) => !t)} hitSlop={10} accessibilityLabel="Flash">
                <Ionicons name={torch ? 'flash' : 'flash-outline'} size={22} color={torch ? '#111' : '#fff'} />
              </Pressable>
            )}
          </View>

          {shot && (
            <View style={st.cropArea} onLayout={(e) => setArea({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
              {fit && (
                <View style={{ position: 'absolute', left: fit.x, top: fit.y, width: fit.w, height: fit.h }}>
                  <Image source={{ uri: shot.uri }} style={StyleSheet.absoluteFill} resizeMode="stretch" />
                  {box && (
                    <>
                      <View pointerEvents="none" style={[st.shade, { left: 0, top: 0, right: 0, height: box.y }]} />
                      <View pointerEvents="none" style={[st.shade, { left: 0, top: box.y + box.h, right: 0, bottom: 0 }]} />
                      <View pointerEvents="none" style={[st.shade, { left: 0, top: box.y, width: box.x, height: box.h }]} />
                      <View pointerEvents="none" style={[st.shade, { left: box.x + box.w, top: box.y, right: 0, height: box.h }]} />
                      <View {...handles.move.panHandlers} style={[st.cropBox, { left: box.x, top: box.y, width: box.w, height: box.h, borderColor: accent }]}>
                        <View pointerEvents="none" style={[st.grid, { left: '33.3%', top: 0, bottom: 0, width: 1 }]} />
                        <View pointerEvents="none" style={[st.grid, { left: '66.6%', top: 0, bottom: 0, width: 1 }]} />
                        <View pointerEvents="none" style={[st.grid, { top: '33.3%', left: 0, right: 0, height: 1 }]} />
                        <View pointerEvents="none" style={[st.grid, { top: '66.6%', left: 0, right: 0, height: 1 }]} />
                      </View>
                      {(['tl', 'tr', 'bl', 'br'] as const).map((k) => (
                        <View
                          key={k}
                          {...handles[k].panHandlers}
                          style={[st.knob, { borderColor: accent, left: (k[1] === 'l' ? box.x : box.x + box.w) - 14, top: (k[0] === 't' ? box.y : box.y + box.h) - 14 }]}
                        />
                      ))}
                    </>
                  )}
                </View>
              )}
            </View>
          )}

          {!shot && (
            <View style={st.frameWrap} pointerEvents="none">
              <View style={st.frame}>
                <View style={[st.corner, { top: 0, left: 0, borderTopWidth: 4, borderLeftWidth: 4, borderColor: accent }]} />
                <View style={[st.corner, { top: 0, right: 0, borderTopWidth: 4, borderRightWidth: 4, borderColor: accent }]} />
                <View style={[st.corner, { bottom: 0, left: 0, borderBottomWidth: 4, borderLeftWidth: 4, borderColor: accent }]} />
                <View style={[st.corner, { bottom: 0, right: 0, borderBottomWidth: 4, borderRightWidth: 4, borderColor: accent }]} />
              </View>
              <Text style={st.hint}>Fit one page in the frame</Text>
            </View>
          )}

          {shot ? (
            <View style={st.bottomPair}>
              <Pressable style={[st.pill, st.pillGhost]} onPress={() => setShot(null)}>
                <Ionicons name="refresh" size={20} color="#fff" />
                <Text style={st.pillText}>Retake</Text>
              </Pressable>
              <Pressable style={[st.pill, { backgroundColor: accent }, working && { opacity: 0.6 }]} onPress={useCropped} disabled={working}>
                {working ? <ActivityIndicator color="#fff" /> : <Ionicons name="checkmark" size={22} color="#fff" />}
                <Text style={st.pillText}>Read it</Text>
              </Pressable>
            </View>
          ) : (
            <View style={st.bottom}>
              <Pressable style={st.side} onPress={pickGallery} accessibilityLabel="Choose from gallery">
                <Ionicons name="images-outline" size={26} color="#fff" />
                <Text style={st.sideText}>Gallery</Text>
              </Pressable>
              <Pressable style={[st.shutter, (!ready || shooting) && { opacity: 0.5 }]} onPress={capture} accessibilityLabel="Take photo">
                {shooting ? <ActivityIndicator color="#111" /> : <View style={st.shutterInner} />}
              </Pressable>
              <View style={st.side} />
            </View>
          )}
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  cropArea: { flex: 1, marginVertical: 16, marginHorizontal: 16 },
  shade: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.55)' },
  cropBox: { position: 'absolute', borderWidth: 2 },
  grid: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.35)' },
  knob: { position: 'absolute', width: 28, height: 28, borderRadius: 14, backgroundColor: '#fff', borderWidth: 3 },
  overlay: { flex: 1, justifyContent: 'space-between' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8 },
  title: { color: '#fff', fontSize: 17, fontWeight: '800', letterSpacing: 0.3 },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  frameWrap: { alignItems: 'center' },
  frame: { width: '82%', aspectRatio: 0.72 },
  corner: { position: 'absolute', width: 34, height: 34, borderRadius: 6 },
  hint: { color: '#fff', marginTop: 14, fontSize: 14, fontWeight: '600', backgroundColor: 'rgba(0,0,0,0.45)', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14, overflow: 'hidden' },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 32, paddingBottom: 24 },
  side: { width: 64, alignItems: 'center' },
  sideText: { color: '#fff', fontSize: 12, marginTop: 4, fontWeight: '600' },
  shutter: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#fff' },
  bottomPair: { flexDirection: 'row', gap: 14, paddingHorizontal: 20, paddingBottom: 24 },
  pill: { flex: 1, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', height: 54, borderRadius: 27 },
  pillGhost: { backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' },
  pillText: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
