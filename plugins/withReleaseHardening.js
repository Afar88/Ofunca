// Local Expo config plugin: keeps the release APK clean for sideloading.
//  - release build is produced UNSIGNED by Gradle; it is signed afterwards with
//    apksigner (v2 + v3) using a private keystore that never enters the repo
//  - release is never debuggable; cleartext HTTP disabled
const { withAppBuildGradle, withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withReleaseHardening(config) {
  config = withAppBuildGradle(config, (cfg) => {
    let g = cfg.modResults.contents;
    // Expo's template signs release with the debug key; remove that so we sign properly later.
    g = g.replace(/(release\s*\{[^{}]*?)signingConfig\s+signingConfigs\.debug\s*\n/, '$1');
    if (!/debuggable false/.test(g)) {
      g = g.replace(/(buildTypes\s*\{[\s\S]*?release\s*\{)/, '$1\n            debuggable false');
    }
    cfg.modResults.contents = g;
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:usesCleartextTraffic'] = 'false';
      app.$['android:allowBackup'] = 'false';
    }
    return cfg;
  });
  return config;
};
