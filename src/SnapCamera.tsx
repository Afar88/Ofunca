import React, { useRef, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';

export type SnapResult = { uri: string } | 'gallery' | null;

/**
 * Ofunca's own camera. It runs inside the app, so Android never has to close Ofunca to make
 * room for a separate camera app, and the photo can't get lost on the way back.
 */
export default function SnapCamera({ visible, accent, onDone }: { visible: boolean; accent: string; onDone: (r: SnapResult) => void }) {
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [torch, setTorch] = useState(false);
  const [shooting, setShooting] = useState(false);
  const [shot, setShot] = useState<string | null>(null);

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
    } finally {
      setShooting(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={() => (shot ? setShot(null) : finish(null))} statusBarTranslucent>
      <View style={st.root}>
        {shot ? (
          <Image source={{ uri: shot }} style={StyleSheet.absoluteFill} resizeMode="contain" />
        ) : (
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
            <Text style={st.title}>{shot ? 'Looks sharp?' : 'Snap a page'}</Text>
            {shot ? (
              <View style={{ width: 44 }} />
            ) : (
              <Pressable style={[st.round, torch && { backgroundColor: '#fff' }]} onPress={() => setTorch((t) => !t)} hitSlop={10} accessibilityLabel="Flash">
                <Ionicons name={torch ? 'flash' : 'flash-outline'} size={22} color={torch ? '#111' : '#fff'} />
              </Pressable>
            )}
          </View>

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
              <Pressable style={[st.pill, { backgroundColor: accent }]} onPress={() => finish({ uri: shot })}>
                <Ionicons name="checkmark" size={22} color="#fff" />
                <Text style={st.pillText}>Read it</Text>
              </Pressable>
            </View>
          ) : (
            <View style={st.bottom}>
              <Pressable style={st.side} onPress={() => finish('gallery')} accessibilityLabel="Choose from gallery">
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
