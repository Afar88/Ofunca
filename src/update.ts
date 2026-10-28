// Tells people on an older Ofunca build that a new one is out. Runs only when the phone is online,
// at most once a day, and never blocks the app. It reads the latest GitHub release of the public repo.
import { Alert, Linking } from 'react-native';
import * as FS from 'expo-file-system/legacy';

const REPO = 'Afar88/Ofunca';
const CURRENT: string = require('../app.json').expo.version;
const STAMP = (FS.documentDirectory ?? '') + 'ofunca-update-check.json';

function newer(a: string, b: string) {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

export async function checkForUpdate(manual = false) {
  try {
    let last: { at?: number; skip?: string } = {};
    try {
      last = JSON.parse(await FS.readAsStringAsync(STAMP));
    } catch {}
    if (!manual && last.at && Date.now() - last.at < 20 * 60 * 60 * 1000) return;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: ctl.signal,
    });
    clearTimeout(t);
    if (r.status === 404) {
      // no release published yet: nothing newer than this build
      await FS.writeAsStringAsync(STAMP, JSON.stringify({ ...last, at: Date.now() })).catch(() => {});
      if (manual) Alert.alert('You are up to date ✅', `Ofunca ${CURRENT} is the newest version.`);
      return;
    }
    if (!r.ok) {
      // rate-limited or GitHub trouble: don't wait a whole day before trying again
      if (manual) Alert.alert('Could not check', r.status === 403 || r.status === 429 ? 'GitHub is busy right now. Try again in a little while.' : 'Connect to the internet and try again.');
      return;
    }
    await FS.writeAsStringAsync(STAMP, JSON.stringify({ ...last, at: Date.now() })).catch(() => {});
    const rel: any = await r.json();
    const tag = String(rel?.tag_name ?? '');
    if (!tag || !newer(tag, CURRENT) || (!manual && last.skip === tag)) {
      if (manual) Alert.alert('You are up to date ✅', `Ofunca ${CURRENT} is the newest version.`);
      return;
    }
    const apk = (rel.assets ?? []).find((a: any) => String(a?.name ?? '').endsWith('.apk'));
    const url: string = apk?.browser_download_url ?? rel.html_url ?? `https://github.com/${REPO}/releases`;
    Alert.alert(
      'New Ofunca update 🎉',
      `Version ${tag.replace(/^v/i, '')} is out (you have ${CURRENT}). Download it, then install it over this one. Your notes stay.`,
      [
        { text: 'Skip this version', style: 'cancel', onPress: () => { FS.writeAsStringAsync(STAMP, JSON.stringify({ at: Date.now(), skip: tag })).catch(() => {}); } },
        { text: 'Later' },
        { text: 'Download', onPress: () => Linking.openURL(url).catch(() => {}) },
      ],
    );
  } catch {
    if (manual) Alert.alert('Could not check', 'Connect to the internet and try again.');
    // offline or GitHub unreachable: try again next launch
  }
}
