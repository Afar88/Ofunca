const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
// Bundle the QVAC OCR model files (.gguf) inside the app so Snap notes needs no download.
config.resolver.assetExts.push('gguf');
module.exports = config;
