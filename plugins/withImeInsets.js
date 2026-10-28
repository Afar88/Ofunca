// Local Expo config plugin: reports the keyboard's REAL height to JS on every change.
//
// React Native only sends keyboardDidShow when the keyboard opens or closes, not when its height changes
// afterwards (e.g. the suggestion / clipboard strip appearing above the keys on a Redmi), and with
// edge-to-edge the window is not resized for it. So MainActivity listens to the IME window insets (and,
// as a backup, every global layout) and emits "ofuncaImeChange" { height, windowHeight } in dp whenever
// the IME inset changes. src/keyboard.tsx uses it to keep the Ask bar fully above the keyboard.
const { withMainActivity } = require('@expo/config-plugins');

const MARK = '// ofunca-ime-insets';

const MEMBERS = `
  ${MARK}
  private var ofuncaLastIme = -1
  private var ofuncaPendingIme = -1

  private fun ofuncaReportIme(imePx: Int) {
    if (imePx == ofuncaLastIme && ofuncaPendingIme < 0) return
    try {
      val ctx = getReactHost()?.currentReactContext
      val decor = window?.decorView
      if (ctx == null || decor == null) {
        ofuncaPendingIme = imePx
        return
      }
      val d = resources.displayMetrics.density.toDouble()
      val map = com.facebook.react.bridge.Arguments.createMap()
      map.putDouble("height", imePx / d)
      map.putDouble("windowHeight", decor.height / d)
      ctx.emitDeviceEvent("ofuncaImeChange", map)
      ofuncaLastIme = imePx
      ofuncaPendingIme = -1
    } catch (e: Throwable) {
    }
  }

  private fun ofuncaImeFrom(insets: androidx.core.view.WindowInsetsCompat?): Int {
    if (insets == null) return 0
    val type = androidx.core.view.WindowInsetsCompat.Type.ime()
    return if (insets.isVisible(type)) insets.getInsets(type).bottom else 0
  }

  private fun ofuncaInstallImeListener() {
    try {
      val content = findViewById<android.view.View>(android.R.id.content) ?: return
      androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
        ofuncaReportIme(ofuncaImeFrom(insets))
        androidx.core.view.ViewCompat.onApplyWindowInsets(v, insets)
      }
      window?.decorView?.viewTreeObserver?.addOnGlobalLayoutListener {
        val decor = window?.decorView
        if (decor != null) ofuncaReportIme(ofuncaImeFrom(androidx.core.view.ViewCompat.getRootWindowInsets(decor)))
      }
    } catch (e: Throwable) {
    }
  }
`;

module.exports = function withImeInsets(config) {
  return withMainActivity(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (cfg.modResults.language !== 'kt') throw new Error('withImeInsets: expected a Kotlin MainActivity');
    if (src.includes(MARK)) return cfg;
    // Install right after super.onCreate(...)
    const re = /(super\.onCreate\([^)]*\);?)/;
    if (!re.test(src)) throw new Error('withImeInsets: super.onCreate not found in MainActivity');
    src = src.replace(re, '$1\n    ofuncaInstallImeListener()');
    // Add the members just before the class's final closing brace.
    const end = src.lastIndexOf('}');
    src = src.slice(0, end) + MEMBERS + '}\n';
    cfg.modResults.contents = src;
    return cfg;
  });
};
